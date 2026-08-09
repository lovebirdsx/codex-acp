/*
 * Fork addition: replay the `request_user_input` question cards.
 *
 * Live, the app-server surfaces a request_user_input call as a form elicitation
 * and never materialises it as a thread item, so CodexElicitationHandler
 * re-emits the question and the answer as a tool_call/tool_call_update pair
 * (see RequestUserInputHistory). The typed history the resume paths read
 * (`thread/turns/list` + `thread/items/list`) has no trace of that pair either,
 * so without this module a resumed session loses every question it ever asked.
 *
 * Only the rollout JSONL keeps them, as the model's own
 * `function_call` / `function_call_output` pair. This module reads just those
 * pairs out of it — not the whole shell-parsing replay the fork used to have —
 * and places each card back into the typed stream by walking the rollout's
 * anchors: the ids the two stores share (a tool call's `call_id` is its typed
 * item id, a user message's `client_id` is its item's `clientId`, agent
 * messages share their text) in the order both stores list them.
 *
 * Failures are never fatal: a rollout that is missing, oversized or unreadable
 * costs the cards, not the session.
 *
 * The typed stream is not always the whole rollout: a rewind drops its newest
 * turns while the rollout keeps them, and a resume boundary starts it late. A
 * card whose turn never opened in the typed stream is therefore dropped at the
 * end of the history, and the cards that end before the first replayed item are
 * dropped when the window opens.
 */

import type { UpdateSessionEvent } from "./ACPSessionConnection";
import { logger } from "./Logger";
import { REPLAY_ROLLOUT_READ_CAP_BYTES, readFileWithinCap } from "./ReplayFileRead";
import { createUserInputAnswerUpdate, createUserInputToolCallEvent, type UserInputQuestion } from "./RequestUserInputHistory";
import type { Thread, ThreadItem } from "./app-server/v2";

type JsonRecord = Record<string, unknown>;

const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";

// Agent-message anchors share text, so the key is bounded: a long message must
// not be copied once per compare.
const ANCHOR_TEXT_LIMIT = 256;

export interface ReplayedUserInputCard {
    readonly toolCallId: string;
    readonly questions: UserInputQuestion[];
    /** The rollout's function_call_output, the same answers object the live path stored. */
    readonly output: unknown;
    /**
     * Index (into the rollout anchors) of the first anchor after this card. The
     * card belongs before the typed item that anchor maps to.
     */
    readonly anchorIndex: number;
    /**
     * The user message that opened the card's turn, or null when the rollout has
     * none. Used for the trailing flush: a rewind truncates the typed history
     * but not the rollout, so cards of dropped turns — whose own user message is
     * never replayed — must not be flushed at the end.
     */
    readonly turnAnchorKey: string | null;
}

interface Anchor {
    readonly key: string;
    readonly userMessage: boolean;
}

/**
 * The key a typed item shares with the rollout, or null when it cannot be
 * anchored. Tool item ids and user message client ids are the app-server's own
 * record of the rollout values; agent messages only share their text.
 */
export function historyAnchorKey(item: ThreadItem): string | null {
    switch (item.type) {
        case "userMessage":
            return item.clientId === null ? null : userAnchorKey(item.clientId);
        case "agentMessage":
            return item.text.length === 0 ? null : agentAnchorKey(item.text);
        case "functionCallOutput":
        case "commandExecution":
        case "fileChange":
        case "mcpToolCall":
        case "dynamicToolCall":
        case "collabAgentToolCall":
        case "webSearch":
        case "imageView":
        case "imageGeneration":
        case "contextCompaction":
            return callAnchorKey(item.id);
        default:
            return null;
    }
}

function userAnchorKey(clientId: string): string {
    return `user:${clientId}`;
}

function callAnchorKey(callId: string): string {
    return `call:${callId}`;
}

function agentAnchorKey(text: string): string {
    return `agent:${text.length}:${text.slice(0, ANCHOR_TEXT_LIMIT)}`;
}

