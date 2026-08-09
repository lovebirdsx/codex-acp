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

    it("joins multiple reasoning summary parts with a section break", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            {
                type: "response_item",
                payload: {
                    type: "reasoning",
                    summary: [
                        { type: "summary_text", text: "**First plan**" },
                        { type: "summary_text", text: "**Second plan**" },
                    ],
                    content: [],
                },
            },
            functionCall("call-search", "rg \"Needle\" src"),
            functionCallOutput("call-search", "Chunk ID: search\nProcess exited with code 0\nOutput:\nsrc/index.ts\n"),
        ]), "terminal_output");

        expect(thoughtTexts(updates)).toEqual(["**First plan**\n\n**Second plan**"]);
    });

    it("preserves assistant message phase metadata from response items", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            {
                type: "response_item",
                payload: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Final answer text." }],
                    phase: "final_answer",
                },
            },
            functionCall("call-missing", "ls"),
            functionCallOutput("call-missing", "Chunk ID: missing\nProcess exited with code 0\nOutput:\nREADME.md\n"),
        ]), "terminal_output");

        expect(agentMessageMetas(updates)).toEqual([
            { codex: { phase: "final_answer" } },
        ]);
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

    it("recovers exec shell_command custom tool calls missing from the thread", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            execShellCommandCall("call-shell", "Get-ChildItem -Force; rg --files games"),
            execCustomToolCallOutput("call-shell", [
                "Script completed\nWall time 1.4 seconds\nOutput:\n",
                "Exit code: 0\nWall time: 0.7 seconds\nOutput:\nindex.html\nstyle.css\n",
            ]),
        ]), "terminal_output");

        expect(toolCallKinds(updates)).toEqual([{ toolCallId: "call-shell", kind: "execute" }]);
        expect(toolCallTitles(updates)).toEqual([
            { toolCallId: "call-shell", title: "Get-ChildItem -Force; rg --files games" },
        ]);
        expect(toolCallUsesTerminal(updates, "call-shell")).toBe(true);
        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-shell", status: "completed" },
        ]);
        expect(toolCallRawOutputs(updates)).toEqual([
            { formatted_output: "index.html\nstyle.css\n", exit_code: 0 },
        ]);
    });

    it("marks exec shell_command custom tool calls failed when the script reports a non-zero exit", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            execShellCommandCall("call-failed", "node --check broken.js"),
            execCustomToolCallOutput("call-failed", [
                "Script failed\nWall time 0.9 seconds\nOutput:\n",
                "Script error:\nExit code: 1\nWall time: 0.8 seconds\nOutput:\nsyntax error\n",
            ]),
        ]), "terminal_output");

        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-failed", status: "failed" },
        ]);
        expect(toolCallRawOutputs(updates)).toEqual([
            { formatted_output: "syntax error\n", exit_code: 1 },
        ]);
    });

    it("skips exec apply_patch custom tool calls rebuilt as fileChange thread items", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            execApplyPatchCall("call-patch"),
            execCustomToolCallOutput("call-patch", [
                "Script completed\nWall time 0.1 seconds\nOutput:\n",
                "{}",
            ]),
        ]), "terminal_output");

        expect(updates).toBeNull();
    });

    it("recovers only shell exec calls from mixed custom tool call histories", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            execShellCommandCall("call-shell", "rg --files src"),
            execCustomToolCallOutput("call-shell", [
                "Script completed\nWall time 0.2 seconds\nOutput:\n",
                "Exit code: 0\nWall time: 0.2 seconds\nOutput:\nsrc/index.ts\n",
            ]),
            execApplyPatchCall("call-patch"),
            execCustomToolCallOutput("call-patch", [
                "Script completed\nWall time 0.1 seconds\nOutput:\n",
                "{}",
            ]),
        ]), "terminal_output");

        expect(toolCallIds(updates)).toEqual(["call-shell"]);
        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-shell", status: "completed" },
        ]);
    });

    it("skips JS REPL internal wait calls and suppresses their outputs", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            execShellCommandCall("call-shell", "rg --files src"),
            replWaitCall("call-wait"),
            functionCallOutput("call-wait", "{\"output\":\"src/index.ts\\n\"}"),
            execCustomToolCallOutput("call-shell", [
                "Script completed\nWall time 0.2 seconds\nOutput:\n",
                "Exit code: 0\nWall time: 0.2 seconds\nOutput:\nsrc/index.ts\n",
            ]),
        ]), "terminal_output");

        expect(toolCallIds(updates)).toEqual(["call-shell"]);
        expect(toolCallUpdateStatuses(updates)).toEqual([
            { toolCallId: "call-shell", status: "completed" },
        ]);
    });

    it("returns null when the only recoverable calls are JS REPL internal wait calls", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            replWaitCall("call-wait"),
            functionCallOutput("call-wait", "{}"),
        ]), "terminal_output");

        expect(updates).toBeNull();
    });

    // Real rollout pair from a live request_user_input turn (the elicitation
    // itself is never persisted as an event_msg — only these response_items).
    it("replays request_user_input as a readable question card with the user's answer", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            userInputCall("call-ask", [{
                header: "数学选择题",
                id: "answer",
                options: [
                    { label: "A. 12", description: "选择选项 A" },
                    { label: "B. 15", description: "选择选项 B" },
                    { label: "C. 18", description: "选择选项 C" },
                ],
                question: "若 3x + 6 = 24，则 x 等于多少？",
            }]),
            userInputCallOutput("call-ask", { answers: { answer: { answers: ["6"] } } }),
        ]), "terminal_output");

        const toolCalls = (updates ?? []).filter((u) => u.sessionUpdate === "tool_call");
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0]).toMatchObject({
            toolCallId: "call-ask",
            kind: "other",
            title: "若 3x + 6 = 24，则 x 等于多少？",
            status: "in_progress",
        });
        const questionText = toolCallText(toolCalls[0]!);
        expect(questionText).toContain("若 3x + 6 = 24，则 x 等于多少？");
        expect(questionText).toContain("A. 12");
        expect(questionText).toContain("B. 15");
        expect(questionText).toContain("C. 18");

        const toolUpdates = (updates ?? []).filter((u) => u.sessionUpdate === "tool_call_update");
        expect(toolUpdates).toHaveLength(1);
        expect(toolUpdates[0]).toMatchObject({ toolCallId: "call-ask", status: "completed" });
        const answerText = toolCallUpdateText(toolUpdates[0]!);
        expect(answerText).toContain("若 3x + 6 = 24，则 x 等于多少？");
        expect(answerText).toContain("**答案**：6");
    });

    it("renders a selected option folded with its Other note verbatim", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            userInputCall("call-ask", [{
                header: "数学选择题",
                id: "math_answer",
                options: [
                    { label: "8", description: "计算结果。" },
                    { label: "4", description: "计算结果。" },
                ],
                question: "f(5) 的值是？",
            }]),
            // Live, the fork folds a typed note onto the picked option as
            // "<label>（补充：<note>）" — replay must surface both parts.
            userInputCallOutput("call-ask", { answers: { math_answer: { answers: ["8（补充：为什么？）"] } } }),
        ]), "terminal_output");

        const answerText = toolCallUpdateText(
            (updates ?? []).find((u) => u.sessionUpdate === "tool_call_update")!,
        );
        expect(answerText).toContain("**答案**：8（补充：为什么？）");
    });

    it("titles a multi-question request_user_input card and maps answers per question id", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            userInputCall("call-ask", [
                {
                    header: "Next step",
                    id: "next_step",
                    options: [{ label: "Run tests", description: "Run the suite." }],
                    question: "What should I do next?",
                },
                {
                    header: "Notes",
                    id: "notes",
                    options: null,
                    question: "Any extra instructions?",
                },
            ]),
            userInputCallOutput("call-ask", {
                answers: {
                    next_step: { answers: ["Inspect flaky logs"] },
                },
            }),
        ]), "terminal_output");

        const toolCalls = (updates ?? []).filter((u) => u.sessionUpdate === "tool_call");
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0]).toMatchObject({ title: "Input requested" });

        const answerText = toolCallUpdateText(
            (updates ?? []).find((u) => u.sessionUpdate === "tool_call_update")!,
        );
        expect(answerText).toContain("**答案**：Inspect flaky logs");
        expect(answerText).toContain("（跳过）");
    });

    it("falls back to the generic output update when the answers payload is unparseable", () => {
        const updates = parseResponseItemHistoryFallback(jsonl([
            userInputCall("call-ask", [{
                header: "Q",
                id: "answer",
                options: null,
                question: "Pick one?",
            }]),
            functionCallOutput("call-ask", "not-json"),
        ]), "terminal_output");

        const toolUpdates = (updates ?? []).filter((u) => u.sessionUpdate === "tool_call_update");
        expect(toolUpdates).toHaveLength(1);
        expect(toolUpdates[0]).toMatchObject({
            toolCallId: "call-ask",
            status: "completed",
            rawOutput: { output: "not-json" },
        });
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

function replWaitCall(callId: string): unknown {
    return {
        type: "response_item",
        payload: {
            type: "function_call",
            name: "wait",
            arguments: JSON.stringify({
                cell_id: "1",
                yield_time_ms: 10000,
                max_tokens: 12000,
            }),
            call_id: callId,
        },
    };
}

function execShellCommandCall(callId: string, command: string): unknown {
    // Codex emits a JS object literal (bare keys), not strict JSON.
    const args = `{command:${JSON.stringify(command)},workdir:"F:\\\\test\\\\test",timeout_ms:10000}`;
    return {
        type: "response_item",
        payload: {
            type: "custom_tool_call",
            status: "completed",
            call_id: callId,
            name: "exec",
            input: `const r = await tools.shell_command(${args});\n`
                + "text(typeof r === \"string\" ? r : JSON.stringify(r));",
        },
    };
}

function execApplyPatchCall(callId: string): unknown {
    const patch = "*** Begin Patch\\n*** Add File: F:\\\\test\\\\test\\\\index.html\\n+<html>\\n*** End Patch";
    return {
        type: "response_item",
        payload: {
            type: "custom_tool_call",
            status: "completed",
            call_id: callId,
            name: "exec",
            input: `const patch = "${patch}";\nconst r = await tools.apply_patch(patch);\n`
                + "text(typeof r === \"string\" ? r : JSON.stringify(r));",
        },
    };
}

function execCustomToolCallOutput(callId: string, texts: string[]): unknown {
    return {
        type: "response_item",
        payload: {
            type: "custom_tool_call_output",
            call_id: callId,
            output: texts.map((text) => ({ type: "input_text", text })),
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

function toolCallRawOutputs(updates: UpdateSessionEvent[] | null): unknown[] {
    return (updates ?? [])
        .filter((update): update is ToolCallUpdate => update.sessionUpdate === "tool_call_update")
        .map((update) => update.rawOutput);
}

function thoughtTexts(updates: UpdateSessionEvent[] | null): string[] {
    return (updates ?? [])
        .filter((update): update is Extract<UpdateSessionEvent, { sessionUpdate: "agent_thought_chunk" }> => (
            update.sessionUpdate === "agent_thought_chunk"
        ))
        .flatMap((update) => update.content.type === "text" ? [update.content.text] : []);
}

function agentMessageMetas(updates: UpdateSessionEvent[] | null): unknown[] {
    return (updates ?? [])
        .filter((update): update is Extract<UpdateSessionEvent, { sessionUpdate: "agent_message_chunk" }> => (
            update.sessionUpdate === "agent_message_chunk"
        ))
        .map((update) => update._meta);
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

type UserInputQuestionFixture = {
    header: string;
    id: string;
    options: Array<{ label: string; description: string }> | null;
    question: string;
};

function userInputCall(callId: string, questions: UserInputQuestionFixture[]): unknown {
    return {
        type: "response_item",
        payload: {
            type: "function_call",
            name: "request_user_input",
            arguments: JSON.stringify({ questions }),
            call_id: callId,
        },
    };
}

function userInputCallOutput(callId: string, output: unknown): unknown {
    return {
        type: "response_item",
        payload: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(output),
        },
    };
}

function toolCallText(update: UpdateSessionEvent): string {
    if (update.sessionUpdate !== "tool_call") {
        return "";
    }
    return (update.content ?? [])
        .flatMap((item) => (
            item.type === "content" && item.content.type === "text" ? [item.content.text] : []
        ))
        .join("\n");
}

function toolCallUpdateText(update: UpdateSessionEvent): string {
    if (update.sessionUpdate !== "tool_call_update") {
        return "";
    }
    return (update.content ?? [])
        .flatMap((item) => (
            item.type === "content" && item.content.type === "text" ? [item.content.text] : []
        ))
        .join("\n");
}
