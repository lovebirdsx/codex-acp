import {describe, expect, it, vi} from "vitest";
import type {ServerNotification} from "../../app-server";
import type {TokenUsageBreakdown} from "../../app-server/v2";
import type {AcpClientConnection, UpdateSessionEvent} from "../../ACPSessionConnection";
import {ClientCapabilities} from "../../tool-calls/ClientCapabilities";
import {createTestEventHandler, createTestSessionState} from "../acp-test-utils";

/*
 * fork: the codex side of the sub-agent trail, the counterpart of `subagent-token-usage.test.ts`.
 * The client declares `clientCapabilities._meta["subagent-transcript"]`, so the adapter forwards the
 * work of a direct child thread on the root session, attributed to the card of the sub-agent activity
 * that spawned it. `CodexAcpClient` wires `handleChildTranscript` only for that client, so the tests
 * call it the way the subscription does.
 */
const sessionId = "root-thread";
const childThreadId = "child-thread";

function createHandler() {
    const sessionState = createTestSessionState({
        sessionId,
        clientCapabilities: ClientCapabilities.from({
            _meta: {terminal_output_delta: true, "subagent-transcript": true},
        }),
    });
    const notify = vi.fn(async (_method: string, _params: unknown) => {});
    const connection = {notify, request: vi.fn()} as unknown as AcpClientConnection;
    const handler = createTestEventHandler(connection, sessionState);
    return {
        handler,
        sessionState,
        updates: (): UpdateSessionEvent[] =>
            notify.mock.calls.map((call) => (call[1] as {update: UpdateSessionEvent}).update),
    };
}

function parentOf(update: UpdateSessionEvent | undefined): unknown {
    return (update?._meta as {"codex"?: {"parentToolCallId"?: unknown}} | undefined)?.codex?.parentToolCallId;
}

function commandStarted(itemId: string, threadId = childThreadId): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId,
            turnId: "child-turn",
            startedAtMs: 0,
            item: {
                type: "commandExecution",
                id: itemId,
                pluginId: null,
                scriptPath: null,
                command: "curl wttr.in",
                cwd: "/workspace",
                processId: "pid-1",
                source: "agent",
                status: "inProgress",
                commandActions: [{type: "unknown", command: "curl wttr.in"}],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
            },
        },
    } as ServerNotification;
}

function outputDelta(itemId: string, delta: string): ServerNotification {
    return {
        method: "item/commandExecution/outputDelta",
        params: {threadId: childThreadId, turnId: "child-turn", itemId, delta},
    } as ServerNotification;
}

function agentMessageDelta(delta: string): ServerNotification {
    return {
        method: "item/agentMessage/delta",
        params: {threadId: childThreadId, turnId: "child-turn", itemId: "child-msg", delta},
    } as ServerNotification;
}

function childTurnCompleted(): ServerNotification {
    return {
        method: "turn/completed",
        params: {
            threadId: childThreadId,
            turn: {
                id: "child-turn",
                items: [],
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        },
    } as ServerNotification;
}

function breakdown(totalTokens: number, inputTokens: number, outputTokens: number): TokenUsageBreakdown {
    return {
        totalTokens,
        inputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens,
        reasoningOutputTokens: 0,
    };
}

function childTokenUsage(threadId: string): ServerNotification {
    return {
        method: "thread/tokenUsage/updated",
        params: {
            threadId,
            turnId: "child-turn",
            tokenUsage: {
                total: breakdown(1000, 800, 300),
                last: breakdown(1000, 800, 300),
                modelContextWindow: 128000,
            },
        },
    } as ServerNotification;
}

/** The card of a sub-agent activity, on the root thread. */
function activity(kind: "started" | "completed", itemId: string, threadId = childThreadId): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId: sessionId,
            turnId: "turn-1",
            startedAtMs: 0,
            item: {type: "subAgentActivity", id: itemId, kind, agentThreadId: threadId, agentPath: "/root/weather"},
        },
    } as ServerNotification;
}

