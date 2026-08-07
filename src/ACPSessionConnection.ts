import * as acp from "@agentclientprotocol/sdk";
import type {SessionNotification} from "@agentclientprotocol/sdk";

export type AcpClientConnection = Pick<acp.AgentContext, "notify" | "request">;

export class ACPSessionConnection {
    private readonly connection: AcpClientConnection;
    readonly sessionId: string;

    constructor(connection: AcpClientConnection, sessionId: string) {
        this.connection = connection;
        this.sessionId = sessionId;
    }

    async update(update: UpdateSessionEvent) {
        await this.connection.notify(acp.methods.client.session.update, {
            sessionId: this.sessionId,
            update: update
        });
    }

    /*
     * Fork addition: proof-of-life notification carrying no content, sent as a
     * custom `_universe/liveness_ping` notification. The SDK zod-validates
     * session/update against the SessionUpdate union, so a private variant
     * there never reaches the client's handler — the editor listens for this
     * method via its extNotification hook (the SDK's sanctioned channel for
     * custom `_`-prefixed methods) and resets the stall watchdog's silence
     * window from it. Content-free by design: it must NOT clobber real
     * session state the way a synthetic usage_update (zeros over the real
     * usage readout) or tool_call_update (needs an emitted toolCallId) would.
     */
    async livenessPing() {
        await this.connection.notify(LIVENESS_PING_METHOD, {
            sessionId: this.sessionId,
        });
    }
}

export type UpdateSessionEvent = SessionNotification["update"];

// Duplicated verbatim in the editor's acpExtMethods.ts (ACP_EXT_METHODS).
export const LIVENESS_PING_METHOD = "_universe/liveness_ping";
