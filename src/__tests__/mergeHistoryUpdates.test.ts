import { describe, expect, it } from "vitest";
import type { UpdateSessionEvent } from "../ACPSessionConnection";
import { mergeHistoryUpdates } from "../CodexAcpServer";

function userMessage(text: string): UpdateSessionEvent {
    return { sessionUpdate: "user_message_chunk", content: { type: "text", text } };
}

function agentMessage(id: string, text: string): UpdateSessionEvent {
    return { sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text } };
}

function toolCall(id: string): UpdateSessionEvent {
    return { sessionUpdate: "tool_call", toolCallId: id, status: "in_progress", title: id };
}

function summarize(updates: UpdateSessionEvent[]): string[] {
    return updates.map((update) => {
        switch (update.sessionUpdate) {
            case "user_message_chunk":
                return `user:${update.content.type === "text" ? update.content.text : "?"}`;
            case "agent_message_chunk":
                return `agent:${update.content.type === "text" ? update.content.text : "?"}`;
            case "tool_call":
                return `tool:${update.toolCallId}`;
            default:
                return update.sessionUpdate;
        }
    });
}

describe("mergeHistoryUpdates", () => {
    it("fills in per-turn tool details missing from thread turns", () => {
        // thread.turns is "lossy" — it omits the tool call the fallback recovers.
        const fallback = [userMessage("q1"), agentMessage("a1", "answer"), toolCall("t1")];
        const threadUpdates = [userMessage("q1"), agentMessage("a1", "answer")];

        const merged = mergeHistoryUpdates(fallback, threadUpdates);

        expect(summarize(merged)).toEqual(["user:q1", "agent:answer", "tool:t1"]);
    });

    it("does not revive turns dropped by rewind/fork truncation", () => {
        // The disk fallback still holds the full (2-turn) rollout, but thread.turns
        // has been truncated to the first turn after a rewind/rollback. The leftover
        // second turn must NOT reappear in the replayed history.
        const fallback = [
            userMessage("q1"),
            agentMessage("a1", "answer1"),
            toolCall("t1"),
            userMessage("q2"),
            agentMessage("a2", "answer2"),
            toolCall("t2"),
        ];
        const threadUpdates = [userMessage("q1"), agentMessage("a1", "answer1")];

        const merged = mergeHistoryUpdates(fallback, threadUpdates);

        expect(summarize(merged)).toEqual(["user:q1", "agent:answer1", "tool:t1"]);
    });
});
