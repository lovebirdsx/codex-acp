import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture} from "../acp-test-utils";
import {
    EXTENSION_METHOD_REGISTRATIONS,
    SET_SESSION_TITLE_METHOD,
    isExtMethodRequest,
} from "../../AcpExtensions";
import type {Thread} from "../../app-server/v2";

const sessionId = "sess-1";

function makeThread(overrides: Partial<Thread> = {}): Thread {
    return {
        id: sessionId,
        sessionId,
        parentThreadId: null,
        threadSource: null,
        forkedFromId: null,
        preview: "First user message",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 100,
        updatedAt: 200,
        recencyAt: null,
        status: {type: "idle"},
        path: null,
        cwd: "/repo/project",
        cliVersion: "0.0.0",
        source: "cli",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
        ...overrides,
    };
}

describe("universe-editor/set_session_title", () => {
    it("persists the AI title to the agent via thread/name/set", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const threadSetName = vi
            .spyOn(codexAppServerClient, "threadSetName")
            .mockResolvedValue({});

        const result = await codexAcpAgent.extMethod(SET_SESSION_TITLE_METHOD, {
            sessionId,
            title: "  Fix login bug  ",
        });

        expect(result).toEqual({});
        expect(threadSetName).toHaveBeenCalledWith({threadId: sessionId, name: "Fix login bug"});
    });

    it("rejects an empty / whitespace-only title without touching the agent", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const threadSetName = vi
            .spyOn(codexAppServerClient, "threadSetName")
            .mockResolvedValue({});

        await expect(
            codexAcpAgent.extMethod(SET_SESSION_TITLE_METHOD, {sessionId, title: "   "}),
        ).rejects.toThrow("Invalid params");
        expect(threadSetName).not.toHaveBeenCalled();
    });

    it("rejects malformed params without touching the agent", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAppServerClient = fixture.getCodexAppServerClient();
        const threadSetName = vi
            .spyOn(codexAppServerClient, "threadSetName")
            .mockResolvedValue({});

        await expect(
            codexAcpAgent.extMethod(SET_SESSION_TITLE_METHOD, {sessionId}),
        ).rejects.toThrow("Invalid params");
        expect(threadSetName).not.toHaveBeenCalled();
    });

    // Cross-workspace regression: once the title is persisted, session/list
    // reports `thread.name` from any workspace instead of falling back to
    // `thread.preview` (the first user message). This is the behaviour the bug
    // lacked for codex — the AI title only lived in the originating workspace.
    it("makes the persisted title win over the first-prompt preview in session/list", async () => {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const codexAppServerClient = fixture.getCodexAppServerClient();

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);

        let storedName: string | null = null;
        vi.spyOn(codexAppServerClient, "threadSetName").mockImplementation(async (params) => {
            storedName = params.name;
            return {};
        });
        vi.spyOn(codexAppServerClient, "threadList").mockImplementation(async () => ({
            data: [makeThread({name: storedName})],
            nextCursor: null,
            backwardsCursor: null,
        }));

        const before = await codexAcpAgent.listSessions({cwd: null, cursor: null});
        expect(before.sessions[0]?.title).toBe("First user message");

        await codexAcpAgent.extMethod(SET_SESSION_TITLE_METHOD, {
            sessionId,
            title: "Fix login bug",
        });

        const after = await codexAcpAgent.listSessions({cwd: null, cursor: null});
        expect(after.sessions[0]?.title).toBe("Fix login bug");
    });
});

// The original bug: the ext-method existed on the server but was never wired
// into the ACP request router (index.ts), so the SDK rejected it with
// methodNotFound before it reached `extMethod`. index.ts now registers every
// entry of EXTENSION_METHOD_REGISTRATIONS in a loop, so this guards the wiring.
describe("extension method registration", () => {
    it("registers set_session_title so the ACP router can route it", () => {
        const methods = EXTENSION_METHOD_REGISTRATIONS.map((r) => r.method);
        expect(methods).toContain(SET_SESSION_TITLE_METHOD);
    });

    it("only registers methods that isExtMethodRequest accepts", () => {
        for (const {method} of EXTENSION_METHOD_REGISTRATIONS) {
            expect(isExtMethodRequest({method, params: {}})).toBe(true);
        }
    });

    it("validates set_session_title params with its registered parser", () => {
        const reg = EXTENSION_METHOD_REGISTRATIONS.find(
            (r) => r.method === SET_SESSION_TITLE_METHOD,
        );
        expect(reg).toBeDefined();
        expect(reg!.parser.safeParse({sessionId, title: "Greeting"}).success).toBe(true);
        expect(reg!.parser.safeParse({sessionId}).success).toBe(false);
    });
});
