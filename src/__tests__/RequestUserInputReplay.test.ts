import {describe, expect, it} from "vitest";
import {
    parseRequestUserInputReplay,
    readRequestUserInputReplay,
    type ReplayedUserInputCard,
} from "../RequestUserInputReplay";

function rolloutRecord(type: string, payload: unknown): string {
    return JSON.stringify({timestamp: "2026-01-01T00:00:00.000Z", type, payload});
}

function userMessageRecord(clientId: string): string {
    return rolloutRecord("event_msg", {
        type: "user_message",
        message: "Use the question tool",
        images: [],
        local_images: [],
        text_elements: [],
        client_id: clientId,
    });
}

function assistantMessage(text: string): string {
    return rolloutRecord("response_item", {
        type: "message",
        role: "assistant",
        content: [{type: "output_text", text}],
    });
}

function requestCall(callId: string, question: string): string {
    return rolloutRecord("response_item", {
        type: "function_call",
        name: "request_user_input",
        arguments: JSON.stringify({
            questions: [{
                header: "Math",
                id: "answer",
                options: [{label: "A. 12", description: "Pick A"}],
                question,
            }],
        }),
        call_id: callId,
    });
}

function requestOutput(callId: string, answer: string): string {
    return rolloutRecord("response_item", {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({answers: {answer: {answers: [answer]}}}),
    });
}

function shellCall(callId: string): string {
    return rolloutRecord("response_item", {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({command: ["ls"]}),
        call_id: callId,
    });
}

function contents(...lines: string[]): string {
    return `${lines.join("\n")}\n`;
}

/** The key of a typed agent message item, as historyAnchorKey builds it. */
function agentAnchor(text: string): string {
    return `agent:${text.length}:${text}`;
}

function userAnchor(clientId: string): string {
    return `user:${clientId}`;
}

function cardIds(cards: ReplayedUserInputCard[]): string[] {
    return cards.map(card => card.toolCallId);
}

