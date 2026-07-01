import { describe, expect, it } from "vitest";
import type { UpdateSessionEvent } from "../../ACPSessionConnection";
import { parseResponseItemHistoryFallback } from "../../ResponseItemHistoryFallback";

type ToolCallUpdate = Extract<UpdateSessionEvent, { sessionUpdate: "tool_call_update" }>;

describe("ResponseItemHistoryFallback", () => {
    it("recovers only missing function calls for mixed parsed histories", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            functionCall("call-existing", "rg \"Existing\" src"),
            functionCallOutput("call-existing", "Chunk ID: existing\nProcess exited with code 0\nOutput:\nsrc/existing.ts\n"),
            functionCall("call-missing", "rg \"Missing\" src"),
            functionCallOutput("call-missing", "Chunk ID: missing\nProcess exited with code 0\nOutput:\nsrc/missing.ts\n"),
        ]), "terminal_output", new Set(["call-existing"]));

        expect(toolCallIds(updates)).toEqual(["call-missing"]);
        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-missing", status: "completed" },
        ]);
    });

    it("does not recover function calls when all parsed tool call ids already exist", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            functionCall("call-existing-a", "rg \"ExistingA\" src"),
            functionCallOutput("call-existing-a", "Chunk ID: existing-a\nProcess exited with code 0\nOutput:\nsrc/a.ts\n"),
            functionCall("call-existing-b", "rg \"ExistingB\" src"),
            functionCallOutput("call-existing-b", "Chunk ID: existing-b\nProcess exited with code 0\nOutput:\nsrc/b.ts\n"),
        ]), "terminal_output", new Set(["call-existing-a", "call-existing-b"]));

        expect(toolCallIds(updates)).toEqual([]);
        expect(toolCallUpdateStatuses(updates)).toEqual([]);
    });

    it("does not duplicate adjacent reasoning from event and response item records", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            {
                type: "event_msg",
                payload: {
                    type: "agent_reasoning",
                    text: "Need to inspect the directory.",
                },
            },
            {
                type: "response_item",
                payload: {
                    type: "reasoning",
                    summary: [{ type: "summary_text", text: "Need to inspect the directory." }],
                    content: [],
                },
            },
            functionCall("call-search", "rg \"Needle\" src"),
            functionCallOutput("call-search", "Chunk ID: search\nProcess exited with code 0\nOutput:\nsrc/index.ts\n"),
        ]), "terminal_output");

        expect(thoughtTexts(updates)).toEqual(["Need to inspect the directory."]);
    });

    it("marks exec command outputs without exit footers failed when they report command errors", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            functionCall("call-read-failed", "cat missing.txt"),
            functionCallOutput("call-read-failed", "Error: No such file or directory\n"),
        ]), "terminal_output");

        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-read-failed", status: "failed" },
        ]);
    });

    it("marks exec command outputs without exit footers completed when they do not report errors", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            functionCall("call-read-ok", "cat existing.txt"),
            functionCallOutput("call-read-ok", "existing file contents\n"),
        ]), "terminal_output");

        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-read-ok", status: "completed" },
        ]);
    });

    it("treats shell_command function calls as executable terminal commands", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            shellCommandCall("call-shell", "echo hi"),
            functionCallOutput("call-shell", "hi\nProcess exited with code 0\n"),
        ]), "terminal_output");

        expect(toolCallKinds(updates)).toEqual([{ toolCallId: "call-shell", kind: "execute" }]);
        expect(toolCallTitles(updates)).toEqual([{ toolCallId: "call-shell", title: "echo hi" }]);
        expect(toolCallUsesTerminal(updates, "call-shell")).toBe(true);
    });

    it("classifies shell_command read commands via command action inference", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            shellCommandCall("call-read", "cat README.md"),
            functionCallOutput("call-read", "contents\n"),
        ]), "terminal_output");

        expect(toolCallKinds(updates)).toEqual([{ toolCallId: "call-read", kind: "read" }]);
    });
});

function jsonl(records: unknown[]): string {
    return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function functionCall(callId: string, cmd: string): unknown {
    return {
        type: "response_item",
        payload: {
            type: "function_call",
            name: "exec_command",
            arguments: JSON.stringify({
                cmd,
                workdir: "/workspace",
                yield_time_ms: 1000,
            }),
            call_id: callId,
        },
    };
}

function shellCommandCall(callId: string, command: string): unknown {
    return {
        type: "response_item",
        payload: {
            type: "function_call",
            name: "shell_command",
            arguments: JSON.stringify({
                command,
                workdir: "/workspace",
                timeout_ms: 10000,
            }),
            call_id: callId,
        },
    };
}

function functionCallOutput(callId: string, output: string): unknown {
    return {
        type: "response_item",
        payload: {
            type: "function_call_output",
            call_id: callId,
            output,
        },
    };
}

function toolCallIds(updates: UpdateSessionEvent[] | null): string[] {
    return (updates ?? [])
        .filter((update): update is Extract<UpdateSessionEvent, { sessionUpdate: "tool_call" }> => (
            update.sessionUpdate === "tool_call"
        ))
        .map((update) => update.toolCallId);
}

function toolCallUpdateStatuses(updates: UpdateSessionEvent[] | null): Array<Pick<ToolCallUpdate, "toolCallId" | "status">> {
    return (updates ?? [])
        .filter((update): update is ToolCallUpdate => update.sessionUpdate === "tool_call_update")
        .map((update) => ({
            toolCallId: update.toolCallId,
            status: update.status ?? null,
        }));
}

function thoughtTexts(updates: UpdateSessionEvent[] | null): string[] {
    return (updates ?? [])
        .filter((update): update is Extract<UpdateSessionEvent, { sessionUpdate: "agent_thought_chunk" }> => (
            update.sessionUpdate === "agent_thought_chunk"
        ))
        .flatMap((update) => update.content.type === "text" ? [update.content.text] : []);
}

type ToolCallStart = Extract<UpdateSessionEvent, { sessionUpdate: "tool_call" }>;

function toolCallStarts(updates: UpdateSessionEvent[] | null): ToolCallStart[] {
    return (updates ?? []).filter(
        (update): update is ToolCallStart => update.sessionUpdate === "tool_call",
    );
}

function toolCallKinds(
    updates: UpdateSessionEvent[] | null,
): Array<{ toolCallId: string; kind: ToolCallStart["kind"] }> {
    return toolCallStarts(updates).map((update) => ({
        toolCallId: update.toolCallId,
        kind: update.kind,
    }));
}

function toolCallTitles(
    updates: UpdateSessionEvent[] | null,
): Array<{ toolCallId: string; title: string }> {
    return toolCallStarts(updates).map((update) => ({
        toolCallId: update.toolCallId,
        title: update.title,
    }));
}

function toolCallUsesTerminal(updates: UpdateSessionEvent[] | null, toolCallId: string): boolean {
    const start = toolCallStarts(updates).find((update) => update.toolCallId === toolCallId);
    return (start?.content ?? []).some((content) => content.type === "terminal");
}
