import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { createCodexMockTestFixture, createTestModel } from "../acp-test-utils";
import type { Model, Thread, ThreadGoal, ThreadItem, ThreadItemsListParams, UserInput } from "../../app-server/v2";

const rolloutLine = (type: string, payload: unknown): string =>
    JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type, payload });

/**
 * One resolved turn of a real rollout that asked a question: the elicitation
 * only leaves the model's own function_call/function_call_output pair behind,
 * and the app-server's typed history drops it.
 */
function questionTurnRollout(options: {
    callId: string;
    clientId: string;
    prompt: string;
    commentary: string;
    question: string;
    answer: string;
    final: string;
}): string[] {
    return [
        rolloutLine("event_msg", { type: "task_started", turn_id: options.callId }),
        rolloutLine("turn_context", {
            cwd: "/workspace",
            approval_policy: "never",
            sandbox_policy: { type: "danger-full-access" },
            model: "gpt-5.2",
            effort: "medium",
            summary: "auto",
        }),
        rolloutLine("response_item", {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: options.prompt }],
        }),
        rolloutLine("event_msg", {
            type: "user_message",
            message: options.prompt,
            images: [],
            local_images: [],
            text_elements: [],
            client_id: options.clientId,
        }),
        rolloutLine("response_item", {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: options.commentary }],
            phase: "commentary",
        }),
        rolloutLine("response_item", {
            type: "function_call",
            name: "request_user_input",
            arguments: JSON.stringify({
                questions: [{
                    header: "数学选择题",
                    id: "answer",
                    options: [
                        { label: "A. 12", description: "选择选项 A" },
                        { label: "B. 15", description: "选择选项 B" },
                        { label: "C. 18", description: "选择选项 C" },
                    ],
                    question: options.question,
                }],
            }),
            call_id: options.callId,
        }),
        rolloutLine("response_item", {
            type: "function_call_output",
            call_id: options.callId,
            output: JSON.stringify({ answers: { answer: { answers: [options.answer] } } }),
        }),
        rolloutLine("response_item", {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: options.final }],
            phase: "final_answer",
        }),
        rolloutLine("event_msg", { type: "task_complete", turn_id: options.callId }),
    ];
}

async function writeRollout(dir: string, lines: string[]): Promise<string> {
    const path = join(dir, "rollout.jsonl");
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    return path;
}

function replayedQuestionUpdates(fixture: ReturnType<typeof createCodexMockTestFixture>) {
    const updates = fixture.getAcpConnectionEvents([])
        .filter(event => event.method === "sessionUpdate")
        .map(event => event.args[0].update);
    return {
        updates,
        toolCallIndex: updates.findIndex(update => update.sessionUpdate === "tool_call"),
        answerIndex: updates.findIndex(update => update.sessionUpdate === "tool_call_update"),
    };
}

/** A fake thread/items/list over `entries`, in pages of `pageSize` items. */
function itemListStore(entries: Array<{ turnId: string; item: ThreadItem }>, pageSize = 2) {
    return async (params: ThreadItemsListParams) => {
        const cursor = params.cursor as string | null | undefined;
        if (params.sortDirection === "desc") {
            const index = cursor === null || cursor === undefined
                ? entries.length - 1
                : entries.findIndex(entry => `item:${entry.item.id}` === cursor);
            return { data: index < 0 ? [] : [entries[index]!], nextCursor: null, backwardsCursor: null };
        }
        const start = cursor === null || cursor === undefined ? 0 : Number(cursor.slice("asc:".length));
        const end = Math.min(start + pageSize, entries.length);
        return {
            data: entries.slice(start, end).map(entry => ({ ...entry, startedAtMs: null, completedAtMs: null })),
            nextCursor: end < entries.length ? `asc:${end}` : null,
            backwardsCursor: null,
        };
    };
}

