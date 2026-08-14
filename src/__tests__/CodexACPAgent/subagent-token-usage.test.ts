import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerNotification } from "../../app-server";
import type { TokenUsageBreakdown } from "../../app-server/v2";
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from "../acp-test-utils";
import type { SessionState } from "../../CodexAcpServer";
import type { QuotaMeta } from "../../QuotaMeta";
import type { UpdateSessionEvent } from "../../ACPSessionConnection";

const sessionId = "test-session-id";

function breakdown(
    totalTokens: number,
    inputTokens: number,
    cachedInputTokens: number,
    outputTokens: number,
    reasoningOutputTokens: number,
): TokenUsageBreakdown {
    return { totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens: 0, outputTokens, reasoningOutputTokens };
}

function tokenUsageNotification(
    threadId: string,
    total: TokenUsageBreakdown,
    last: TokenUsageBreakdown,
    modelContextWindow: number | null,
): ServerNotification {
    return {
        method: "thread/tokenUsage/updated",
        params: { threadId, turnId: "turn-id", tokenUsage: { total, last, modelContextWindow } },
    };
}

function subAgentActivityStarted(agentThreadId: string, itemId: string): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId: sessionId,
            turnId: "turn-id",
            startedAtMs: 0,
            item: {
                type: "subAgentActivity",
                id: itemId,
                kind: "started",
                agentThreadId,
                agentPath: "/root/subagent",
            },
        },
    };
}

function collabAgentToolCallStarted(receiverThreadIds: string[], itemId: string): ServerNotification {
    return {
        method: "item/started",
        params: {
            threadId: sessionId,
            turnId: "turn-id",
            startedAtMs: 0,
            item: {
                type: "collabAgentToolCall",
                id: itemId,
                tool: "spawnAgent",
                status: "inProgress",
                senderThreadId: sessionId,
                receiverThreadIds,
                prompt: "go",
                model: null,
                reasoningEffort: null,
                agentsStates: {},
            },
        },
    };
}

function mainTotal(): TokenUsageBreakdown {
    return breakdown(5000, 4000, 1000, 900, 100);
}

function mainLast(): TokenUsageBreakdown {
    return breakdown(2500, 2000, 500, 450, 50);
}

function mainTokenUsageNotification(): ServerNotification {
    return tokenUsageNotification(sessionId, mainTotal(), mainLast(), 128000);
}

function subAgentTokenUsage(threadId: string, total: TokenUsageBreakdown): ServerNotification {
    return tokenUsageNotification(threadId, total, total, 128000);
}

async function setupPrompt(mockFixture: CodexMockTestFixture, sessionState: SessionState): Promise<void> {
    const codexAcpAgent = mockFixture.getCodexAcpAgent();
    mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
        turn: { id: "turn-id", items: [], status: "inProgress", error: null }
    });
    mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue({
        threadId: sessionId,
        turn: { id: "turn-id", items: [], status: "completed", error: null }
    });
    vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);
    await codexAcpAgent.prompt({ sessionId, prompt: [{ type: "text", text: "test prompt" }] });
    mockFixture.clearAcpConnectionDump();
}

async function sendAndDrain(
    mockFixture: CodexMockTestFixture,
    ...notifications: ServerNotification[]
): Promise<void> {
    for (const notification of notifications) {
        mockFixture.sendServerNotification(notification);
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
    }
}

function updates(mockFixture: CodexMockTestFixture): UpdateSessionEvent[] {
    return mockFixture.getAcpConnectionEvents([]).map(
        (event) => (event as unknown as { args: [{ update: UpdateSessionEvent }] }).args[0].update
    );
}

