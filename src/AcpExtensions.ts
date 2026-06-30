import type {
    ClientContext,
    LoadSessionResponse,
    NewSessionResponse,
    ResumeSessionResponse,
    SessionId,
} from "@agentclientprotocol/sdk";
import {z} from "zod";

export const LEGACY_SET_SESSION_MODEL_METHOD = "session/set_model";

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
    | SetSessionTitleExtRequest

export function isExtMethodRequest(request: { method: string, params: Record<string, unknown> }): request is ExtMethodRequest {
    return request.method === "authentication/status"
        || request.method === "authentication/logout"
        || request.method === LEGACY_SET_SESSION_MODEL_METHOD
        || request.method === SET_SESSION_TITLE_METHOD;
}

export type AuthenticationStatusRequest = { method: "authentication/status", params: {} }
export type AuthenticationStatusResponse = { type: "api-key" } | { type: "chat-gpt", email: string } | { type: "gateway", name: string } | { type: "unauthenticated" }

export type AuthenticationLogoutRequest = { method: "authentication/logout", params: {} }
export type AuthenticationLogoutResponse = {}

export type LegacySetSessionModelExtRequest = {
    method: typeof LEGACY_SET_SESSION_MODEL_METHOD;
    params: LegacySetSessionModelRequest;
}

export type SetSessionTitleExtRequest = {
    method: typeof SET_SESSION_TITLE_METHOD;
    params: SetSessionTitleRequest;
}

export async function legacySetSessionModel(
    connection: Pick<ClientContext, "request">,
    params: LegacySetSessionModelRequest,
): Promise<LegacySetSessionModelResponse> {
    return await connection.request<LegacySetSessionModelResponse, LegacySetSessionModelRequest>(LEGACY_SET_SESSION_MODEL_METHOD, params);
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

export interface ExtensionMethodRegistration {
    readonly method: string;
    readonly parser: z.ZodType;
}

export const EXTENSION_METHOD_REGISTRATIONS: ReadonlyArray<ExtensionMethodRegistration> = [
    {method: "authentication/status", parser: emptyExtensionParamsParser},
    {method: "authentication/logout", parser: emptyExtensionParamsParser},
    {method: LEGACY_SET_SESSION_MODEL_METHOD, parser: legacySetSessionModelParamsParser},
    {method: SET_SESSION_TITLE_METHOD, parser: setSessionTitleParamsParser},
];