describe("CodexACPAgent - loadSession", () => {
    it("preserves every native user input kind during history replay", async () => {
        const cases: Array<{input: UserInput, content: acp.ContentBlock}> = [
            {input: {type: "text", text: "Request", text_elements: []}, content: {type: "text", text: "Request"}},
            {input: {type: "image", url: "https://example.com/image.png"}, content: {type: "text", text: "[@image](https://example.com/image.png)"}},
            {input: {type: "image", fileId: "saved-image"}, content: {type: "text", text: "image:saved-image"}},
            {input: {type: "localImage", path: "/workspace/image #1.png"}, content: {type: "resource_link", name: "image #1.png", uri: "file:///workspace/image%20%231.png"}},
            {input: {type: "audio", url: "https://example.com/audio.wav"}, content: {type: "text", text: "[@audio](https://example.com/audio.wav)"}},
            {input: {type: "localAudio", path: "/workspace/audio.wav"}, content: {type: "resource_link", name: "audio.wav", uri: "file:///workspace/audio.wav"}},
            {input: {type: "mention", name: "Document", path: "/workspace/document.pdf"}, content: {type: "resource_link", name: "Document", uri: "file:///workspace/document.pdf"}},
            {input: {type: "mention", name: "", path: "/workspace/document.pdf"}, content: {type: "resource_link", name: "document.pdf", uri: "file:///workspace/document.pdf"}},
            {input: {type: "mention", name: "File URI", path: "file:///workspace/document%20one.pdf"}, content: {type: "resource_link", name: "File URI", uri: "file:///workspace/document%20one.pdf"}},
            {input: {type: "mention", name: "Issue", path: "https://example.com/issue"}, content: {type: "text", text: "[@Issue](https://example.com/issue)"}},
            {input: {type: "skill", name: "Review", path: "/workspace/SKILL.md"}, content: {type: "text", text: "skill:Review (/workspace/SKILL.md)"}},
            {input: {type: "localImage", path: "image.png"}, content: {type: "text", text: "[@image.png](image.png)"}},
            {input: {type: "localAudio", path: "audio.wav"}, content: {type: "text", text: "[@audio.wav](audio.wav)"}},
            {input: {type: "mention", name: "Relative file", path: "document.pdf"}, content: {type: "text", text: "[@Relative file](document.pdf)"}},
        ];
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
        const thread = {
            id: "native-input-history", historyMode: "legacy", turns: [{
                id: "turn-1", itemsView: "full", status: "completed", items: cases.map(({input}, index) => ({
                    type: "userMessage", id: `native-${index}`, clientId: null, content: [input],
                })),
            }],
        } as unknown as Thread;
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread, model: model.id, modelProvider: "openai", cwd: "/workspace",
            approvalPolicy: "never", sandbox: {type: "dangerFullAccess"}, reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread});
        await agent.initialize({protocolVersion: 1, clientCapabilities: {}});
        await agent.loadSession({sessionId: thread.id, cwd: "/workspace", mcpServers: []});
        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update)
            .filter(update => update.sessionUpdate === "user_message_chunk");
        expect(updates.map(update => ({messageId: update.messageId, content: update.content}))).toEqual(
            cases.map(({content}, index) => ({messageId: `native-${index}`, content})),
        );
    });

    it("replays Desktop attachments as resources in the original user message", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
        const texts = [
            '\n# Files pasted by the user:\n\n## "Error log": /workspace/pasted-text.txt\n\n## My request:\nFix job\\_id\n',
            '# Files pasted by the user:\n\n## "Request": /workspace/request.txt\n\nPasted text contains the user\'s request.\n\n## My request:\n\n',
            '# Files mentioned by the user:\n\n## unknown: relative.txt\n\n## My request:\nKeep this text',
            '# Files mentioned by the user:\n\n## screenshot.png: /workspace/screen #1.png\nImage attachment: true\n\n## My request:\nCompare',
        ];
        const thread = {
            id: "attachment-history", historyMode: "legacy", turns: [{
                id: "turn-1", itemsView: "full", status: "completed", items: texts.map((text, index) => ({
                    type: "userMessage", id: `user-${index}`, clientId: null,
                    content: [
                        ...(index === 3 ? [
                            {type: "localImage", path: "/workspace/screen #1.png"},
                            {type: "localAudio", path: "/workspace/screen #1.png"},
                            {type: "mention", name: "Same image", path: "/workspace/screen #1.png"},
                        ] : []),
                        {type: "text", text, text_elements: []},
                        ...(index === 3 ? [{type: "localImage", path: "/workspace/other.png"}] : []),
                    ],
                })),
            }],
        } as unknown as Thread;
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread, model: model.id, modelProvider: "openai", cwd: "/workspace",
            approvalPolicy: "never", sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread});

        await agent.initialize({protocolVersion: 1, clientCapabilities: {}});
        await agent.loadSession({sessionId: thread.id, cwd: "/workspace", mcpServers: []});

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update)
            .filter(update => update.sessionUpdate === "user_message_chunk");
        expect(updates.map(update => ({messageId: update.messageId, content: update.content}))).toEqual([
            {messageId: "user-0", content: {type: "resource_link", name: "Error log", uri: "file:///workspace/pasted-text.txt"}},
            {messageId: "user-0", content: {type: "text", text: "Fix job\\_id\n"}},
            {messageId: "user-1", content: {type: "resource_link", name: "Request", uri: "file:///workspace/request.txt"}},
            {messageId: "user-2", content: {type: "text", text: texts[2]}},
            // fork: replayed attachments lead the text, matching a live prompt's wire order.
            {messageId: "user-3", content: {type: "resource_link", name: "other.png", uri: "file:///workspace/other.png"}},
            {messageId: "user-3", content: {type: "resource_link", name: "screenshot.png", uri: "file:///workspace/screen%20%231.png"}},
            {messageId: "user-3", content: {type: "text", text: "Compare"}},
        ]);
    });

    it("replays native child history and disconnects an orphan", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
        const makeThread = (id: string, items: Thread["turns"][number]["items"]): Thread => ({
            id,
            sessionId: id,
            parentThreadId: id === "root-history" ? null : "root-history",
            threadSource: null,
            originator: null,
            forkedFromId: null,
            preview: id,
            ephemeral: false,
            modelProvider: "openai",
            model: null,
            reasoningEffort: null,
            createdAt: 1,
            updatedAt: 2,
            recencyAt: null,
            status: {type: "idle"},
            path: null,
            cwd: "/workspace",
            cliVersion: "0",
            section: null,
            sectionEnteredAt: null,
            projectId: null,
            historyMode: "legacy",
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [{
                id: `turn-${id}`,
                itemsView: "full",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
                items,
            }],
        });
        const root = makeThread("root-history", [
            {
                type: "subAgentActivity",
                id: "activity-child-1",
                kind: "started",
                agentThreadId: "child-history",
                agentPath: "/root/history_child",
            },
            {
                type: "subAgentActivity",
                id: "activity-child-1-terminal",
                kind: "interrupted",
                agentThreadId: "child-history",
                agentPath: "/root/history_child",
            },
            {
                type: "subAgentActivity",
                id: "activity-child-2",
                kind: "started",
                agentThreadId: "child-history",
                agentPath: "/root/history_child",
            },
            {
                type: "subAgentActivity",
                id: "activity-child-2-terminal",
                kind: "interrupted",
                agentThreadId: "child-history",
                agentPath: "/root/history_child",
            },
            {
                type: "subAgentActivity",
                id: "activity-orphan",
                kind: "started",
                agentThreadId: "orphan-history",
                agentPath: "/root/orphan_child",
            },
        ]);
        const child = makeThread("child-history", [
            {
                type: "commandExecution",
                id: "child-command-1",
                pluginId: null,
                scriptPath: null,
                command: "python -m http.server",
                cwd: "/workspace",
                processId: "42",
                source: "unifiedExecStartup",
                status: "inProgress",
                commandActions: [],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
            },
            {
                type: "agentMessage",
                id: "child-history-message-1",
                text: "Persisted first-generation output",
                phase: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
            },
        ]);
        const firstChildTurn = child.turns[0]!;
        child.turns.push({
            id: "turn-child-history-2",
            itemsView: firstChildTurn.itemsView,
            status: firstChildTurn.status,
            error: firstChildTurn.error,
            startedAt: firstChildTurn.startedAt,
            completedAt: firstChildTurn.completedAt,
            durationMs: firstChildTurn.durationMs,
            items: [{
                type: "agentMessage",
                id: "child-history-message-2",
                text: "Persisted second-generation output",
                phase: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
            }],
        });
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread: root,
            model: model.id,
            modelProvider: "openai",
            cwd: "/workspace",
            approvalPolicy: "never",
            sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread: root});
        // The adapter reads one turn of a child for each generation.
        appServer.threadRead = vi.fn().mockImplementation(({threadId}) => {
            if (threadId === "orphan-history") return Promise.reject(new Error("missing child history"));
            return Promise.resolve({thread: {...child, historyMode: "legacy"}});
        });
        appServer.threadBackgroundTerminalsList = vi.fn().mockImplementation(({threadId}) => Promise.resolve({
            data: threadId === "child-history"
                ? [{itemId: "child-command-1", processId: "42", command: "python -m http.server"}]
                : [],
            nextCursor: null,
        }));

        await agent.initialize({
            protocolVersion: 1,
            clientCapabilities: {
                _meta: {jetbrains: {air: {version: 1, capabilities: ["nativeSubagentSessions", "asyncTasks"]}}},
            },
        });
        await agent.loadSession({sessionId: root.id, cwd: "/workspace", mcpServers: []});

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0]);
        const firstSpawnIndex = updates.findIndex(({update}) => update.subagentSessionId === "child-history"
            && update.sessionUpdate === "subagent_spawned");
        const firstOutputIndex = updates.findIndex(({update}) => update.messageId === "child-history-message-1");
        const childTaskIndex = updates.findIndex(({update}) => update.sessionUpdate === "async_task_spawned"
            && update.asyncTaskId === "child-history:child-command-1");
        const firstTerminalIndex = updates.findIndex(({update}) => update.sessionUpdate === "subagent_state_update"
            && update.subagentSessionId === "child-history");
        const secondSpawnIndex = updates.findIndex(({update}) => update.subagentSessionId === "child-history:generation:2"
            && update.sessionUpdate === "subagent_spawned");
        const secondOutputIndex = updates.findIndex(({update}) => update.messageId === "child-history-message-2");
        const orphanTerminalIndex = updates.findIndex(({update}) => update.subagentSessionId === "orphan-history"
            && update.state === "disconnected");
        expect(firstOutputIndex).toBeGreaterThan(firstSpawnIndex);
        expect(childTaskIndex).toBeGreaterThan(firstSpawnIndex);
        expect(firstTerminalIndex).toBeGreaterThan(childTaskIndex);
        expect(secondSpawnIndex).toBeGreaterThan(firstOutputIndex);
        expect(secondOutputIndex).toBeGreaterThan(secondSpawnIndex);
        expect(orphanTerminalIndex).toBeGreaterThan(secondOutputIndex);
        expect(updates[firstOutputIndex]?.sessionId).toBe("child-history");
        expect(updates[secondOutputIndex]?.sessionId).toBe("child-history:generation:2");
    });

    it("replays the work of a sub-agent under its activity card without native subagent sessions", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});

        const message = (id: string, text: string) => ({
            type: "agentMessage", id, text, phase: null, memoryCitation: null, delivery: null, questions: null,
        });
        const activity = (id: string, kind: "started" | "completed" | "interrupted") => ({
            type: "subAgentActivity", id, kind, agentThreadId: "child-history", agentPath: "/root/weather",
        });
        const child = {
            id: "child-history",
            historyMode: "legacy",
            turns: [
                {
                    id: "child-turn-1", itemsView: "full", status: "completed", items: [
                        {
                            type: "commandExecution", id: "child-command-1", pluginId: null, scriptPath: null,
                            command: "curl wttr.in", cwd: "/workspace", processId: "42", source: "agent",
                            status: "completed", commandActions: [], aggregatedOutput: "Sunny\n",
                            exitCode: 0, durationMs: 3,
                        },
                        message("child-message-1", "Persisted first-generation output"),
                    ],
                },
                {
                    id: "child-turn-2", itemsView: "full", status: "completed",
                    items: [message("child-message-2", "Persisted second-generation output")],
                },
            ],
        } as unknown as Thread;
        // The sub-agent ran twice: each `started` activity is one turn of the child thread.
        const root = {
            id: "root-history",
            historyMode: "legacy",
            turns: [{
                id: "root-turn-1", itemsView: "full", status: "completed", items: [
                    activity("activity-1", "started"),
                    activity("activity-1-terminal", "completed"),
                    message("root-message", "Root work between the sub-agents"),
                    activity("activity-2", "started"),
                ],
            }],
        } as unknown as Thread;
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread: root, model: model.id, modelProvider: "openai", cwd: "/workspace",
            approvalPolicy: "never", sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread: root});
        appServer.threadRead = vi.fn().mockImplementation(({threadId}) =>
            Promise.resolve({thread: threadId === "child-history" ? child : root}));

        await agent.initialize({protocolVersion: 1, clientCapabilities: {_meta: {"subagent-transcript": true}}});
        await agent.loadSession({sessionId: root.id, cwd: "/workspace", mcpServers: []});

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0]);
        const indexOf = (predicate: (update: any) => boolean) =>
            updates.findIndex(({update}) => predicate(update));
        const cardIndex = indexOf(update => update.toolCallId === "activity-1" && update.sessionUpdate === "tool_call");
        const commandIndex = indexOf(update => update.toolCallId === "child-command-1");
        const firstOutputIndex = indexOf(update => update.messageId === "child-message-1");
        const secondCardIndex = indexOf(update => update.toolCallId === "activity-2" && update.sessionUpdate === "tool_call");
        const secondOutputIndex = indexOf(update => update.messageId === "child-message-2");
        // The work of a sub-agent follows the card of the activity that spawned it, and the
        // terminal activity replays nothing a second time.
        expect(cardIndex).toBeGreaterThan(-1);
        expect(commandIndex).toBeGreaterThan(cardIndex);
        expect(firstOutputIndex).toBeGreaterThan(commandIndex);
        expect(secondCardIndex).toBeGreaterThan(firstOutputIndex);
        expect(secondOutputIndex).toBeGreaterThan(secondCardIndex);
        expect(updates.filter(({update}) => update.messageId === "child-message-1")).toHaveLength(1);
        // The terminal activity replays no second copy of the first-generation work: the command
        // card (its `tool_call` and its update) stays ahead of the second card.
        expect(Math.max(...updates.map(({update}, index) =>
            update.toolCallId === "child-command-1" ? index : -1))).toBeLessThan(secondCardIndex);

        const parentOf = (index: number) => updates[index]?.update._meta?.codex?.parentToolCallId;
        expect(parentOf(commandIndex)).toBe("activity-1");
        expect(parentOf(firstOutputIndex)).toBe("activity-1");
        expect(parentOf(secondOutputIndex)).toBe("activity-2");
        // Every replayed update stays on the session of the root thread.
        for (const {sessionId} of updates) expect(sessionId).toBe("root-history");
        const rootMessage = updates[indexOf(update => update.messageId === "root-message")];
        expect(rootMessage?.update._meta?.codex?.parentToolCallId).toBeUndefined();
    });

    it("keeps a session loadable when the history of a sub-agent cannot be read", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});

        const root = {
            id: "root-history",
            historyMode: "legacy",
            turns: [{
                id: "root-turn-1", itemsView: "full", status: "completed", items: [
                    {type: "subAgentActivity", id: "activity-1", kind: "started", agentThreadId: "child-history", agentPath: "/root/weather"},
                    {type: "agentMessage", id: "root-message", text: "Root work after the sub-agent", phase: null, memoryCitation: null, delivery: null, questions: null},
                ],
            }],
        } as unknown as Thread;
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread: root, model: model.id, modelProvider: "openai", cwd: "/workspace",
            approvalPolicy: "never", sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread: root});
        appServer.threadRead = vi.fn().mockImplementation(({threadId}) => threadId === "child-history"
            ? Promise.reject(new Error("missing child history"))
            : Promise.resolve({thread: root}));

        await agent.initialize({protocolVersion: 1, clientCapabilities: {_meta: {"subagent-transcript": true}}});
        await agent.loadSession({sessionId: root.id, cwd: "/workspace", mcpServers: []});

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update);
        // The trail of the unreadable sub-agent is lost; the rest of the history is not.
        expect(updates.some(update => update.toolCallId === "activity-1")).toBe(true);
        expect(updates.some(update => update.messageId === "root-message")).toBe(true);
        expect(updates.some(update => update._meta?.codex?.parentToolCallId !== undefined)).toBe(false);
    });

    it("replays the work of a collaboration spawn under its card without native subagent sessions", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});

        const message = (id: string, text: string) => ({
            type: "agentMessage", id, text, phase: null, memoryCitation: null, delivery: null, questions: null,
        });
        const collab = (id: string, tool: string) => ({
            type: "collabAgentToolCall", id, tool, status: "completed", senderThreadId: "root-history",
            receiverThreadIds: ["child-history"], prompt: "Run echo alpha.", model: null, reasoningEffort: null,
            agentsStates: {"child-history": {status: "completed", message: "alpha"}},
        });
        const child = {
            id: "child-history",
            historyMode: "legacy",
            turns: [
                {
                    id: "child-turn-1", itemsView: "full", status: "completed", items: [
                        {
                            type: "commandExecution", id: "child-command-1", pluginId: null, scriptPath: null,
                            command: "echo alpha", cwd: "/workspace", processId: "42", source: "agent",
                            status: "completed", commandActions: [], aggregatedOutput: "alpha\n",
                            exitCode: 0, durationMs: 3,
                        },
                        message("child-message-1", "alpha"),
                    ],
                },
                {
                    id: "child-turn-2", itemsView: "full", status: "completed",
                    items: [message("child-message-2", "beta")],
                },
            ],
        } as unknown as Thread;
        const root = {
            id: "root-history",
            historyMode: "legacy",
            turns: [{
                id: "root-turn-1", itemsView: "full", status: "completed", items: [
                    collab("spawn-1", "spawnAgent"),
                    // A second spawn that names the same thread replays no second copy of it.
                    collab("spawn-2", "spawnAgent"),
                    // A control call neither: it never takes the trail of a thread.
                    collab("wait-1", "wait"),
                    // An activity for a thread a spawn already replayed in full is skipped.
                    {
                        type: "subAgentActivity", id: "activity-1", kind: "started",
                        agentThreadId: "child-history", agentPath: "/root/weather",
                    },
                    message("root-message", "Root work after the sub-agent"),
                ],
            }],
        } as unknown as Thread;
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread: root, model: model.id, modelProvider: "openai", cwd: "/workspace",
            approvalPolicy: "never", sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread: root});
        appServer.threadRead = vi.fn().mockImplementation(({threadId}) =>
            Promise.resolve({thread: threadId === "child-history" ? child : root}));

        await agent.initialize({protocolVersion: 1, clientCapabilities: {_meta: {"subagent-transcript": true}}});
        await agent.loadSession({sessionId: root.id, cwd: "/workspace", mcpServers: []});

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0]);
        const indexOf = (predicate: (update: any) => boolean) =>
            updates.findIndex(({update}) => predicate(update));
        const cardIndex = indexOf(update => update.toolCallId === "spawn-1" && update.sessionUpdate === "tool_call");
        const commandIndex = indexOf(update => update.toolCallId === "child-command-1");
        const firstTurnIndex = indexOf(update => update.messageId === "child-message-1");
        const secondTurnIndex = indexOf(update => update.messageId === "child-message-2");
        const rootMessageIndex = indexOf(update => update.messageId === "root-message");
        // The work of the child follows the card of the spawn, and the thread outlives its spawn:
        // Codex added a turn to it and every turn of it belongs under the same card.
        expect(cardIndex).toBeGreaterThan(-1);
        expect(commandIndex).toBeGreaterThan(cardIndex);
        expect(firstTurnIndex).toBeGreaterThan(commandIndex);
        expect(secondTurnIndex).toBeGreaterThan(firstTurnIndex);
        expect(rootMessageIndex).toBeGreaterThan(secondTurnIndex);
        // The second spawn, the control call and the activity of the same thread replay no
        // second copy of the trail: every turn of the child goes out once.
        expect(updates.filter(({update}) => update.messageId === "child-message-1")).toHaveLength(1);
        expect(updates.filter(({update}) => update.messageId === "child-message-2")).toHaveLength(1);
        // The card of the spawn is the card of the sub-agent.
        expect(updates[cardIndex]?.update._meta?.codex?.subagent).toEqual({
            activity: "spawnAgent", threadId: "child-history",
        });

        const parentOf = (index: number) => updates[index]?.update._meta?.codex?.parentToolCallId;
        expect(parentOf(commandIndex)).toBe("spawn-1");
        expect(parentOf(firstTurnIndex)).toBe("spawn-1");
        expect(parentOf(secondTurnIndex)).toBe("spawn-1");
        expect(parentOf(rootMessageIndex)).toBeUndefined();
        // The activity card of a thread that a spawn already replayed stays empty.
        expect(updates.some(({update}) => update._meta?.codex?.parentToolCallId === "activity-1")).toBe(false);
        // Every replayed update stays on the session of the root thread.
        for (const {sessionId} of updates) expect(sessionId).toBe("root-history");
    });

    it("continues the collaboration trail after the turns an activity already replayed", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});

        const message = (id: string, text: string) => ({
            type: "agentMessage", id, text, phase: null, memoryCitation: null, delivery: null, questions: null,
        });
        const child = {
            id: "child-history",
            historyMode: "legacy",
            turns: [
                {id: "child-turn-1", itemsView: "full", status: "completed", items: [message("child-message-1", "alpha")]},
                {id: "child-turn-2", itemsView: "full", status: "completed", items: [message("child-message-2", "beta")]},
            ],
        } as unknown as Thread;
        const root = {
            id: "root-history",
            historyMode: "legacy",
            turns: [{
                id: "root-turn-1", itemsView: "full", status: "completed", items: [
                    {
                        type: "subAgentActivity", id: "activity-1", kind: "started",
                        agentThreadId: "child-history", agentPath: "/root/weather",
                    },
                    // The spawn names the same thread: the turn the activity replayed is behind it.
                    {
                        type: "collabAgentToolCall", id: "spawn-1", tool: "spawnAgent", status: "completed",
                        senderThreadId: "root-history", receiverThreadIds: ["child-history"],
                        prompt: "Run echo alpha.", model: null, reasoningEffort: null,
                        agentsStates: {"child-history": {status: "completed", message: "beta"}},
                    },
                ],
            }],
        } as unknown as Thread;
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread: root, model: model.id, modelProvider: "openai", cwd: "/workspace",
            approvalPolicy: "never", sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread: root});
        appServer.threadRead = vi.fn().mockImplementation(({threadId}) =>
            Promise.resolve({thread: threadId === "child-history" ? child : root}));

        await agent.initialize({protocolVersion: 1, clientCapabilities: {_meta: {"subagent-transcript": true}}});
        await agent.loadSession({sessionId: root.id, cwd: "/workspace", mcpServers: []});

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0]);
        const indexOf = (predicate: (update: any) => boolean) =>
            updates.findIndex(({update}) => predicate(update));
        const firstTurnIndex = indexOf(update => update.messageId === "child-message-1");
        const secondTurnIndex = indexOf(update => update.messageId === "child-message-2");
        // The turn the activity replayed goes out under its card, the rest under the spawn card,
        // and no turn of the thread goes out twice.
        expect(firstTurnIndex).toBeGreaterThan(-1);
        expect(secondTurnIndex).toBeGreaterThan(firstTurnIndex);
        expect(updates.filter(({update}) => update.messageId === "child-message-1")).toHaveLength(1);
        expect(updates[firstTurnIndex]?.update._meta?.codex?.parentToolCallId).toBe("activity-1");
        expect(updates[secondTurnIndex]?.update._meta?.codex?.parentToolCallId).toBe("spawn-1");
    });

    it("should replay history during loadSession", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

        const model: Model = {
            id: "gpt-5.2",
            model: "gpt-5.2",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            modelSpecialty: null,
            multiAgentVersion: null,
            availableAccessPrograms: null,
            displayName: "GPT-5.2",
            description: "Test model",
            hidden: false,
            supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Medium" },
            ],
            defaultReasoningEffort: "medium",
            inputModalities: ["text", "image"],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
        };

        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [model],
            nextCursor: null,
        });

        const thread: Thread = {
            id: "session-1",
            sessionId: "session-1",
            parentThreadId: null,
            threadSource: null,
            originator: null,
            forkedFromId: null,
            preview: "Hi",
            ephemeral: false,
            modelProvider: "openai",
            model: null,
            reasoningEffort: null,
            createdAt: 123,
            updatedAt: 124,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/test/project",
            cliVersion: "0.0.0",
            section: null,
            sectionEnteredAt: null,
            projectId: null,
            historyMode: "legacy",
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: "Saved title",
            turns: [
                {
                    id: "turn-1",
                    itemsView: "full",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                    items: [
                        {
                            type: "userMessage",
                            id: "item-user-1",
                            clientId: null,
                            content: [
                                { type: "text", text: "Hi", text_elements: [] },
                                { type: "image", url: "https://example.com/image.png" },
                                { type: "image", fileId: "file-saved-image" },
                            ],
                        },
                        {
                            type: "agentMessage",
                            id: "item-agent-1",
                            text: "Hello!",
                            phase: null,
                            memoryCitation: null,
                            delivery: null,
                            questions: null,
                        },
                        {
                            type: "reasoning",
                            id: "item-reason-1",
                            summary: ["Thinking...", "Still thinking..."],
                            content: [],
                        },
                        {
                            type: "commandExecution",
                            id: "item-cmd-1",
                            pluginId: null,
                            scriptPath: null,
                            command: "ls",
                            cwd: "/test/project",
                            processId: null,
                            source: "agent",
                            status: "completed",
                            commandActions: [],
                            aggregatedOutput: "Added.txt\nREADME.md\n",
                            exitCode: 0,
                            durationMs: 5,
                        },
                        {
                            type: "fileChange",
                            id: "item-file-1",
                            changes: [
                                {
                                    path: "/test/project/Added.txt",
                                    kind: { type: "add" },
                                    diff: "Hello\nWorld\n",
                                }
                            ],
                            status: "completed",
                        },
                        {
                            type: "mcpToolCall",
                            id: "item-mcp-1",
                            server: "github",
                            tool: "search",
                            status: "completed",
                            arguments: {},
                            appContext: null,
                            mcpAppUi: null,
                            readOnlyHint: null,
                            pluginId: null,
                            result: null,
                            error: null,
                            durationMs: null,
                        },
                        {
                            type: "dynamicToolCall",
                            id: "item-dyn-1",
                            namespace: null,
                            tool: "list_apps",
                            arguments: { includeDisabled: false },
                            status: "completed",
                            contentItems: [{ type: "inputText", text: "Done" }],
                            success: true,
                            durationMs: 3,
                        },
                        {
                            type: "imageView",
                            id: "item-image-view-1",
                            path: "/test/project/input.png",
                        },
                        {
                            type: "imageGeneration",
                            id: "item-image-generation-1",
                            status: "completed",
                            revisedPrompt: "A tiny blue square",
                            result: "iVBORw0KGgo=",
                            failure: null,
                            savedPath: "/test/project/generated-blue-square.png",
                        },
                        {
                            type: "contextCompaction",
                            id: "item-context-compaction-1",
                        },
                        {
                            type: "subAgentActivity",
                            id: "item-subagent-1",
                            kind: "started",
                            agentThreadId: "thread-child-1",
                            agentPath: "/root/test_audit",
                        },
                    ],
                },
            ],
        };
        const resumeThread: Thread = {
            ...thread,
            turns: thread.turns.map((turn) => ({
                ...turn,
                itemsView: "summary",
                items: turn.items.filter((item) => item.type === "userMessage" || item.type === "agentMessage"),
            })),
        };

        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread: resumeThread,
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });
        codexAppServerClient.threadReadWithHistory = vi.fn().mockResolvedValue({
            thread: thread,
        });
        const goal: ThreadGoal = {
            threadId: thread.id,
            objective: "Keep the restored migration green",
            status: "paused",
            tokenBudget: null,
            tokensUsed: 42,
            timeUsedSeconds: 46,
            createdAt: 1710000000,
            updatedAt: 1710000046,
        };
        codexAppServerClient.threadGoalGet = vi.fn().mockResolvedValue({ goal });

        await codexAcpAgent.initialize({ protocolVersion: 1 });

        const loadParams: acp.LoadSessionRequest = {
            sessionId: thread.id,
            cwd: "/test/project",
            mcpServers: [],
        };
        await codexAcpAgent.loadSession(loadParams);

        expect(codexAppServerClient.threadReadWithHistory).toHaveBeenCalledWith(thread.id);
        expect(codexAppServerClient.threadGoalGet).toHaveBeenCalledWith({ threadId: thread.id });
        await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
            "data/load-session-history.json"
        );
    });

    it("closes the session again when a history page fails after the replay started", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread: {id: "session-1", historyMode: "paginated", turns: [], cwd: "/test/project", name: null, preview: ""},
            itemsBackwardsCursor: "item:last",
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        const message = (id: string) => ({turnId: "turn-1", item: {type: "agentMessage", id, text: id, phase: null, memoryCitation: null, delivery: null, questions: null}});
        appServer.threadItemsList = vi.fn()
            .mockResolvedValueOnce({data: [message("last")], nextCursor: null, backwardsCursor: null})
            .mockResolvedValueOnce({data: [message("first")], nextCursor: "page-2", backwardsCursor: null})
            .mockRejectedValueOnce(new Error("History unavailable"));
        const closeSpy = vi.spyOn(client, "closeSession").mockResolvedValue(undefined as never);

        await agent.initialize({protocolVersion: 1});
        await expect(agent.loadSession({sessionId: "session-1", cwd: "/test/project", mcpServers: []}))
            .rejects.toThrow("History unavailable");

        expect(closeSpy).toHaveBeenCalledWith("session-1");
        expect(() => agent.getSessionState("session-1")).toThrow();
    });

    it("stops the history read when the client closes the session during the load", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread: {id: "session-1", historyMode: "paginated", turns: [], cwd: "/test/project", name: null, preview: ""},
            itemsBackwardsCursor: "item:last",
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        const message = (id: string) => ({turnId: "turn-1", item: {type: "agentMessage", id, text: id, phase: null, memoryCitation: null, delivery: null, questions: null}});
        let closed: Promise<unknown> = Promise.resolve();
        appServer.threadItemsList = vi.fn()
            .mockResolvedValueOnce({data: [message("last")], nextCursor: null, backwardsCursor: null})
            .mockResolvedValueOnce({data: [message("first")], nextCursor: "page-2", backwardsCursor: null})
            .mockResolvedValueOnce({data: [message("second")], nextCursor: "page-3", backwardsCursor: null})
            // The adapter reads this page while it sends the page before it.
            .mockImplementationOnce(async () => {
                closed = agent.closeSession({sessionId: "session-1"});
                await closed;
                return {data: [message("third")], nextCursor: "page-4", backwardsCursor: null};
            })
            .mockResolvedValue({data: [message("more")], nextCursor: "page-4", backwardsCursor: null});
        const closeSpy = vi.spyOn(client, "closeSession").mockResolvedValue(undefined as never);

        await agent.initialize({protocolVersion: 1});
        await expect(agent.loadSession({sessionId: "session-1", cwd: "/test/project", mcpServers: []}))
            .rejects.toMatchObject({code: -32600, data: "Session session-1 is closing"});
        await closed;

        // The page that the close interrupted is the last page read. The load does not close the session again.
        expect(appServer.threadItemsList).toHaveBeenCalledTimes(4);
        expect(closeSpy).toHaveBeenCalledTimes(1);
        const texts = JSON.stringify(fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0]));
        expect(texts).toContain("first");
        expect(texts).not.toContain("second");
        expect(texts).not.toContain("third");
    });

    it("replays image inputs ahead of text (thread/resume reorders content)", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.readAuthRequirement = vi.fn().mockResolvedValue({ required: false, account: null });
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

        const model = createTestModel({ id: "gpt-5.2", displayName: "GPT-5.2" });
        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [model],
            nextCursor: null,
        });

        // The editor's live prompt leads with images, then text — but
        // thread/resume rebuilds userMessage.content with the text input
        // first. Replay must restore the live order or the resumed message
        // renders the picture after the user's text. Pasted images persist
        // as data: URLs (see buildPromptItems) and replay as real ACP image
        // blocks so they land in the editor's leading image row, not as an
        // inline markdown link inside the text.
        const thread: Thread = {
            id: "session-images",
            sessionId: "session-images",
            parentThreadId: null,
            threadSource: null,
            originator: null,
            forkedFromId: null,
            preview: "Hi",
            ephemeral: false,
            modelProvider: "openai",
            model: null,
            reasoningEffort: null,
            section: null,
            sectionEnteredAt: null,
            projectId: null,
            historyMode: "legacy",
            createdAt: 123,
            updatedAt: 124,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/test/project",
            cliVersion: "0.0.0",
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [
                {
                    id: "turn-1",
                    itemsView: "full",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                    items: [
                        {
                            type: "userMessage",
                            id: "item-user-1",
                            clientId: "client-1",
                            content: [
                                { type: "text", text: "Hi", text_elements: [] },
                                { type: "image", url: "data:image/png;base64,iVBORw0KGgo=" },
                                { type: "image", url: "https://example.com/image.png" },
                            ],
                        },
                    ],
                },
            ],
        };
        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread,
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });
        // The legacy history path reads the whole turn list in one call; the
        // plain read serves interruptedTurnTailItemIds' metadata lookup.
        codexAppServerClient.threadReadWithHistory = vi.fn().mockResolvedValue({ thread });
        codexAppServerClient.threadRead = vi.fn().mockResolvedValue({ thread });

        await codexAcpAgent.initialize({ protocolVersion: 1 });
        await codexAcpAgent.loadSession({
            sessionId: thread.id,
            cwd: "/test/project",
            mcpServers: [],
        });

        const userChunks = fixture.getAcpConnectionEvents([])
            .filter((event) => event.method === "sessionUpdate")
            .map((event) => event.args[0].update)
            .filter((update) => update.sessionUpdate === "user_message_chunk");
        expect(userChunks.map((chunk) => chunk.content)).toEqual([
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
            { type: "text", text: "[@image](https://example.com/image.png)" },
            { type: "text", text: "Hi" },
        ]);
    });

    it("should not recover session mcp servers during loadSession when request omits them", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

        const model: Model = {
            id: "gpt-5.2",
            model: "gpt-5.2",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            modelSpecialty: null,
            multiAgentVersion: null,
            availableAccessPrograms: null,
            displayName: "GPT-5.2",
            description: "Test model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
        };

        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [model],
            nextCursor: null,
        });
        const thread: Thread = {
            id: "session-1",
            sessionId: "session-1",
            parentThreadId: null,
            threadSource: null,
            originator: null,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            model: null,
            reasoningEffort: null,
            createdAt: 0,
            updatedAt: 0,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/test/project",
            cliVersion: "0.0.0",
            section: null,
            sectionEnteredAt: null,
            projectId: null,
            historyMode: "legacy",
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
        };
        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread: thread,
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });
        codexAppServerClient.threadReadWithHistory = vi.fn().mockResolvedValue({
            thread: thread,
        });

        await codexAcpAgent.initialize({ protocolVersion: 1 });
        await codexAcpAgent.loadSession({
            sessionId: "session-1",
            cwd: "/test/project",
            mcpServers: [],
        });

        expect(codexAcpAgent.getSessionState("session-1").sessionMcpServers).toEqual([]);
    });

    it("publishes MCP startup failure for explicitly requested servers during loadSession", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

        const model: Model = {
            id: "gpt-5.2",
            model: "gpt-5.2",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            modelSpecialty: null,
            multiAgentVersion: null,
            availableAccessPrograms: null,
            displayName: "GPT-5.2",
            description: "Test model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
        };

        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [model],
            nextCursor: null,
        });
        const thread: Thread = {
            id: "session-1",
            sessionId: "session-1",
            parentThreadId: null,
            threadSource: null,
            originator: null,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            model: null,
            reasoningEffort: null,
            createdAt: 0,
            updatedAt: 0,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/test/project",
            cliVersion: "0.0.0",
            section: null,
            sectionEnteredAt: null,
            projectId: null,
            historyMode: "legacy",
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
        };
        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread: thread,
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });
        codexAppServerClient.threadReadWithHistory = vi.fn().mockResolvedValue({
            thread: thread,
        });

        await codexAcpAgent.initialize({ protocolVersion: 1 });

        const loadPromise = codexAcpAgent.loadSession({
            sessionId: "session-1",
            cwd: "/test/project",
            mcpServers: [{
                name: "broken-mcp",
                command: "npx",
                args: ["broken"],
                env: [],
            }],
        });

        await vi.waitFor(() => {
            expect(codexAcpAgent.getSessionState("session-1").sessionMcpServers).toEqual(["broken-mcp"]);
        });

        fixture.sendServerNotification({
            method: "mcpServer/startupStatus/updated",
            params: { threadId: "session-1", name: "broken-mcp", status: "failed", error: "boom" }
        });

        await loadPromise;

        await vi.waitFor(() => {
            const dump = fixture.getAcpConnectionDump([]);
            expect(dump).toMatch(/"toolCallId": "mcp_startup\.broken-mcp\.[0-9a-f-]{36}"/);
            expect(dump).toContain('MCP server `broken-mcp` failed to start: boom');
        });
    });

    // Fork addition: the editor's MCP panel seeds configured servers as "pending"
    // and needs the full startup outcome (ready servers included — the failure
    // tool_call cards never mention them) to flip the status.
    it("forwards the MCP startup outcome (ready + failed) via _universe/mcp_server_status", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        codexAcpClient.readAuthRequirement = vi.fn().mockResolvedValue({ required: false, account: null });
        codexAcpClient.getAccount = vi.fn().mockResolvedValue({
            account: null,
            requiresOpenaiAuth: false,
        });
        codexAcpClient.listSkills = vi.fn().mockResolvedValue({ data: [] });

        const model: Model = {
            id: "gpt-5.2",
            model: "gpt-5.2",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "GPT-5.2",
            description: "Test model",
            modelSpecialty: null,
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
            defaultReasoningEffort: "medium",
            inputModalities: ["text"],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            multiAgentVersion: null,
            availableAccessPrograms: null,
            isDefault: true,
        };

        codexAppServerClient.listModels = vi.fn().mockResolvedValue({
            data: [model],
            nextCursor: null,
        });
        const thread: Thread = {
            id: "session-1",
            sessionId: "session-1",
            parentThreadId: null,
            threadSource: null,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            section: null,
            sectionEnteredAt: null,
            projectId: null,
            historyMode: "legacy",
            modelProvider: "openai",
            model: model.id,
            reasoningEffort: model.defaultReasoningEffort,
            createdAt: 0,
            updatedAt: 0,
            recencyAt: null,
            status: { type: "idle" },
            path: null,
            cwd: "/test/project",
            cliVersion: "0.0.0",
            originator: null,
            source: "cli",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
        };
        codexAppServerClient.threadResume = vi.fn().mockResolvedValue({
            thread: thread,
            model: model.id,
            modelProvider: "openai",
            cwd: "/test/project",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });
        codexAppServerClient.threadRead = vi.fn().mockResolvedValue({
            thread: thread,
        });

        await codexAcpAgent.initialize({ protocolVersion: 1 });

        const loadPromise = codexAcpAgent.loadSession({
            sessionId: "session-1",
            cwd: "/test/project",
            mcpServers: [{
                name: "good-mcp",
                command: "npx",
                args: ["good"],
                env: [],
            }, {
                name: "broken-mcp",
                command: "npx",
                args: ["broken"],
                env: [],
            }],
        });

        await vi.waitFor(() => {
            expect(codexAcpAgent.getSessionState("session-1").sessionMcpServers).toEqual(["good-mcp", "broken-mcp"]);
        });

        fixture.sendServerNotification({
            method: "mcpServer/startupStatus/updated",
            params: { threadId: "session-1", name: "good-mcp", status: "ready" }
        });
        fixture.sendServerNotification({
            method: "mcpServer/startupStatus/updated",
            params: { threadId: "session-1", name: "broken-mcp", status: "failed", error: "boom" }
        });

        await loadPromise;

        await vi.waitFor(() => {
            const statusEvent = fixture.getAcpConnectionEvents([]).find(
                (event) => event.method === "notify" && event.args[0] === "_universe/mcp_server_status",
            );
            expect(statusEvent?.args[1]).toEqual({
                sessionId: "session-1",
                servers: [
                    { name: "good-mcp", status: "connected" },
                    { name: "broken-mcp", status: "failed" },
                ],
            });
        });
    });

    it("replays the editor's interruption marker after an interrupted turn", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.readAuthRequirement = vi.fn().mockResolvedValue({required: false, account: null});
        client.getAccount = vi.fn().mockResolvedValue({account: null, requiresOpenaiAuth: false});
        client.listSkills = vi.fn().mockResolvedValue({data: []});
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({data: [model], nextCursor: null});
        const turn = (id: string, status: "interrupted" | "completed", items: unknown[]) => ({
            id,
            itemsView: "full",
            status,
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
            items,
        });
        const thread = {
            id: "interrupted-history",
            historyMode: "legacy",
            turns: [
                turn("turn-1", "interrupted", [
                    {type: "userMessage", id: "user-1", clientId: null, content: [{type: "text", text: "cancelled", text_elements: []}]},
                ]),
                turn("turn-2", "completed", [
                    {type: "userMessage", id: "user-2", clientId: null, content: [{type: "text", text: "next", text_elements: []}]},
                    {type: "agentMessage", id: "agent-1", text: "hello", phase: null, memoryCitation: null, delivery: null, questions: null},
                ]),
            ],
        } as unknown as Thread;
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread,
            model: model.id,
            modelProvider: "openai",
            cwd: "/workspace",
            approvalPolicy: "never",
            sandbox: {type: "dangerFullAccess"},
            reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread});
        appServer.threadRead = vi.fn().mockResolvedValue({thread});

        await agent.initialize({protocolVersion: 1, clientCapabilities: {}});
        await agent.loadSession({sessionId: thread.id, cwd: "/workspace", mcpServers: []});

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update);
        const markerIndex = updates.findIndex(update => update.sessionUpdate === "user_message_chunk"
            && update.content?.type === "text" && update.content.text === "[Request interrupted by user]");
        expect(markerIndex).toBeGreaterThan(-1);
        // The marker anchors nothing, so it carries no messageId.
        expect(updates[markerIndex]?.messageId).toBeUndefined();
        // It lands after the interrupted turn's items and before the next turn's replay.
        expect(markerIndex).toBeGreaterThan(updates.findIndex(update => update.messageId === "user-1"));
        expect(markerIndex).toBeLessThan(updates.findIndex(update => update.messageId === "user-2"));
    });

    it("replays a request_user_input rollout pair as a readable question card with the answer", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        const dir = await mkdtemp(join(tmpdir(), "codex-acp-user-input-"));
        try {
            const rolloutPath = await writeRollout(dir, questionTurnRollout({
                callId: "call-ask",
                clientId: "client-ask-1",
                prompt: "使用ask_user工具，考我一道数学的选择题。",
                commentary: "我会用交互式提问工具出一道数学选择题。",
                question: "若 3x + 6 = 24，则 x 等于多少？",
                answer: "6",
                final: "你答对了，x = 6。",
            }));
            client.readAuthRequirement = vi.fn().mockResolvedValue({ required: false, account: null });
            client.getAccount = vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: false });
            client.listSkills = vi.fn().mockResolvedValue({ data: [] });
            const model = createTestModel();
            appServer.listModels = vi.fn().mockResolvedValue({ data: [model], nextCursor: null });
            const thread = {
                id: "question-history",
                historyMode: "legacy",
                path: rolloutPath,
                turns: [{
                    id: "turn-1",
                    itemsView: "full",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                    items: [
                        {
                            type: "userMessage",
                            id: "item-user-1",
                            clientId: "client-ask-1",
                            content: [{ type: "text", text: "使用ask_user工具，考我一道数学的选择题。", text_elements: [] }],
                        },
                        {
                            type: "agentMessage",
                            id: "item-agent-1",
                            text: "我会用交互式提问工具出一道数学选择题。",
                            phase: "commentary",
                            memoryCitation: null,
                            delivery: null,
                            questions: null,
                        },
                        {
                            type: "agentMessage",
                            id: "item-agent-2",
                            text: "你答对了，x = 6。",
                            phase: "final_answer",
                            memoryCitation: null,
                            delivery: null,
                            questions: null,
                        },
                    ],
                }],
            } as unknown as Thread;
            appServer.threadResume = vi.fn().mockResolvedValue({
                thread,
                model: model.id,
                modelProvider: "openai",
                cwd: "/workspace",
                approvalPolicy: "never",
                sandbox: { type: "dangerFullAccess" },
                reasoningEffort: model.defaultReasoningEffort,
            });
            appServer.threadReadWithHistory = vi.fn().mockResolvedValue({ thread });

            await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
            await agent.loadSession({ sessionId: thread.id, cwd: "/workspace", mcpServers: [] });

            const { updates, toolCallIndex, answerIndex } = replayedQuestionUpdates(fixture);
            expect(updates[toolCallIndex]).toMatchObject({
                toolCallId: "call-ask",
                kind: "other",
                title: "若 3x + 6 = 24，则 x 等于多少？",
            });
            // The card lands between the commentary and the final answer, and
            // carries the answers the live card showed.
            const commentaryIndex = updates.findIndex(update => update.sessionUpdate === "agent_message_chunk"
                && update.content?.type === "text" && update.content.text.includes("交互式提问工具"));
            const finalAnswerIndex = updates.findIndex(update => update.sessionUpdate === "agent_message_chunk"
                && update.content?.type === "text" && update.content.text.includes("你答对了"));
            expect(toolCallIndex).toBeGreaterThan(commentaryIndex);
            expect(toolCallIndex).toBeLessThan(finalAnswerIndex);
            expect(updates[answerIndex]).toMatchObject({ toolCallId: "call-ask", status: "completed" });
            expect(JSON.stringify(updates[answerIndex])).toContain("**答案**：6");
            // Exactly the pair the live path publishes: no duplicate card.
            expect(updates.filter(update => update.sessionUpdate === "tool_call")).toHaveLength(1);
            expect(updates.filter(update => update.sessionUpdate === "tool_call_update")).toHaveLength(1);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("replays the question card on the paginated history the editor reads", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        const dir = await mkdtemp(join(tmpdir(), "codex-acp-user-input-paginated-"));
        try {
            const rolloutPath = await writeRollout(dir, questionTurnRollout({
                callId: "call-ask",
                clientId: "client-ask-1",
                prompt: "Ask me a question.",
                commentary: "I will ask a question.",
                question: "Which one?",
                answer: "A",
                final: "It was A.",
            }));
            client.readAuthRequirement = vi.fn().mockResolvedValue({ required: false, account: null });
            client.getAccount = vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: false });
            client.listSkills = vi.fn().mockResolvedValue({ data: [] });
            const model = createTestModel();
            appServer.listModels = vi.fn().mockResolvedValue({ data: [model], nextCursor: null });
            const items: ThreadItem[] = [
                { type: "userMessage", id: "item-user-1", clientId: "client-ask-1", content: [{ type: "text", text: "Ask me a question.", text_elements: [] }] },
                { type: "agentMessage", id: "item-agent-1", text: "I will ask a question.", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
                { type: "agentMessage", id: "item-agent-2", text: "It was A.", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
            ];
            appServer.threadResume = vi.fn().mockResolvedValue({
                thread: { id: "question-paginated", historyMode: "paginated", path: rolloutPath, turns: [] },
                itemsBackwardsCursor: `item:${items[2]!.id}`,
                model: model.id,
                modelProvider: "openai",
                cwd: "/workspace",
                approvalPolicy: "never",
                sandbox: { type: "dangerFullAccess" },
                reasoningEffort: model.defaultReasoningEffort,
            });
            appServer.threadItemsList = vi.fn().mockImplementation(itemListStore(
                items.map(item => ({ turnId: "turn-1", item })),
            ));

            await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
            await agent.loadSession({ sessionId: "question-paginated", cwd: "/workspace", mcpServers: [] });

            const { updates, toolCallIndex, answerIndex } = replayedQuestionUpdates(fixture);
            expect(updates[toolCallIndex]).toMatchObject({ toolCallId: "call-ask", title: "Which one?" });
            const finalAnswerIndex = updates.findIndex(update => update.sessionUpdate === "agent_message_chunk"
                && update.content?.type === "text" && update.content.text === "It was A.");
            expect(toolCallIndex).toBeLessThan(finalAnswerIndex);
            expect(JSON.stringify(updates[answerIndex])).toContain("**答案**：A");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("drops the question cards of the turns a rewind removed from the thread", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        const dir = await mkdtemp(join(tmpdir(), "codex-acp-user-input-rewind-"));
        try {
            const rolloutPath = await writeRollout(dir, [
                ...questionTurnRollout({
                    callId: "call-kept",
                    clientId: "client-kept",
                    prompt: "Kept prompt.",
                    commentary: "Kept commentary.",
                    question: "Kept question?",
                    answer: "A",
                    final: "Kept answer.",
                }),
                ...questionTurnRollout({
                    callId: "call-dropped",
                    clientId: "client-dropped",
                    prompt: "Dropped prompt.",
                    commentary: "Dropped commentary.",
                    question: "Dropped question?",
                    answer: "B",
                    final: "Dropped answer.",
                }),
            ]);
            client.readAuthRequirement = vi.fn().mockResolvedValue({ required: false, account: null });
            client.getAccount = vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: false });
            client.listSkills = vi.fn().mockResolvedValue({ data: [] });
            const model = createTestModel();
            appServer.listModels = vi.fn().mockResolvedValue({ data: [model], nextCursor: null });
            // A rewind truncated the thread to its first turn; the rollout keeps both.
            const thread = {
                id: "question-rewind",
                historyMode: "legacy",
                path: rolloutPath,
                turns: [{
                    id: "turn-1",
                    itemsView: "full",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                    items: [
                        { type: "userMessage", id: "item-user-1", clientId: "client-kept", content: [{ type: "text", text: "Kept prompt.", text_elements: [] }] },
                        { type: "agentMessage", id: "item-agent-1", text: "Kept commentary.", phase: "commentary", memoryCitation: null, delivery: null, questions: null },
                        { type: "agentMessage", id: "item-agent-2", text: "Kept answer.", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
                    ],
                }],
            } as unknown as Thread;
            appServer.threadResume = vi.fn().mockResolvedValue({
                thread,
                model: model.id,
                modelProvider: "openai",
                cwd: "/workspace",
                approvalPolicy: "never",
                sandbox: { type: "dangerFullAccess" },
                reasoningEffort: model.defaultReasoningEffort,
            });
            appServer.threadReadWithHistory = vi.fn().mockResolvedValue({ thread });

            await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
            await agent.loadSession({ sessionId: thread.id, cwd: "/workspace", mcpServers: [] });

            const { updates, toolCallIndex } = replayedQuestionUpdates(fixture);
            expect(updates[toolCallIndex]).toMatchObject({ toolCallId: "call-kept" });
            expect(updates.some(update => update.sessionUpdate === "tool_call" && update.toolCallId === "call-dropped")).toBe(false);
            expect(updates.some(update => update.sessionUpdate === "tool_call_update" && update.toolCallId === "call-dropped")).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("loads a session whose rollout cannot be read, without the question cards", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        client.readAuthRequirement = vi.fn().mockResolvedValue({ required: false, account: null });
        client.getAccount = vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: false });
        client.listSkills = vi.fn().mockResolvedValue({ data: [] });
        const model = createTestModel();
        appServer.listModels = vi.fn().mockResolvedValue({ data: [model], nextCursor: null });
        const thread = {
            id: "question-missing-rollout",
            historyMode: "legacy",
            path: "/workspace/rollout-that-was-deleted.jsonl",
            turns: [{
                id: "turn-1",
                itemsView: "full",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
                items: [{
                    type: "userMessage",
                    id: "item-user-1",
                    clientId: "client-ask-1",
                    content: [{ type: "text", text: "Still replayed.", text_elements: [] }],
                }],
            }],
        } as unknown as Thread;
        appServer.threadResume = vi.fn().mockResolvedValue({
            thread,
            model: model.id,
            modelProvider: "openai",
            cwd: "/workspace",
            approvalPolicy: "never",
            sandbox: { type: "dangerFullAccess" },
            reasoningEffort: model.defaultReasoningEffort,
        });
        appServer.threadReadWithHistory = vi.fn().mockResolvedValue({ thread });

        await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
        await expect(agent.loadSession({ sessionId: thread.id, cwd: "/workspace", mcpServers: [] }))
            .resolves.toBeDefined();

        const { updates } = replayedQuestionUpdates(fixture);
        expect(updates.some(update => update.sessionUpdate === "tool_call")).toBe(false);
        expect(updates.some(update => update.sessionUpdate === "user_message_chunk"
            && update.content?.type === "text" && update.content.text === "Still replayed.")).toBe(true);
    });
});
