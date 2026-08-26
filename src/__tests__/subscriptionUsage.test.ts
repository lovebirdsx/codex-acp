import {describe, expect, it, vi} from "vitest";
import {CodexAcpServer} from "../CodexAcpServer";
import type {AcpClientConnection} from "../ACPSessionConnection";
import type {CodexAcpClient} from "../CodexAcpClient";

/**
 * The editor's usage indicator reads these two through the
 * `universe-editor/subscription_usage` and `universe-editor/consume_reset_credit`
 * ext-methods. The load-bearing detail is `availableCount`: the app-server types
 * it as a Rust u64, so it arrives as a bigint — and `JSON.stringify` throws on
 * bigint, which would take down the whole JSON-RPC response.
 */
function serverWith(codexAcpClient: Partial<CodexAcpClient>): CodexAcpServer {
    return new CodexAcpServer(
        {} as unknown as AcpClientConnection,
        codexAcpClient as CodexAcpClient,
    );
}

function bucket(usedPercent: number) {
    return {
        planType: "plus",
        primary: {usedPercent, windowDurationMins: 300, resetsAt: 1_700_000_000},
        secondary: null,
    };
}

function chatGptAuth() {
    return vi.fn().mockResolvedValue({type: "chat-gpt", email: "user@example.com"});
}

describe("readSubscriptionUsage", () => {
    it("serializes the u64 credit count as a decimal string", async () => {
        const server = serverWith({
            getAuthenticationStatus: chatGptAuth(),
            getRateLimits: vi.fn().mockResolvedValue({
                rateLimits: bucket(40),
                rateLimitsByLimitId: null,
                rateLimitResetCredits: {availableCount: 3n, credits: []},
            }),
        });

        const response = await server.readSubscriptionUsage();

        expect(response.resetCredits).toEqual({availableCount: "3", credits: []});
        // The real failure mode: a leaked bigint takes the whole response down.
        expect(() => JSON.stringify(response)).not.toThrow();
    });

    it("reports supported when any bucket carries a window", async () => {
        const server = serverWith({
            getAuthenticationStatus: chatGptAuth(),
            getRateLimits: vi.fn().mockResolvedValue({
                rateLimits: null,
                rateLimitsByLimitId: {gpt: bucket(10)},
                rateLimitResetCredits: null,
            }),
        });

        const response = await server.readSubscriptionUsage();

        expect(response.supported).toBe(true);
        expect(response.rateLimitsByLimitId).toEqual({gpt: bucket(10)});
        expect(response.resetCredits).toBeNull();
    });

    it("reports unsupported for an API-key account with no windows", async () => {
        const server = serverWith({
            getAuthenticationStatus: chatGptAuth(),
            getRateLimits: vi.fn().mockResolvedValue({
                rateLimits: null,
                rateLimitsByLimitId: null,
                rateLimitResetCredits: null,
            }),
        });

        expect((await server.readSubscriptionUsage()).supported).toBe(false);
    });

    // A leftover `codex login` keeps auth.json's ChatGPT account around, and
    // `account/rateLimits/read` answers from it even when the turn bills to a
    // custom gateway — reporting those windows would show the subscription
    // percentage for a session the plan does not pay for.
    it.each([
        {type: "gateway", name: "codex-gateway"} as const,
        {type: "api-key"} as const,
        {type: "unauthenticated"} as const,
    ])("reports unsupported for $type auth even when the account has windows", async (auth) => {
        const getRateLimits = vi.fn().mockResolvedValue({
            rateLimits: bucket(12),
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
        });
        const server = serverWith({
            getAuthenticationStatus: vi.fn().mockResolvedValue(auth),
            getRateLimits,
        });

        const response = await server.readSubscriptionUsage();

        expect(response.supported).toBe(false);
        expect(response.rateLimits).toBeNull();
        expect(getRateLimits).not.toHaveBeenCalled();
    });

    it("degrades to unsupported instead of failing the request", async () => {
        const server = serverWith({
            getAuthenticationStatus: chatGptAuth(),
            getRateLimits: vi.fn().mockRejectedValue(new Error("app-server is gone")),
        });

        const response = await server.readSubscriptionUsage();

        expect(response).toEqual({
            vendor: "codex",
            supported: false,
            rateLimits: null,
            rateLimitsByLimitId: null,
            resetCredits: null,
        });
    });
});

describe("consumeRateLimitResetCredit", () => {
    it("passes the idempotency key through and returns the backend's outcome", async () => {
        const consume = vi.fn().mockResolvedValue({outcome: "reset"});
        const server = serverWith({consumeRateLimitResetCredit: consume});

        const response = await server.consumeRateLimitResetCredit({idempotencyKey: "  key-1  "});

        expect(consume).toHaveBeenCalledWith({idempotencyKey: "key-1"});
        expect(response).toEqual({outcome: "reset"});
    });

    it("rejects a blank key rather than letting the backend mint a fresh redemption", async () => {
        const consume = vi.fn();
        const server = serverWith({consumeRateLimitResetCredit: consume});

        await expect(server.consumeRateLimitResetCredit({idempotencyKey: "   "})).rejects.toThrow();
        expect(consume).not.toHaveBeenCalled();
    });
});