describe("CodexEventHandler - sub-agent transcript", () => {
    it("holds the work of a child until the card of its sub-agent arrives, then sends it after the card", async () => {
        const {handler, updates} = createHandler();

        // Codex emits child output directly after the spawning collaboration item; the activity card follows.
        await handler.handleChildTranscript(commandStarted("child-cmd"));
        await handler.handleChildTranscript(outputDelta("child-cmd", "Sunny\n"));
        await handler.handleChildTranscript(agentMessageDelta("Sunny in Paris"));
        expect(updates()).toEqual([]);

        await handler.handleNotification(activity("started", "act-1"));

        const [card, ...child] = updates();
        expect(card).toMatchObject({sessionUpdate: "tool_call", toolCallId: "act-1"});
        expect(child.slice(0, 2).map((update) => update.sessionUpdate))
            .toEqual(["tool_call", "tool_call_update"]);
        expect(child[2]?.sessionUpdate).toBe("agent_message_chunk");
        for (const update of child) {
            expect(parentOf(update)).toBe("act-1");
        }
        // The buffered text arrived with the updates that carried it.
        expect(JSON.stringify(child)).toContain("Sunny");
    });

    it("keeps the lifecycle and the root thread out of the trail", async () => {
        const {handler, updates} = createHandler();

        // A turn of a child describes the child conversation, not the work of the sub-agent.
        await handler.handleChildTranscript(childTurnCompleted());
        // Work of the root thread never belongs to a card.
        await handler.handleChildTranscript(commandStarted("root-cmd", sessionId));

        await handler.handleNotification(activity("started", "act-1"));

        // Nothing was buffered: the card is the only update, and no flush follows it.
        expect(updates()).toHaveLength(1);
    });

    it("keeps the work and the token stats on the Start card of the sub-agent", async () => {
        const {handler, updates} = createHandler();
        await handler.handleNotification(activity("started", "act-1"));
        await handler.handleNotification(activity("completed", "act-2"));

        await handler.handleChildTranscript(commandStarted("child-cmd"));
        await handler.handleNotification(childTokenUsage(childThreadId));

        const attributed = updates().filter((update) => parentOf(update) !== undefined
            || update.sessionUpdate === "tool_call_update");
        expect(attributed.map((update) => (update as {toolCallId?: string}).toolCallId)).toEqual(["child-cmd", "act-1"]);
        expect(attributed[1]?._meta).toMatchObject({
            "_universe/subagentStats": {inputTokens: 800, outputTokens: 300},
        });
    });

    it("re-points a sub-agent thread when Codex starts it again", async () => {
        const {handler, updates} = createHandler();
        await handler.handleNotification(activity("started", "act-1"));
        await handler.handleChildTranscript(commandStarted("child-cmd"));
        expect(parentOf(updates().at(-1))).toBe("act-1");

        // A resumed sub-agent gets a fresh activity, and its work follows the new card.
        await handler.handleNotification(activity("started", "act-3"));
        await handler.handleChildTranscript(commandStarted("child-cmd-2"));
        expect(parentOf(updates().at(-1))).toBe("act-3");
    });

    it("drops the buffered work of the oldest sub-agent when too many wait for their card", async () => {
        const {handler, updates} = createHandler();
        for (let index = 1; index <= 17; index += 1) {
            await handler.handleChildTranscript(commandStarted(`cmd-${index}`, `sub-${index}`));
        }

        // The buffer of `sub-1` was dropped for the newer sub-agents.
        await handler.handleNotification(activity("started", "act-1", "sub-1"));
        expect(updates()).toHaveLength(1);

        await handler.handleNotification(activity("started", "act-17", "sub-17"));
        const [card, late] = updates().slice(1);
        expect(card).toMatchObject({toolCallId: "act-17"});
        expect(parentOf(late)).toBe("act-17");
    });
});