describe("CodexEventHandler - sub-agent token usage", () => {
    let mockFixture: CodexMockTestFixture;
    let sessionState: SessionState;

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
        sessionState = createTestSessionState({ sessionId });
    });

    it("folds sub-agent usage into usage_update quota while keeping used/size on the main thread", async () => {
        await setupPrompt(mockFixture, sessionState);
        await sendAndDrain(
            mockFixture,
            mainTokenUsageNotification(),
            subAgentActivityStarted("thread-sub", "sub-activity-1"),
            subAgentTokenUsage("thread-sub", breakdown(1000, 800, 200, 300, 50)),
        );

        const usageUpdates = updates(mockFixture).filter((u) => u.sessionUpdate === "usage_update");
        expect(usageUpdates).toHaveLength(2);

        const subUsageUpdate = usageUpdates[1] as Extract<UpdateSessionEvent, { sessionUpdate: "usage_update" }>;
        expect(subUsageUpdate.used).toBe(2500);
        expect(subUsageUpdate.size).toBe(128000);
        const quota = (subUsageUpdate._meta as { quota: { token_count: { totalTokens: number, inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningOutputTokens: number } } }).quota;
        expect(quota.token_count).toEqual({
            totalTokens: 6000,
            inputTokens: 3600,
            cachedInputTokens: 1200,
            outputTokens: 1200,
            reasoningOutputTokens: 150,
        });

        // Sub-agent usage must not pollute the main thread's turn/token state.
        expect(sessionState.currentTurnId).toBeNull();
        expect(sessionState.lastTokenUsage).toEqual({
            totalTokens: 2500,
            inputTokens: 1500,
            cachedInputTokens: 500,
            outputTokens: 450,
            reasoningOutputTokens: 50,
        });
        expect(sessionState.totalTokenUsage).toEqual({
            totalTokens: 5000,
            inputTokens: 3000,
            cachedInputTokens: 1000,
            outputTokens: 900,
            reasoningOutputTokens: 100,
        });
    });

    it("keeps the latest snapshot per sub-agent thread and adds across threads", async () => {
        await setupPrompt(mockFixture, sessionState);
        await sendAndDrain(
            mockFixture,
            mainTokenUsageNotification(),
            subAgentActivityStarted("thread-sub-1", "sub-activity-1"),
            subAgentActivityStarted("thread-sub-2", "sub-activity-2"),
            subAgentTokenUsage("thread-sub-1", breakdown(1000, 800, 200, 300, 50)),
            subAgentTokenUsage("thread-sub-1", breakdown(2000, 1500, 300, 600, 100)),
            subAgentTokenUsage("thread-sub-2", breakdown(400, 300, 100, 150, 0)),
        );

        const lastUsageUpdate = updates(mockFixture)
            .filter((u) => u.sessionUpdate === "usage_update")
            .at(-1) as Extract<UpdateSessionEvent, { sessionUpdate: "usage_update" }>;
        const quota = (lastUsageUpdate._meta as { quota: { token_count: { totalTokens: number } } }).quota;
        // 5000 (main) + 2000 (latest sub-1, not 1000) + 400 (sub-2)
        expect(quota.token_count.totalTokens).toBe(7400);
        expect(sessionState.subagentTokenUsage.size).toBe(2);
        expect(sessionState.subagentTokenUsage.get("thread-sub-1")?.totalTokens).toBe(2000);
        expect(sessionState.subagentTokenUsage.get("thread-sub-2")?.totalTokens).toBe(400);
    });

    it("subscribes on subAgentActivity start and stamps stats onto its card", async () => {
        await setupPrompt(mockFixture, sessionState);
        const onServerNotificationSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "onServerNotification");

        await sendAndDrain(mockFixture, subAgentActivityStarted("thread-sub", "sub-activity-1"));

        expect(onServerNotificationSpy.mock.calls.some(([threadId]) => threadId === "thread-sub")).toBe(true);

        await sendAndDrain(mockFixture, subAgentTokenUsage("thread-sub", breakdown(1000, 800, 200, 300, 50)));

        const toolCallUpdates = updates(mockFixture).filter((u) => u.sessionUpdate === "tool_call_update");
        expect(toolCallUpdates).toHaveLength(1);
        const statsUpdate = toolCallUpdates[0] as Extract<UpdateSessionEvent, { sessionUpdate: "tool_call_update" }>;
        expect(statsUpdate.toolCallId).toBe("sub-activity-1");
        expect(statsUpdate._meta).toEqual({
            "_universe/subagentStats": {
                inputTokens: 600,
                outputTokens: 300,
                cacheReadTokens: 200,
                cacheCreateTokens: 0,
            },
        });
    });

    it("subscribes on collabAgentToolCall receiverThreadIds without emitting a stats card", async () => {
        await setupPrompt(mockFixture, sessionState);
        const onServerNotificationSpy = vi.spyOn(mockFixture.getCodexAppServerClient(), "onServerNotification");

        await sendAndDrain(
            mockFixture,
            mainTokenUsageNotification(),
            collabAgentToolCallStarted(["thread-collab-1", "thread-collab-2"], "collab-1"),
        );

        expect(onServerNotificationSpy.mock.calls.some(([threadId]) => threadId === "thread-collab-1")).toBe(true);
        expect(onServerNotificationSpy.mock.calls.some(([threadId]) => threadId === "thread-collab-2")).toBe(true);

        await sendAndDrain(mockFixture, subAgentTokenUsage("thread-collab-1", breakdown(500, 400, 100, 200, 0)));

        // Collab cards carry no per-thread stats: only the session aggregate moves.
        const usageUpdates = updates(mockFixture).filter((u) => u.sessionUpdate === "usage_update");
        expect(usageUpdates).toHaveLength(2);
        const toolCallUpdates = updates(mockFixture).filter((u) => u.sessionUpdate === "tool_call_update");
        expect(toolCallUpdates).toHaveLength(0);
        const lastUsageUpdate = usageUpdates.at(-1) as Extract<UpdateSessionEvent, { sessionUpdate: "usage_update" }>;
        const quota = (lastUsageUpdate._meta as { quota: { token_count: { totalTokens: number } } }).quota;
        expect(quota.token_count.totalTokens).toBe(5500);
    });

    it("keeps sub-agent usage in later main-thread usage updates", async () => {
        await setupPrompt(mockFixture, sessionState);
        await sendAndDrain(
            mockFixture,
            mainTokenUsageNotification(),
            subAgentActivityStarted("thread-sub", "sub-activity-1"),
            subAgentTokenUsage("thread-sub", breakdown(1000, 800, 200, 300, 50)),
        );

        await sendAndDrain(
            mockFixture,
            tokenUsageNotification(sessionId, breakdown(6000, 4500, 1200, 1000, 150), breakdown(3000, 2500, 600, 500, 100), 128000),
        );

        const usageUpdates = updates(mockFixture).filter((u) => u.sessionUpdate === "usage_update");
        const lastUsageUpdate = usageUpdates.at(-1) as Extract<UpdateSessionEvent, { sessionUpdate: "usage_update" }>;
        const quota = (lastUsageUpdate._meta as { quota: { token_count: { totalTokens: number } } }).quota;
        // 6000 (main) + 1000 (sub)
        expect(quota.token_count.totalTokens).toBe(7000);
        expect(lastUsageUpdate.used).toBe(3000);
    });

    it("reports aggregated quota on the prompt response", async () => {
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        });
        mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
            mockFixture.sendServerNotification(mainTokenUsageNotification());
            await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
            mockFixture.sendServerNotification(subAgentActivityStarted("thread-sub", "sub-activity-1"));
            await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
            mockFixture.sendServerNotification(subAgentTokenUsage("thread-sub", breakdown(1000, 800, 200, 300, 50)));
            await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
            return {
                threadId: sessionId,
                turn: { id: "turn-id", items: [], status: "completed", error: null }
            };
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        const response = await codexAcpAgent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "test prompt" }],
        });

        const quota = (response._meta as { quota?: QuotaMeta } | undefined)?.quota;
        expect(quota?.token_count).toEqual({
            totalTokens: 6000,
            inputTokens: 3600,
            cachedInputTokens: 1200,
            outputTokens: 1200,
            reasoningOutputTokens: 150,
        });
        expect(quota?.model_usage).toEqual([{
            model: "model-id",
            token_count: {
                totalTokens: 6000,
                inputTokens: 3600,
                cachedInputTokens: 1200,
                outputTokens: 1200,
                reasoningOutputTokens: 150,
            },
        }]);
    });

    it("ignores broadcast notifications without a threadId", async () => {
        await setupPrompt(mockFixture, sessionState);
        await sendAndDrain(
            mockFixture,
            mainTokenUsageNotification(),
            subAgentActivityStarted("thread-sub", "sub-activity-1"),
        );

        const usageUpdateCountBefore = updates(mockFixture).filter((u) => u.sessionUpdate === "usage_update").length;

        await sendAndDrain(
            mockFixture,
            {
                method: "account/rateLimits/updated",
                params: {
                    rateLimits: {
                        limitId: "x",
                        limitName: "x",
                        primary: null,
                        secondary: null,
                        credits: null,
                        individualLimit: null,
                        spendControlReached: null,
                        planType: null,
                        rateLimitReachedType: null,
                    },
                },
            },
        );

        expect(sessionState.subagentTokenUsage.size).toBe(0);
        expect(updates(mockFixture).filter((u) => u.sessionUpdate === "usage_update")).toHaveLength(usageUpdateCountBefore);
        expect(updates(mockFixture).filter((u) => u.sessionUpdate === "tool_call_update")).toHaveLength(0);
    });

    it("only records sub-agent usage until the main thread reports usage", async () => {
        await setupPrompt(mockFixture, sessionState);
        await sendAndDrain(
            mockFixture,
            subAgentActivityStarted("thread-sub", "sub-activity-1"),
            subAgentTokenUsage("thread-sub", breakdown(1000, 800, 200, 300, 50)),
        );

        // Main usage is still unknown: no usage_update, only the stats card.
        expect(updates(mockFixture).filter((u) => u.sessionUpdate === "usage_update")).toHaveLength(0);
        expect(updates(mockFixture).filter((u) => u.sessionUpdate === "tool_call_update")).toHaveLength(1);
        expect(sessionState.subagentTokenUsage.get("thread-sub")?.totalTokens).toBe(1000);

        await sendAndDrain(mockFixture, mainTokenUsageNotification());

        const usageUpdates = updates(mockFixture).filter((u) => u.sessionUpdate === "usage_update");
        expect(usageUpdates).toHaveLength(1);
        const usageUpdate = usageUpdates[0] as Extract<UpdateSessionEvent, { sessionUpdate: "usage_update" }>;
        const quota = (usageUpdate._meta as { quota: { token_count: { totalTokens: number } } }).quota;
        // 5000 (main) + 1000 (sub)
        expect(quota.token_count.totalTokens).toBe(6000);
    });
});
