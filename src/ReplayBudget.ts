/*
 * Fork addition: source-side byte caps for session history replay.
 *
 * `streamThreadHistory` reconstructs a resumed thread by materialising every
 * turn item into a `session/update` and shipping them all. A long
 * build-and-test session (hundreds of `commandExecution` items, each carrying
 * its full aggregated output, plus `fileChange` items whose diffs are whole
 * file contents) re-ships its entire corpus on every resume. The editor's
 * renderer has its own 256MB ingestion budget, but that only bounds one
 * view-model container — main still has to JSON-encode and structured-clone
 * every byte on the way there, so an unbounded replay OOMs the renderer with
 * main's heap climbing alongside it.
 *
 * The claude fork bounds its own replay the same way (MAIN_REPLAY_*_CAP_BYTES
 * in acp-agent.ts); this is the codex-side equivalent. Truncation is
 * deliberately generic — a recursive walk over the update's string fields —
 * rather than a per-item-type switch, so a new heavy field on any thread item
 * type is covered the day it lands instead of silently bypassing the cap.
 */

// Per-update and cumulative caps. The per-update cap kills a single giant
// command output or whole-file diff; the total cap stops a long session from
// re-shipping its whole corpus. Kept aligned with the claude fork's
// MAIN_REPLAY_MESSAGE_CAP_BYTES / MAIN_REPLAY_TOTAL_CAP_BYTES.
export const REPLAY_FIELD_CAP_BYTES = 1 * 1024 * 1024;
export const REPLAY_TOTAL_CAP_BYTES = 96 * 1024 * 1024;

// Appended to a truncated string field; short enough to survive a tiny cap.
export const REPLAY_TRUNCATION_MARKER = "… [truncated: replay size limit]";

// Depth bound for the truncation walk. Real updates nest a handful of levels
// (update → content[] → block → _meta → …); this only guards against a cyclic
// or pathologically deep payload.
const MAX_WALK_DEPTH = 12;

function truncateString(value: string, maxBytes: number): string {
    if (value.length <= maxBytes) return value;
    const keep = Math.max(0, maxBytes - REPLAY_TRUNCATION_MARKER.length);
    return value.slice(0, keep) + REPLAY_TRUNCATION_MARKER;
}

/*
 * Recursively cap every oversized string in `value`, returning a new value
 * only when something was cut (so untouched updates keep their identity and
 * cost no extra allocation). Also reports the total string length that
 * survives, which is what the caller charges against the cumulative budget:
 * strings are the only fields that can be large, and this matches the claude
 * fork's `estimateReplayContentBytes` accounting (UTF-16 code units, not
 * encoded bytes — a stable over/under-count either way, and the cap is a
 * safety bound rather than an exact quota).
 */
function walk(
    value: unknown,
    maxFieldBytes: number,
    depth: number,
    acc: { bytes: number },
): { value: unknown; changed: boolean } {
    if (typeof value === "string") {
        acc.bytes += Math.min(value.length, maxFieldBytes);
        const next = truncateString(value, maxFieldBytes);
        return { value: next, changed: next !== value };
    }
    if (value === null || typeof value !== "object" || depth >= MAX_WALK_DEPTH) {
        return { value, changed: false };
    }
    if (Array.isArray(value)) {
        let changed = false;
        const result = value.map((entry) => {
            const walked = walk(entry, maxFieldBytes, depth + 1, acc);
            if (walked.changed) changed = true;
            return walked.value;
        });
        return { value: changed ? result : value, changed };
    }
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const walked = walk(entry, maxFieldBytes, depth + 1, acc);
        if (walked.changed) changed = true;
        result[key] = walked.value;
    }
    return { value: changed ? result : value, changed };
}

export interface CappedReplayUpdate<T> {
    /** The update with oversized string fields truncated. */
    update: T;
    /** Post-truncation string bytes, to charge against the cumulative budget. */
    bytes: number;
}

export function capReplayUpdate<T>(update: T, maxFieldBytes = REPLAY_FIELD_CAP_BYTES): CappedReplayUpdate<T> {
    const acc = { bytes: 0 };
    const walked = walk(update, maxFieldBytes, 0, acc);
    return { update: walked.value as T, bytes: acc.bytes };
}
