import type {ReasoningEffort} from "./app-server";
import type {Model} from "./app-server/v2";

/**
 * Fork-only extension (not upstream): let the ACP client append extra model ids
 * to a session's catalogue via top-level `_meta.extraModels`.
 *
 * Why the fork needs this: `availableModels` comes from app-server's `model/list`,
 * i.e. the built-in OpenAI catalogue. A user pointing codex at their own gateway
 * (`MODEL_PROVIDER`) has models that catalogue never lists, and `applyModelChange`
 * throws `invalidParams` for any id outside it. `createModelConfigOption` only
 * unshifts the CURRENT uncatalogued model as a courtesy — so once the user
 * switches away from it, they can never switch back, and sibling gateway models
 * are unreachable entirely. The client (universe-editor) already knows which
 * models its configured gateway serves and forwards that list here.
 *
 * The claude fork has the mirror-image implementation (`src/extra-models.ts`);
 * the wire key is deliberately identical and top-level so the editor stamps one
 * payload for both.
 */

/** Upper bound mirroring the client's own cap; a malformed payload cannot bloat the catalogue. */
const MAX_EXTRA_MODELS = 64;

/** Extra model ids requested by the client. Empty for an absent or malformed
 *  payload — a bad `_meta` must never fail session creation. */
export function readExtraModelsMeta(meta: unknown): Array<string> {
    const value = (meta as {extraModels?: unknown} | null | undefined)?.extraModels;
    if (!Array.isArray(value)) return [];
    const out: Array<string> = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (typeof entry !== "string") continue;
        const trimmed = entry.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
        if (out.length >= MAX_EXTRA_MODELS) break;
    }
    return out;
}

/**
 * Floor for an injected context window. codex triggers auto-compaction off this
 * number, so a pathological small value (a typo'd `maxInputTokens: 1`, dirty
 * gateway metadata) would compact on every single turn and make the session
 * unusable with nothing pointing at the cause. Below the floor we ignore the
 * payload and stay on codex's own fallback. No ceiling: an over-large window
 * just means "never compact", the same risk class as the 272K fallback itself.
 */
const MIN_MODEL_CONTEXT_WINDOW = 1024;

/**
 * Per-session context window (in tokens) the client resolved for the current
 * model, forwarded via top-level `_meta.modelContextWindow`. Returns null for an
 * absent or malformed payload — a bad `_meta` must never fail session creation.
 *
 * The editor pre-resolves this single value (the current model's window) because
 * the fork cannot know the active model id at config-assembly time — codex only
 * reports it after `thread/start`. The claude fork ignores this key; it reads
 * only `_meta.extraModels`.
 */
export function readModelContextWindowMeta(meta: unknown): number | null {
    const value = (meta as {modelContextWindow?: unknown} | null | undefined)?.modelContextWindow;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
    return value >= MIN_MODEL_CONTEXT_WINDOW ? value : null;
}

/**
 * A minimal catalogue entry for a client-supplied model id.
 *
 * `supportedReasoningEfforts` is deliberately empty: we know nothing about a
 * gateway model's effort levels, and advertising guesses would offer the user
 * switches the endpoint may reject. `defaultReasoningEffort` copies the effort
 * the session is currently on rather than a hardcoded `"medium"` — it becomes the
 * effort half of `ModelId` (`gateway-model[<effort>]`) when the user selects this
 * entry, and a gateway that only accepts what it was already given must not be
 * handed a value out of nowhere.
 */
export function synthesizeExtraModel(id: string, currentEffort: ReasoningEffort): Model {
    return {
        id,
        model: id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: id,
        description: "",
        // Unknown for a gateway model: `null` is the type's own "no metadata"
        // value, so nothing here claims a specialty, runtime or access program.
        modelSpecialty: null,
        multiAgentVersion: null,
        availableAccessPrograms: null,
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: currentEffort,
        // Permissive on purpose, matching the fork's own fallback for an
        // uncatalogued current model: these are only used to *reject* prompts
        // locally, so guessing "text" would block images a gateway does accept.
        inputModalities: ["text", "image"],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: false,
    };
}

/** `models` plus a synthesized entry per extra id the catalogue lacks. Returns
 *  the input untouched when there is nothing to add. */
export function appendExtraModels(
    models: Array<Model>,
    extras: Array<string>,
    currentEffort: ReasoningEffort,
): Array<Model> {
    if (extras.length === 0) return models;
    const result = [...models];
    const seen = new Set(models.map(m => m.id));
    for (const id of extras) {
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(synthesizeExtraModel(id, currentEffort));
    }
    return result;
}
