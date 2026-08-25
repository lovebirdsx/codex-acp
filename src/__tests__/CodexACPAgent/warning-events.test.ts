import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerNotification } from "../../app-server";
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from "../acp-test-utils";

function createWarningNotification(sessionId: string, message: string): ServerNotification {
    return {
        method: "warning",
        params: {
            threadId: sessionId,
            message,
        },
    };
}

describe("CodexEventHandler - warning events", () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = "test-session-id";

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    function setupPromptAndReturnEvents(notifications: ServerNotification[]) {
        const codexAcpAgent = mockFixture.getCodexAcpAgent();

        mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null },
        });
        mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
            for (const notification of notifications) {
                mockFixture.sendServerNotification(notification);
            }
            return {
                threadId: sessionId,
                turn: { id: "turn-id", items: [], status: "completed", error: null },
            };
        });

        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(createTestSessionState({ sessionId }));

        return async () => {
            await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: "text", text: "test prompt" }],
            });
            return mockFixture.getAcpConnectionEvents([]);
        };
    }

    it("drops the model-metadata fallback warning so it never floods the session", async () => {
        const events = await setupPromptAndReturnEvents([
            createWarningNotification(
                sessionId,
                "Model metadata for deepseek-v4-flash not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
            ),
        ])();

        const sessionUpdates = events.filter((e) => e.method === "sessionUpdate");
        expect(sessionUpdates).toEqual([]);
    });

    it("renders an unrelated warning as an agent message chunk", async () => {
        const events = await setupPromptAndReturnEvents([
            createWarningNotification(sessionId, "Something unexpected happened."),
        ])();

        const sessionUpdates = events.filter((e) => e.method === "sessionUpdate");
        expect(sessionUpdates.length).toBeGreaterThan(0);
        const dump = JSON.stringify(sessionUpdates);
        expect(dump).toContain("Warning: Something unexpected happened.");
    });
});