describe("RequestUserInputReplay", () => {
    it("anchors a card between the typed items the rollout places around it", () => {
        const replay = parseRequestUserInputReplay(contents(
            userMessageRecord("client-1"),
            assistantMessage("I will ask a question."),
            requestCall("call-ask", "What is 3x = 12?"),
            requestOutput("call-ask", "6"),
            assistantMessage("The answer was 6."),
        ));

        expect(cardIds(replay.takeBefore(userAnchor("client-1")))).toEqual([]);
        expect(cardIds(replay.takeBefore(agentAnchor("I will ask a question.")))).toEqual([]);
        expect(cardIds(replay.takeBefore(agentAnchor("The answer was 6.")))).toEqual(["call-ask"]);
        expect(replay.takeRemaining()).toEqual([]);
    });

    it("places a card after the tool item that precedes it in the rollout", () => {
        const replay = parseRequestUserInputReplay(contents(
            userMessageRecord("client-1"),
            shellCall("call-shell"),
            requestCall("call-ask", "Which one?"),
            requestOutput("call-ask", "A"),
            assistantMessage("Done."),
        ));

        expect(cardIds(replay.takeBefore(userAnchor("client-1")))).toEqual([]);
        expect(cardIds(replay.takeBefore("call:call-shell"))).toEqual([]);
        expect(cardIds(replay.takeBefore(agentAnchor("Done.")))).toEqual(["call-ask"]);
    });

    it("consumes repeated anchors in the order both stores list them", () => {
        const replay = parseRequestUserInputReplay(contents(
            userMessageRecord("client-1"),
            assistantMessage("Working."),
            requestCall("call-first", "First?"),
            requestOutput("call-first", "A"),
            assistantMessage("Working."),
            requestCall("call-second", "Second?"),
            requestOutput("call-second", "B"),
        ));
        const key = agentAnchor("Working.");

        expect(cardIds(replay.takeBefore(key))).toEqual([]);
        expect(cardIds(replay.takeBefore(key))).toEqual(["call-first"]);
        // The rollout's second card lies past the last typed item, and its turn
        // was replayed, so it flushes at the end.
        expect(cardIds(replay.takeRemaining())).toEqual(["call-second"]);
    });

    it("holds a card of an unfinished pair until its output arrives", () => {
        const replay = parseRequestUserInputReplay(contents(
            userMessageRecord("client-1"),
            requestCall("call-ask", "Which one?"),
        ));

        expect(replay.isEmpty).toBe(true);
        expect(replay.takeRemaining()).toEqual([]);
    });

    it("ignores a request_user_input call without usable questions", () => {
        const replay = parseRequestUserInputReplay(contents(
            userMessageRecord("client-1"),
            rolloutRecord("response_item", {
                type: "function_call",
                name: "request_user_input",
                arguments: "not json",
                call_id: "call-broken",
            }),
            requestOutput("call-broken", "A"),
        ));

        expect(replay.isEmpty).toBe(true);
    });

    it("drops the cards of the turns a rewind left out of the typed history", () => {
        const replay = parseRequestUserInputReplay(contents(
            userMessageRecord("client-kept"),
            assistantMessage("Kept turn."),
            requestCall("call-kept", "Kept question?"),
            requestOutput("call-kept", "A"),
            userMessageRecord("client-dropped"),
            assistantMessage("Dropped turn."),
            requestCall("call-dropped", "Dropped question?"),
            requestOutput("call-dropped", "B"),
        ));

        // A rewind truncates the newest turns: the typed stream ends after the
        // first turn, while the rollout still holds the second one.
        expect(cardIds(replay.takeBefore(userAnchor("client-kept")))).toEqual([]);
        expect(cardIds(replay.takeBefore(agentAnchor("Kept turn.")))).toEqual([]);
        expect(cardIds(replay.takeRemaining())).toEqual(["call-kept"]);
    });

    it("drops the cards that end before the first replayed item (resume boundary)", () => {
        const replay = parseRequestUserInputReplay(contents(
            userMessageRecord("client-old"),
            assistantMessage("Old turn."),
            requestCall("call-old", "Old question?"),
            requestOutput("call-old", "A"),
            assistantMessage("Old answer."),
            userMessageRecord("client-new"),
            requestCall("call-new", "New question?"),
            requestOutput("call-new", "B"),
            assistantMessage("New answer."),
        ));

        // The boundary starts the replay at the second turn: everything before
        // it was already replayed by the pass that read the earlier items.
        expect(cardIds(replay.takeBefore(userAnchor("client-new")))).toEqual([]);
        expect(cardIds(replay.takeBefore(agentAnchor("New answer.")))).toEqual(["call-new"]);
        expect(replay.takeRemaining()).toEqual([]);
    });

    it("keeps every card when the typed history has no user-message anchor", () => {
        const replay = parseRequestUserInputReplay(contents(
            userMessageRecord("client-1"),
            requestCall("call-ask", "Which one?"),
            requestOutput("call-ask", "A"),
            assistantMessage("Done."),
        ));

        expect(cardIds(replay.takeBefore("call:call-cmd"))).toEqual([]);
        expect(cardIds(replay.takeRemaining())).toEqual(["call-ask"]);
    });

    it("drops nothing when the typed history ends before the card (interrupted tail)", () => {
        const replay = parseRequestUserInputReplay(contents(
            userMessageRecord("client-1"),
            assistantMessage("Working."),
            requestCall("call-ask", "Which one?"),
            requestOutput("call-ask", "A"),
        ));

        expect(cardIds(replay.takeBefore(userAnchor("client-1")))).toEqual([]);
        expect(cardIds(replay.takeBefore(agentAnchor("Working.")))).toEqual([]);
        expect(cardIds(replay.takeRemaining())).toEqual(["call-ask"]);
    });

    it("reads no cards for a thread without a rollout or one that cannot be read", async () => {
        expect((await readRequestUserInputReplay({path: null} as never)).isEmpty).toBe(true);
        expect((await readRequestUserInputReplay({path: "/tmp/definitely-missing-rollout.jsonl"} as never)).isEmpty).toBe(true);
    });

    it("reads the cards of a rollout file", async () => {
        const {mkdtemp, writeFile, rm} = await import("node:fs/promises");
        const {tmpdir} = await import("node:os");
        const {join} = await import("node:path");
        const dir = await mkdtemp(join(tmpdir(), "codex-acp-replay-"));
        try {
            const path = join(dir, "rollout.jsonl");
            await writeFile(path, contents(
                userMessageRecord("client-1"),
                requestCall("call-ask", "Which one?"),
                requestOutput("call-ask", "A"),
                assistantMessage("Done."),
            ), "utf8");

            const replay = await readRequestUserInputReplay({path} as never);
            expect(cardIds(replay.takeBefore(userAnchor("client-1")))).toEqual([]);
            expect(cardIds(replay.takeBefore(agentAnchor("Done.")))).toEqual(["call-ask"]);
        } finally {
            await rm(dir, {recursive: true, force: true});
        }
    });

    it("survives a rollout with malformed lines and unknown records", () => {
        const replay = parseRequestUserInputReplay([
            "not json",
            JSON.stringify({timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", payload: {id: "session-1"}}),
            userMessageRecord("client-1"),
            JSON.stringify({type: "response_item", payload: {type: "reasoning", summary: []}}),
            requestCall("call-ask", "Which one?"),
            requestOutput("call-ask", "A"),
            assistantMessage("Done."),
            "",
        ].join("\n"));

        expect(cardIds(replay.takeBefore(agentAnchor("Done.")))).toEqual(["call-ask"]);
    });
});
