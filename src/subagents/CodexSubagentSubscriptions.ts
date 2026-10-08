import type {
    ApprovalHandler,
    CodexAppServerClient,
    ElicitationHandler,
} from "../CodexAppServerClient";
import type {ServerNotification} from "../app-server";
import {isRootAgentPath} from "./CodexAgentPath";
import {isChildTranscriptNotification} from "./ChildTranscript";

type Subscription = {
    rootSessionId: string;
    supportsSubagents: boolean;
    /** Fork addition: the client reads the work of a sub-agent without native subagent sessions. */
    subagentTranscript: boolean;
    dispatch(event: ServerNotification): void;
    /** Fork addition: forwards the work of a direct child on the root session. */
    dispatchChild(event: ServerNotification): void;
    enqueueInteraction(event: ServerNotification): void;
    approvalHandler: ApprovalHandler;
    elicitationHandler: ElicitationHandler;
    waitForRootNotifications(): Promise<void>;
    waitForChildSession(childThreadId: string): Promise<string | null>;
};

type SessionSubscription = {
    current: Subscription;
    children: Set<string>;
};

/** Discovers child threads and keeps their output/interaction boundary negotiated. */
export class CodexSubagentSubscriptions {
    private readonly sessions = new Map<string, SessionSubscription>();

    constructor(private readonly client: CodexAppServerClient) {}

    subscribe(subscription: Subscription): void {
        const existing = this.sessions.get(subscription.rootSessionId);
        if (existing) {
            existing.current = subscription;
            return;
        }

        const session = {current: subscription, children: new Set<string>()};
        this.sessions.set(subscription.rootSessionId, session);
        this.client.onServerNotification(subscription.rootSessionId, (event) => {
            // Register synchronously: app-server may emit child output directly
            // after the spawning collaboration item.
            this.discover(session, event, 0);
            session.current.dispatch(event);
        });
        this.registerInteractiveHandlers(session, subscription.rootSessionId);
    }

    clear(rootSessionId: string): void {
        for (const childSessionId of this.sessions.get(rootSessionId)?.children ?? []) {
            this.client.clearThreadHandlers(childSessionId);
        }
        this.sessions.delete(rootSessionId);
    }

    private discover(session: SessionSubscription, event: ServerNotification, depth: number): void {
        if (event.method !== "item/started" && event.method !== "item/completed") {
            return;
        }
        const item = event.params.item;
        const childSessionIds = item.type === "collabAgentToolCall" && item.tool === "spawnAgent"
            ? item.receiverThreadIds
            : item.type === "subAgentActivity" && item.kind !== "interrupted" && !isRootAgentPath(item.agentPath)
                ? [item.agentThreadId]
                : [];
        for (const childSessionId of childSessionIds) {
            if (childSessionId.trim() === "") continue;
            if (childSessionId === session.current.rootSessionId
                || childSessionId === event.params.threadId
                || session.children.has(childSessionId)) {
                continue;
            }
            session.children.add(childSessionId);
            this.client.onServerNotification(childSessionId, (childEvent) => {
                const eventThreadId = (childEvent.params as {threadId?: unknown}).threadId;
                if (eventThreadId !== childSessionId) return;
                this.discover(session, childEvent, depth + 1);
                // Fork addition: child token usage always reaches the session
                // handler so the parent session can price sub-agent work; the
                // legacy branch below hides every other child notification.
                if (session.current.supportsSubagents || childEvent.method === "thread/tokenUsage/updated") {
                    session.current.dispatch(childEvent);
                }
                // Fork addition: the work of a direct child, for a client that reads the
                // sub-agent trail. A grandchild keeps the legacy representation: the trail
                // of a client without native subagent sessions is one level deep.
                else if (depth === 0
                    && session.current.subagentTranscript
                    && isChildTranscriptNotification(childEvent)) {
                    session.current.dispatchChild(childEvent);
                }
                else session.current.enqueueInteraction(this.rootAttributed(childEvent, session.current.rootSessionId));
            });
            // Hidden children keep only root-attributed permission requests.
            this.registerInteractiveHandlers(session, childSessionId);
        }
    }

    private registerInteractiveHandlers(session: SessionSubscription, targetSessionId: string): void {
        this.client.onApprovalRequest(targetSessionId, {
            handleCommandExecution: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {decision: "cancel"};
                return await current.approvalHandler.handleCommandExecution(
                    {...params, threadId: sessionId},
                );
            },
            handleFileChange: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {decision: "cancel"};
                return await current.approvalHandler.handleFileChange(
                    {...params, threadId: sessionId},
                );
            },
            handlePermissionsRequest: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {permissions: {}, scope: "turn", strictAutoReview: false};
                return await current.approvalHandler.handlePermissionsRequest(
                    {...params, threadId: sessionId},
                );
            },
        });
        this.client.onElicitationRequest(targetSessionId, {
            handleElicitation: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {action: "cancel", content: null, _meta: null};
                return await current.elicitationHandler.handleElicitation(
                    {...params, threadId: sessionId},
                );
            },
            handleUserInput: async (params) => {
                const current = session.current;
                await current.waitForRootNotifications();
                const sessionId = await this.interactionSessionId(current, targetSessionId);
                if (sessionId === null) return {answers: {}};
                return await current.elicitationHandler.handleUserInput(
                    {...params, threadId: sessionId},
                );
            },
        });
    }

    private async interactionSessionId(
        subscription: Subscription,
        targetSessionId: string,
    ): Promise<string | null> {
        if (targetSessionId === subscription.rootSessionId) return targetSessionId;
        if (!subscription.supportsSubagents) return subscription.rootSessionId;
        return await subscription.waitForChildSession(targetSessionId);
    }

    private rootAttributed(event: ServerNotification, rootSessionId: string): ServerNotification {
        if (typeof (event.params as {threadId?: unknown}).threadId !== "string") return event;
        return {
            ...event,
            params: {...event.params, threadId: rootSessionId},
        } as ServerNotification;
    }
}
