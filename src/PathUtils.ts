import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Robust, platform-aware filesystem path equality.
 *
 * Mirrors the "path identity, not string comparison" rule VS Code follows with
 * its `extUri.isEqual` family: a path must be canonicalized before comparison,
 * because the same directory can be spelled with different separators, redundant
 * `.`/`..` segments, trailing slashes, or on Windows/macOS different letter
 * casing. Codex persists a session cwd as the OS-native string
 * (e.g. F:\\test\\md) while the editor sends it back with POSIX
 * separators (F:/test/md); a naive === then never matches and the session
 * silently drops out of session/list.
 *
 * Canonicalization here:
 *  - path.resolve folds separators to the OS form and collapses ./..
 *  - separators are then normalized to forward slashes so a cross-spelling input
 *    still compares equal regardless of which slash the caller used
 *  - on case-insensitive platforms (win32/darwin) both sides are lowercased
 *
 * Note: this is a text-level canonicalization only; it does not resolve symlinks
 * or 8.3 short names (that would need an fs lookup). It covers the separator,
 * case and ./.. drift that actually occurs between the stored cwd and request.
 */
export function arePathsEqual(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    const na = canonicalizePath(a);
    const nb = canonicalizePath(b);
    if (isCaseInsensitivePlatform()) {
        return na.toLowerCase() === nb.toLowerCase();
    }
    return na === nb;
}

const BACKSLASH = /\\/g;

function canonicalizePath(p: string): string {
    return path.resolve(p).replace(BACKSLASH, "/");
}

function isCaseInsensitivePlatform(): boolean {
    return process.platform === "win32" || process.platform === "darwin";
}

/**
 * Absolute paths of every git worktree that shares cwd's repository,
 * including the main checkout and cwd itself.
 *
 * The editor's `worktree` history scope expects `session/list` to surface
 * sessions from sibling worktrees of the open folder. The Claude SDK does
 * this via its `includeWorktrees: true` default; codex has no such notion, so
 * we expand the set here by shelling out to `git worktree list --porcelain`.
 *
 * Best-effort: when cwd is not inside a git repository, git is unavailable,
 * or the command fails for any reason, we fall back to `[cwd]` so the caller
 * keeps its single-directory behaviour instead of throwing.
 */
export function gitWorktreePaths(cwd: string): string[] {
    try {
        const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        const paths: string[] = [];
        for (const line of out.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.startsWith("worktree ")) {
                paths.push(trimmed.slice("worktree ".length).trim());
            }
        }
        return paths.length > 0 ? paths : [cwd];
    } catch {
        return [cwd];
    }
}