/** The updates of one replayed card, identical to the pair the live path publishes. */
export function createReplayedUserInputUpdates(card: ReplayedUserInputCard): UpdateSessionEvent[] {
    const updates = [createUserInputToolCallEvent(card.toolCallId, card.questions)];
    const answer = createUserInputAnswerUpdate(card.toolCallId, card.questions, card.output);
    if (answer !== null) {
        updates.push(answer);
    }
    return updates;
}

export class RequestUserInputReplay {
    private readonly remaining: ReplayedUserInputCard[];
    private readonly matchedAnchors = new Set<string>();
    private cursor = 0;
    private matchedUserAnchor = false;
    private sawItem = false;
    private windowStart: number | null = null;

    constructor(
        cards: ReplayedUserInputCard[],
        private readonly anchors: readonly Anchor[],
        private readonly occurrences: ReadonlyMap<string, readonly number[]>,
    ) {
        this.remaining = [...cards];
    }

    static empty(): RequestUserInputReplay {
        return new RequestUserInputReplay([], [], new Map());
    }

    get isEmpty(): boolean {
        return this.remaining.length === 0;
    }

    /** The cards to replay before the typed item that carries `anchorKey`. */
    takeBefore(anchorKey: string | null): ReplayedUserInputCard[] {
        this.sawItem = true;
        const index = anchorKey === null ? undefined : this.nextOccurrence(anchorKey);
        if (anchorKey === null || index === undefined) return [];
        if (this.windowStart === null) {
            // The first replayed item opens the window. Everything before it is
            // what the resume boundary left out, so its cards were already
            // replayed by whoever read that part of the history.
            this.windowStart = index;
            this.take(card => card.anchorIndex < index);
        }
        this.cursor = index + 1;
        this.matchedAnchors.add(anchorKey);
        this.matchedUserAnchor ||= this.anchors[index]!.userMessage;
        return this.take(card => card.anchorIndex <= index);
    }

    /**
     * The cards left once the typed history ended. A card of a turn whose user
     * message was never replayed belongs to the rollout tail a rewind dropped,
     * so it is skipped; when the typed stream carried no user message anchor at
     * all (older rollouts have no client id), keep them all.
     */
    takeRemaining(): ReplayedUserInputCard[] {
        if (!this.sawItem) return [];
        return this.take(card => card.turnAnchorKey === null
            || !this.matchedUserAnchor
            || this.matchedAnchors.has(card.turnAnchorKey));
    }

    private nextOccurrence(key: string): number | undefined {
        return this.occurrences.get(key)?.find(index => index >= this.cursor);
    }

    private take(included: (card: ReplayedUserInputCard) => boolean): ReplayedUserInputCard[] {
        const taken: ReplayedUserInputCard[] = [];
        while (this.remaining.length > 0 && included(this.remaining[0]!)) {
            taken.push(this.remaining.shift()!);
        }
        return taken;
    }
}

/** Read the replayed cards of a thread's rollout; never throws. */
export async function readRequestUserInputReplay(thread: Thread): Promise<RequestUserInputReplay> {
    if (thread.path === null) {
        return RequestUserInputReplay.empty();
    }
    try {
        const contents = await readFileWithinCap(thread.path, REPLAY_ROLLOUT_READ_CAP_BYTES, (size) => {
            logger.log(`replay: skipping request_user_input history of ${thread.path} (${size} bytes exceeds the read cap)`);
        });
        return contents === null ? RequestUserInputReplay.empty() : parseRequestUserInputReplay(contents);
    } catch (error) {
        logger.error(`Failed to read request_user_input history from ${thread.path}`, error);
        return RequestUserInputReplay.empty();
    }
}

