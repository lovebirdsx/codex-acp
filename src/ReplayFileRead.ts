/*
 * Fork addition: size-bounded file reads for the replay path.
 *
 * Replay reads one file from disk — the session's rollout JSONL, from which the
 * request_user_input question cards are recovered. A bare `readFile` would
 * materialise a multi-hundred-MB transcript just to look for a handful of
 * function calls.
 *
 * `stat` before reading so an oversized file is skipped without ever being
 * materialised, rather than truncated after the allocation already happened.
 */

import { readFile, stat } from "node:fs/promises";

// The rollout transcript is a whole session's JSONL. Bounded well above the
// per-session sizes real sessions reach (long sessions run to tens of MB) but
// below the point where reading it, splitting it, and holding the parsed cards
// costs more than the history is worth.
export const REPLAY_ROLLOUT_READ_CAP_BYTES = 64 * 1024 * 1024;

/**
 * Read a UTF-8 file, returning null when it is missing, unreadable, or larger
 * than `maxBytes`. `onOversize` reports the skip so callers can log with their
 * own context.
 */
export async function readFileWithinCap(
    filePath: string,
    maxBytes: number,
    onOversize?: (size: number) => void,
): Promise<string | null> {
    try {
        const stats = await stat(filePath);
        if (!stats.isFile()) return null;
        if (stats.size > maxBytes) {
            onOversize?.(stats.size);
            return null;
        }
    } catch {
        return null;
    }
    return await readFile(filePath, { encoding: "utf8" }).catch(() => null);
}
