import type {
    ClientContext,
    ContentBlock,
    LoadSessionResponse,
    NewSessionResponse,
    ResumeSessionResponse,
    SessionId,
} from "@agentclientprotocol/sdk";
import {z} from "zod";

export const LEGACY_SET_SESSION_MODEL_METHOD = "session/set_model";
export const SESSION_STEERING_METHOD = "_session/steering";
export const GOAL_CONTROL_METHOD = "_codex/session/goal_control";

/**
 * Custom ACP request the editor sends to persist an AI-generated session title
 * onto the agent's durable store. Shared verbatim with the editor renderer's
 * `acpSession.ts` (`SET_SESSION_TITLE_METHOD`) — keep both in sync. We back it
 * with the app-server's `thread/name/set`, so the title survives editor restarts
 * and is reported by `session/list` from any workspace. Without it the AI title
 * lives only in the originating workspace's local history; foreign-workspace
 * rows fall back to `thread.preview` (the first user message).
 */
export const SET_SESSION_TITLE_METHOD = "universe-editor/set_session_title";

/**
 * Custom ACP request that rewinds a session to a specific user message (回退):
 * truncates the conversation history past it. Shared verbatim with the editor
 * renderer's `acpSessionModel.ts` (`REWIND_SESSION_METHOD`) — keep both in sync.
 * codex backs it with the app-server's `thread/rollback`, which only truncates
 * history (and persists it); file changes are the client's responsibility, so
 * this method does NOT roll back files (unlike the claude fork's variant).
 * Params: `{ sessionId, messageId, dryRun? }`; the response is shaped like the
 * claude fork's RewindFilesResult so the renderer can treat both uniformly.
 */
export const REWIND_SESSION_METHOD = "universe-editor/rewind_session";

export type LegacySessionModel = {
    modelId: string;
    name: string;
    description?: string | null;
}

export type LegacySessionModelState = {
    availableModels: Array<LegacySessionModel>;
    currentModelId: string;
}

export type LegacySetSessionModelRequest = {
    sessionId: SessionId;
    modelId: string;
}

export type LegacySetSessionModelResponse = {}

export type SetSessionTitleRequest = {
    sessionId: SessionId;
    title: string;
}

export type SetSessionTitleResponse = {}

export type RewindSessionRequest = {
    sessionId: SessionId;
    messageId: string;
    dryRun?: boolean;
}

/** Mirrors the claude fork's RewindFilesResult so the renderer treats both agents uniformly. */
export type RewindSessionResponse = {
    canRewind: boolean;
    error?: string;
    filesChanged?: ReadonlyArray<string>;
    insertions?: number;
    deletions?: number;
}

export type LegacyNewSessionResponse = NewSessionResponse & {
    models?: LegacySessionModelState | null;
}

export type LegacyLoadSessionResponse = LoadSessionResponse & {
    models?: LegacySessionModelState | null;
}

export type LegacyResumeSessionResponse = ResumeSessionResponse & {
    models?: LegacySessionModelState | null;
}

export type ExtMethodRequest =
    AuthenticationStatusRequest
    | AuthenticationLogoutRequest
    | LegacySetSessionModelExtRequest
    | SessionSteeringExtRequest
    | GoalControlExtRequest
    | SetSessionTitleExtRequest
    | RewindSessionExtRequest

export function isExtMethodRequest(request: { method: string, params: Record<string, unknown> }): request is ExtMethodRequest {
    return request.method === "authentication/status"
        || request.method === "authentication/logout"
        || request.method === LEGACY_SET_SESSION_MODEL_METHOD
        || request.method === GOAL_CONTROL_METHOD
        || request.method === SESSION_STEERING_METHOD
        || request.method === SET_SESSION_TITLE_METHOD
        || request.method === REWIND_SESSION_METHOD;
}

export type AuthenticationStatusRequest = { method: "authentication/status", params: {} }
export type AuthenticationStatusResponse = { type: "api-key" } | { type: "chat-gpt", email: string } | { type: "gateway", name: string } | { type: "unauthenticated" }