export function parseRequestUserInputReplay(contents: string): RequestUserInputReplay {
    const anchors: Anchor[] = [];
    const occurrences = new Map<string, number[]>();
    const cards: ReplayedUserInputCard[] = [];
    const open = new Map<string, Omit<ReplayedUserInputCard, "output">>();
    let turnAnchorKey: string | null = null;

    const addAnchor = (key: string, userMessage: boolean) => {
        const index = anchors.length;
        anchors.push({key: key, userMessage: userMessage});
        const indexes = occurrences.get(key);
        if (indexes === undefined) occurrences.set(key, [index]);
        else indexes.push(index);
    };

    for (const line of contents.split(/\r?\n/)) {
        const record = parseJsonRecord(line);
        if (record === null) continue;
        if (record["type"] === "event_msg") {
            const payload = asRecord(record["payload"]);
            if (payload !== null && payload["type"] === "user_message") {
                const clientId = stringValue(payload["client_id"]);
                if (clientId !== null) {
                    turnAnchorKey = userAnchorKey(clientId);
                    addAnchor(turnAnchorKey, true);
                }
            }
            continue;
        }
        const item = record["type"] === "response_item" ? asRecord(record["payload"]) : record;
        if (item === null) continue;
        switch (item["type"]) {
            case "function_call": {
                const callId = stringValue(item["call_id"]);
                if (callId === null) break;
                if (stringValue(item["name"]) === REQUEST_USER_INPUT_TOOL_NAME) {
                    const questions = userInputQuestionsFromArguments(item["arguments"]);
                    if (questions.length > 0) {
                        open.set(callId, {
                            toolCallId: callId,
                            questions: questions,
                            anchorIndex: anchors.length,
                            turnAnchorKey: turnAnchorKey,
                        });
                    }
                    break;
                }
                addAnchor(callAnchorKey(callId), false);
                break;
            }
            case "custom_tool_call": {
                const callId = stringValue(item["call_id"]);
                if (callId !== null) addAnchor(callAnchorKey(callId), false);
                break;
            }
            case "function_call_output": {
                const callId = stringValue(item["call_id"]);
                if (callId === null) break;
                const card = open.get(callId);
                if (card === undefined) break;
                open.delete(callId);
                cards.push({...card, output: item["output"]});
                break;
            }
            case "message": {
                const text = assistantMessageText(item);
                if (text !== null) addAnchor(agentAnchorKey(text), false);
                break;
            }
            default:
                break;
        }
    }

    return new RequestUserInputReplay(cards, anchors, occurrences);
}

function assistantMessageText(item: JsonRecord): string | null {
    if (item["role"] !== "assistant" || !Array.isArray(item["content"])) {
        return null;
    }
    const text = item["content"].flatMap((part): string[] => {
        const record = asRecord(part);
        const value = record === null ? null : stringValue(record["text"]);
        return record !== null && record["type"] === "output_text" && value !== null ? [value] : [];
    }).join("");
    return text.length === 0 ? null : text;
}

function userInputQuestionsFromArguments(value: unknown): UserInputQuestion[] {
    const args = asRecord(parseFunctionArguments(value));
    const list = args !== null && Array.isArray(args["questions"]) ? args["questions"] : [];
    return list.flatMap((entry): UserInputQuestion[] => {
        const record = asRecord(entry);
        const id = record === null ? null : stringValue(record["id"]);
        const question = record === null ? null : stringValue(record["question"]);
        if (record === null || id === null || question === null) {
            return [];
        }
        const rawOptions = Array.isArray(record["options"]) ? record["options"] : [];
        const options = rawOptions.flatMap((option): UserInputQuestion["options"] => {
            const optionRecord = asRecord(option);
            const label = optionRecord === null ? null : stringValue(optionRecord["label"]);
            if (optionRecord === null || label === null) {
                return [];
            }
            return [{label: label, description: stringValue(optionRecord["description"])}];
        });
        return [{id: id, question: question, options: options}];
    });
}

function parseFunctionArguments(value: unknown): unknown {
    if (typeof value !== "string") {
        return value;
    }
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
}

function parseJsonRecord(line: string): JsonRecord | null {
    if (line.trim().length === 0) {
        return null;
    }
    try {
        return asRecord(JSON.parse(line));
    } catch {
        return null;
    }
}

function asRecord(value: unknown): JsonRecord | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as JsonRecord
        : null;
}

function stringValue(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}
