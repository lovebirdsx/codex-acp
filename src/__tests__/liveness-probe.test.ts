import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {CodexEventHandler} from "../CodexEventHandler";
import type {AcpClientConnection} from "../ACPSessionConnection";
import type {ServerNotification} from "../app-server";
import type {Turn} from "../app-server/v2";
import {createTestSessionState} from "./acp-test-utils";

const SESSION_ID = "session-id";
const PROBE_INTERVAL_MS = 30_000;

function createTurn(turnId: string, status: Turn["status"]): Turn {
    return {
        id: turnId,
        items: [],
        itemsView: "full",
        status,
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
    };
}

function turnNotification(method: "turn/started" | "turn/completed", turnId: string): ServerNotification {
    return {
        method,
        params: {
            threadId: SESSION_ID,
            turn: createTurn(turnId, method === "turn/started" ? "inProgress" : "completed"),
        },
    };
}

function threadNameNotification(): ServerNotification {
    return {
        method: "thread/name/updated",
        params: {threadId: SESSION_ID, threadName: "renamed"},
    };
}

describe("CodexEventHandler liveness probe", () => {
    let notify: ReturnType<typeof vi.fn>;
    let connection: AcpClientConnection;

    beforeEach(() => {
        vi.useFakeTimers();
        notify = vi.fn().mockResolvedValue(undefined);
        connection = {notify, request: vi.fn()} as unknown as AcpClientConnection;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function createHandler(probeLiveness?: () => Promise<unknown>) {
        return new CodexEventHandler(
            connection,
            createTestSessionState({sessionId: SESSION_ID}),
            false,
            probeLiveness,
        );
    }

    function livenessPingCount(): number {
        return notify.mock.calls.filter(
            (call) => call[0] === "_universe/liveness_ping",
        ).length;
    }

    it("sends the ping as a custom notification, not a session/update variant", async () => {
        // The ACP SDK zod-validates session/update params against the
        // SessionUpdate union before dispatching; a private variant there is
        // rejected at the client and never reaches the editor's handler (the
        // "Error handling notification / Invalid params" production bug).
        // The ping must ride the sanctioned custom-method channel instead,
        // which the editor receives via its extNotification hook.
        const probe = vi.fn().mockResolvedValue({});
        const handler = createHandler(probe);

        await handler.handleNotification(turnNotification("turn/started", "turn-1"));
        await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);

        expect(livenessPingCount()).toBe(1);
        const call = notify.mock.calls.find((c) => c[0] === "_universe/liveness_ping");
        expect(call?.[1]).toEqual({sessionId: SESSION_ID});
        // No session/update notification may carry the private variant.
        const sessionUpdates = notify.mock.calls.filter((c) => c[0] === "session/update");
        for (const [, params] of sessionUpdates) {
            expect((params as {update: {sessionUpdate: string}}).update.sessionUpdate).not.toBe(
                "_universe/liveness_ping",
            );
        }

        await handler.dispose();
    });

    it("forwards a liveness ping after a silent interval during a running turn", async () => {
        const probe = vi.fn().mockResolvedValue({});
        const handler = createHandler(probe);

        await handler.handleNotification(turnNotification("turn/started", "turn-1"));
        expect(probe).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);

        expect(probe).toHaveBeenCalledTimes(1);
        expect(livenessPingCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(livenessPingCount()).toBe(2);

        await handler.dispose();
    });

    it("does not ping when the probe rejects", async () => {
        const probe = vi.fn().mockRejectedValue(new Error("core wedged"));
        const handler = createHandler(probe);

        await handler.handleNotification(turnNotification("turn/started", "turn-1"));
        await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 2);

        expect(probe).toHaveBeenCalledTimes(2);
        expect(livenessPingCount()).toBe(0);

        await handler.dispose();
    });

    it("does not ping when the probe times out", async () => {
        const probe = vi.fn().mockReturnValue(new Promise(() => {}));
        const handler = createHandler(probe);

        await handler.handleNotification(turnNotification("turn/started", "turn-1"));
        // Fire the probe, then advance past the 10s probe timeout.
        await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS + 15_000);

        expect(probe).toHaveBeenCalledTimes(1);
        expect(livenessPingCount()).toBe(0);

        await handler.dispose();
    });

    it("stays quiet while real traffic keeps the wire busy", async () => {
        const probe = vi.fn().mockResolvedValue({});
        const handler = createHandler(probe);

        await handler.handleNotification(turnNotification("turn/started", "turn-1"));
        await vi.advanceTimersByTimeAsync(20_000);
        await handler.handleNotification(threadNameNotification());
        // Tick at t=30s sees only 10s of silence since the real forward.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(probe).not.toHaveBeenCalled();
        expect(livenessPingCount()).toBe(0);

        // Silence reaches the full interval at the t=60s tick.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(livenessPingCount()).toBe(1);

        await handler.dispose();
    });

    it("stops probing when the turn completes", async () => {
        const probe = vi.fn().mockResolvedValue({});
        const handler = createHandler(probe);

        await handler.handleNotification(turnNotification("turn/started", "turn-1"));
        await handler.handleNotification(turnNotification("turn/completed", "turn-1"));
        await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);

        expect(probe).not.toHaveBeenCalled();
        expect(livenessPingCount()).toBe(0);

        await handler.dispose();
    });

    it("stops probing on dispose", async () => {
        const probe = vi.fn().mockResolvedValue({});
        const handler = createHandler(probe);

        await handler.handleNotification(turnNotification("turn/started", "turn-1"));
        await handler.dispose();
        await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 3);

        expect(probe).not.toHaveBeenCalled();
        expect(livenessPingCount()).toBe(0);
    });

    it("does not ping if the turn completed while the probe was in flight", async () => {
        let resolveProbe: (value: unknown) => void = () => {};
        const probe = vi.fn().mockReturnValue(new Promise((resolve) => {
            resolveProbe = resolve;
        }));
        const handler = createHandler(probe);

        await handler.handleNotification(turnNotification("turn/started", "turn-1"));
        await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
        expect(probe).toHaveBeenCalledTimes(1);

        await handler.handleNotification(turnNotification("turn/completed", "turn-1"));
        resolveProbe({});
        await vi.advanceTimersByTimeAsync(0);

        expect(livenessPingCount()).toBe(0);

        await handler.dispose();
    });
});