export type AuthenticationLogoutRequest = { method: "authentication/logout", params: {} }
export type AuthenticationLogoutResponse = {}

export type LegacySetSessionModelExtRequest = {
    method: typeof LEGACY_SET_SESSION_MODEL_METHOD;
    params: LegacySetSessionModelRequest;
}

export type GoalControlRequest = {
    sessionId: SessionId;
    action: "pause" | "clear";
}

export type GoalControlExtRequest = {
    method: typeof GOAL_CONTROL_METHOD;
    params: GoalControlRequest;
}

export type SetSessionTitleExtRequest = {
    method: typeof SET_SESSION_TITLE_METHOD;
    params: SetSessionTitleRequest;
}

export type RewindSessionExtRequest = {
    method: typeof REWIND_SESSION_METHOD;
    params: RewindSessionRequest;
}

export async function legacySetSessionModel(
    connection: Pick<ClientContext, "request">,
    params: LegacySetSessionModelRequest,
): Promise<LegacySetSessionModelResponse> {
    return await connection.request<LegacySetSessionModelResponse, LegacySetSessionModelRequest>(LEGACY_SET_SESSION_MODEL_METHOD, params);
}

export type SessionSteerRequest = {
    sessionId: SessionId;
    prompt: ContentBlock[];
}

export type SessionSteeringResponse = {
    outcome: "injected" | "startedNewTurn" | "failed";
}

export type SessionSteeringExtRequest = {
    method: typeof SESSION_STEERING_METHOD;
    params: SessionSteerRequest;
}

export async function steerSessionWithFallback(
    connection: Pick<ClientContext, "request">,
    params: SessionSteerRequest,
): Promise<SessionSteeringResponse> {
    return await connection.request<SessionSteeringResponse, SessionSteerRequest>(SESSION_STEERING_METHOD, params);
}

/**
 * Parser + method-name pairs for every custom ext-method, consumed by
 * `index.ts` to register `onRequest` handlers in one loop. Centralizing this
 * here keeps the wire-up next to the method contracts: adding a method to
 * `ExtMethodRequest` / `isExtMethodRequest` without registering it (so the ACP
 * SDK rejects it with methodNotFound before it ever reaches `extMethod`) was
 * the exact bug behind codex AI titles never persisting cross-workspace.
 */
export const emptyExtensionParamsParser = z.preprocess(
    (params) => params ?? {},
    z.object({}).passthrough(),
);

export const legacySetSessionModelParamsParser = z.object({
    sessionId: z.string(),
    modelId: z.string(),
}).passthrough();

export const setSessionTitleParamsParser = z.object({
    sessionId: z.string(),
    title: z.string(),
}).passthrough();

export const sessionSteerParamsParser = z.object({
    sessionId: z.string(),
    prompt: z.array(z.any()),
}).passthrough();

export const goalControlParamsParser = z.object({
    sessionId: z.string(),
    action: z.enum(["pause", "clear"]),
}).passthrough();

export const rewindSessionParamsParser = z.object({
    sessionId: z.string(),
    messageId: z.string(),
    dryRun: z.boolean().optional(),
}).passthrough();

export interface ExtensionMethodRegistration {
    readonly method: string;
    readonly parser: z.ZodType;
}

export const EXTENSION_METHOD_REGISTRATIONS: ReadonlyArray<ExtensionMethodRegistration> = [
    {method: "authentication/status", parser: emptyExtensionParamsParser},
    {method: "authentication/logout", parser: emptyExtensionParamsParser},
    {method: LEGACY_SET_SESSION_MODEL_METHOD, parser: legacySetSessionModelParamsParser},
    {method: SET_SESSION_TITLE_METHOD, parser: setSessionTitleParamsParser},
    {method: SESSION_STEERING_METHOD, parser: sessionSteerParamsParser},
    {method: GOAL_CONTROL_METHOD, parser: goalControlParamsParser},
    {method: REWIND_SESSION_METHOD, parser: rewindSessionParamsParser},
];
