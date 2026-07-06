import {createHash} from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {RequestError} from "@agentclientprotocol/sdk";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {ModeKind} from "./app-server/ModeKind";
import type {ServiceTier} from "./app-server/ServiceTier";
import type {Model, ThreadForkParams} from "./app-server/v2";
import type {SessionMetadata} from "./SessionMetadata";

export type SessionForkDependencies = {
    codexClient: CodexAppServerClient;
    refreshSkills(cwd: string, additionalDirectories: string[]): Promise<void>;
    createSessionConfig(
        cwd: string,
        additionalDirectories: string[],
        mcpServers: acp.McpServer[],
    ): Promise<NonNullable<ThreadForkParams["config"]>>;
    getResumeModelProvider(): Promise<string>;
    fetchAvailableModels(): Promise<Model[]>;
    createCurrentModelId(models: Model[], model: string, reasoningEffort: string | null): string;
    getCollaborationMode(sessionId: string): ModeKind;
};

export async function forkSession(
    request: acp.ForkSessionRequest,
    additionalDirectories: string[],
    dependencies: SessionForkDependencies,
): Promise<SessionMetadata> {
    await dependencies.refreshSkills(request.cwd, additionalDirectories);
    // fork-only: `_meta.rewindTo` (the editor's 回退/fork anchor) wins over the AIR fork point.
    const rewind = await resolveRewindForkPoint(request, dependencies.codexClient);
    const lastTurnId = rewind.lastTurnId ?? await resolveForkTurnId(request, dependencies.codexClient);
    const response = await dependencies.codexClient.threadFork({
        excludeTurns: true,
        config: await dependencies.createSessionConfig(
            request.cwd,
            additionalDirectories,
            request.mcpServers ?? [],
        ),
        cwd: request.cwd,
        ...(lastTurnId !== undefined && {lastTurnId}),
        modelProvider: await dependencies.getResumeModelProvider(),
        threadId: request.sessionId,
    });
    await dependencies.codexClient.threadUnsubscribe({threadId: response.thread.id});
    if (rewind.beforeTurnId !== undefined) {
        await dependencies.codexClient.threadRevert({
            threadId: response.thread.id,
            beforeTurnId: rewind.beforeTurnId,
        });
    }

    const models = await dependencies.fetchAvailableModels();
    return {
        sessionId: response.thread.id,
        currentModelId: dependencies.createCurrentModelId(models, response.model, response.reasoningEffort),
        models,
        collaborationMode: dependencies.getCollaborationMode(response.thread.id),
        modelProvider: response.modelProvider,
        currentServiceTier: response.serviceTier as ServiceTier ?? null,
        additionalDirectories,
    };
}

/**
 * fork-only: the editor asks to branch from before one of the session's user
 * messages via `_meta.rewindTo` (parity with its 回退 action). Translate that
 * anchor into codex's fork knobs: the turn just before the anchor turn becomes
 * `lastTurnId`; an anchor in the first turn means the fork keeps no turns, which
 * codex cannot express as a fork point, so the forked thread is reverted to
 * before that first turn instead. An anchor that is not found forks from the
 * tip, like an absent id.
 */
async function resolveRewindForkPoint(
    request: acp.ForkSessionRequest,
    codexClient: CodexAppServerClient,
): Promise<{ lastTurnId?: string; beforeTurnId?: string }> {
    const messageId = readForkRewindTo(request);
    if (messageId === undefined) return {};
    const history = await codexClient.threadReadWithHistory(request.sessionId);
    const turns = history.thread.turns;
    const index = turns.findIndex(turn => turn.items.some(item =>
        item.type === "userMessage" && (item.clientId === messageId || item.id === messageId)));
    if (index < 0) return {};
    const anchor = turns[index];
    if (index === 0) return anchor === undefined ? {} : {beforeTurnId: anchor.id};
    const previous = turns[index - 1];
    return previous === undefined ? {} : {lastTurnId: previous.id};
}

function readForkRewindTo(request: acp.ForkSessionRequest): string | undefined {
    const meta = request._meta as {rewindTo?: unknown} | null | undefined;
    const rewindTo = meta?.rewindTo;
    return typeof rewindTo === "string" && rewindTo.length > 0 ? rewindTo : undefined;
}

async function resolveForkTurnId(
    request: acp.ForkSessionRequest,
    codexClient: CodexAppServerClient,
): Promise<string | undefined> {
    const forkPoint = readAirForkPoint(request._meta);
    if (!forkPoint) return undefined;

    const history = await codexClient.threadReadWithHistory(request.sessionId);
    const candidateIds = airForkMessageIdCandidates(forkPoint.messageId);
    const itemTurnId = candidateIds
        .map(candidateId => history.thread.turns.find(turn => turn.items.some(item => item.id === candidateId))?.id)
        .find(turnId => turnId !== undefined);
    if (itemTurnId) return itemTurnId;

    if (forkPoint.messageFingerprint) {
        const matchingTurns = history.thread.turns.flatMap(turn => turn.items
            .filter(item => item.type === "agentMessage"
                && fingerprintAgentMessage(item.text) === forkPoint.messageFingerprint)
            .map(() => turn.id));
        const fingerprintTurnId = matchingTurns[forkPoint.messageOccurrence - 1];
        if (fingerprintTurnId) return fingerprintTurnId;
    }

    throw RequestError.invalidParams(
        {messageId: forkPoint.messageId},
        `Fork point message ${forkPoint.messageId} was not found in session ${request.sessionId}`,
    );
}

type AirForkPoint = {
    messageId: string;
    messageFingerprint?: string;
    messageOccurrence: number;
};

function readAirForkPoint(meta?: Record<string, unknown> | null): AirForkPoint | undefined {
    const jetbrains = meta?.["jetbrains"];
    if (!isUnknownRecord(jetbrains)) return undefined;
    const air = jetbrains["air"];
    if (!isUnknownRecord(air)) return undefined;
    const fork = air["fork"];
    if (!isUnknownRecord(fork) || fork["version"] !== 1) return undefined;
    const messageId = fork["messageId"];
    if (typeof messageId !== "string" || messageId.trim().length === 0) {
        throw RequestError.invalidParams(undefined, "AIR fork messageId must be a non-empty string");
    }
    const messageFingerprint = fork["messageFingerprint"];
    if (messageFingerprint !== undefined
        && (typeof messageFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(messageFingerprint))) {
        throw RequestError.invalidParams(undefined, "AIR fork messageFingerprint must be a SHA-256 fingerprint");
    }
    const messageOccurrence = fork["messageOccurrence"] ?? 1;
    if (!Number.isSafeInteger(messageOccurrence) || (messageOccurrence as number) < 1) {
        throw RequestError.invalidParams(undefined, "AIR fork messageOccurrence must be a positive integer");
    }
    return {
        messageId: messageId.trim(),
        ...(typeof messageFingerprint === "string" && {messageFingerprint}),
        messageOccurrence: messageOccurrence as number,
    };
}

function fingerprintAgentMessage(text: string): string {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function airForkMessageIdCandidates(messageId: string): string[] {
    // Older AIR builds sent their visible segment id. Prefer the exact id before its ACP source id.
    const visibleSegmentSuffix = /:segment:\d+$/;
    const protocolMessageId = messageId.replace(visibleSegmentSuffix, "");
    return protocolMessageId === messageId ? [messageId] : [messageId, protocolMessageId];
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
