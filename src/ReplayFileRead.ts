/*
 * Fork addition: size-bounded file reads for the replay path.
 *
 * Replay re-reads files from disk in two places — `createPatchContent` pulls a
 * changed file's current contents to rebuild its diff, and the rollout fallback
 * slurps the whole transcript JSONL — both with a bare `readFile` and no size
 * check. A single multi-hundred-MB file (a generated asset, a log the session
 * touched) is enough to spike the agent process and, for the diff path, ship
 * that whole file into the editor as diff text.
 *
 * `stat` before reading so an oversized file is skipped without ever being
 * materialised, rather than truncated after the allocation already happened.
 */

import { readFile, stat } from "node:fs/promises";

// A changed file this large is not something the diff viewer can usefully
// render; skipping it costs a diff card, reading it costs the process.
export const REPLAY_FILE_READ_CAP_BYTES = 8 * 1024 * 1024;

// The rollout transcript is a whole session's JSONL. Bounded well above the
// per-file cap (long sessions legitimately run to tens of MB) but below the
// point where reading it, splitting it, and holding the derived update arrays
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
