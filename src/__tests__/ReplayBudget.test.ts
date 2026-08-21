import { describe, expect, it } from "vitest";
import type { UpdateSessionEvent } from "../ACPSessionConnection";
import { capReplayUpdate, REPLAY_TRUNCATION_MARKER } from "../ReplayBudget";

// Comfortably above the truncation marker's own length — a cap smaller than the
// marker deliberately still emits the marker (matching the claude fork), so
// tests pick a realistic cap instead of asserting that edge.
const CAP = 200;

function commandExecution(output: string): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: output } }],
        rawOutput: { formatted_output: output, exit_code: 0 },
    };
}

function fileDiff(oldText: string, newText: string): UpdateSessionEvent {
    return {
        sessionUpdate: "tool_call",
        toolCallId: "call-2",
        status: "completed",
        title: "edit",
        content: [{ type: "diff", path: "/tmp/a.cpp", oldText, newText }],
    };
}

function textOf(update: UpdateSessionEvent): string {
    if (update.sessionUpdate !== "tool_call_update") throw new Error("expected a tool_call_update");
    const block = update.content?.[0];
    if (block?.type !== "content" || block.content.type !== "text") throw new Error("expected a text block");
    return block.content.text;
}

describe("capReplayUpdate", () => {
    it("leaves a small update untouched, preserving identity", () => {
        const update = commandExecution("ok");
        const capped = capReplayUpdate(update, CAP);
        expect(capped.update).toBe(update);
        expect(capped.bytes).toBeGreaterThan(0);
    });

    it("truncates an oversized command output in both the block and rawOutput", () => {
        const capped = capReplayUpdate(commandExecution("x".repeat(50_000)), CAP);
        const update = capped.update as Extract<UpdateSessionEvent, { sessionUpdate: "tool_call_update" }>;
        const text = textOf(update);
        expect(text).toHaveLength(CAP);
        expect(text.endsWith(REPLAY_TRUNCATION_MARKER)).toBe(true);
        // codex ships the command output twice (the text block and rawOutput);
        // both copies travel the wire, so both must be capped.
        const rawOutput = update.rawOutput as Record<string, unknown> | undefined;
        expect(rawOutput?.["formatted_output"]).toBe(text);
        expect(rawOutput?.["exit_code"]).toBe(0);
    });

    it("truncates both sides of an oversized diff", () => {
        const capped = capReplayUpdate(fileDiff("a".repeat(80_000), "b".repeat(90_000)), CAP);
        const update = capped.update as Extract<UpdateSessionEvent, { sessionUpdate: "tool_call" }>;
        const block = update.content?.[0];
        if (block?.type !== "diff") throw new Error("expected a diff block");
        expect(block.oldText).toHaveLength(CAP);
        expect(block.newText).toHaveLength(CAP);
        expect(block.path).toBe("/tmp/a.cpp");
    });

    it("charges post-truncation bytes so one huge payload cannot overrun the total budget", () => {
        const huge = capReplayUpdate(commandExecution("y".repeat(10_000_000)), CAP);
        const small = capReplayUpdate(commandExecution("y"), CAP);
        // Both output copies are capped, so the charge is bounded by ~2×CAP over
        // the update's fixed enum/id strings — not by the 10MB payload.
        expect(huge.bytes).toBeLessThanOrEqual(small.bytes + 2 * CAP);
    });

    it("survives a cyclic payload without recursing forever", () => {
        const cyclic: Record<string, unknown> = { sessionUpdate: "tool_call", text: "hi" };
        cyclic["self"] = cyclic;
        expect(() => capReplayUpdate(cyclic, CAP)).not.toThrow();
    });
});
