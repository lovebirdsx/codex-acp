import path from "node:path";
import {execFileSync} from "node:child_process";

export function isAbsolutePathLike(value: string): boolean {
    const trimmed = value.trim();
    return path.isAbsolute(trimmed) || isWindowsAbsolutePath(trimmed);
}

export function arePathsEqual(left: string | undefined, right: string | undefined): boolean {
    if (!left || !right) return false;
    return normalizePathForComparison(left) === normalizePathForComparison(right);
}

export function arePathBasenamesEqual(left: string, right: string): boolean {
    const leftBase = path.posix.basename(normalizePathForComparison(left));
    const rightBase = path.posix.basename(normalizePathForComparison(right));
    if (shouldComparePathCaseInsensitive(left) || shouldComparePathCaseInsensitive(right)) {
        return leftBase.toLowerCase() === rightBase.toLowerCase();
    }
    return leftBase === rightBase;
}

export function normalizePathForComparison(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return "";
    }

    if (isWindowsAbsolutePath(trimmed)) {
        const normalized = path.win32.normalize(trimmed).replace(/\\/g, "/");
        return trimTrailingPathSeparators(normalized).toLowerCase();
    }

    const pathForComparison = path.isAbsolute(trimmed)
        ? trimmed
        : trimmed.replace(/\\/g, "/");
    const normalized = path.posix.normalize(pathForComparison);
    return trimTrailingPathSeparators(normalized);
}

function isWindowsAbsolutePath(value: string): boolean {
    const portableValue = value.replace(/\\/g, "/");
    return /^[A-Za-z]:\//.test(portableValue) || /^\/\/[^/]+\/[^/]+/.test(portableValue);
}

function shouldComparePathCaseInsensitive(value: string): boolean {
    return isWindowsAbsolutePath(value) || /^[A-Za-z]:/.test(value) || value.includes("\\");
}

function trimTrailingPathSeparators(value: string): string {
    let trimmed = value;
    while (trimmed.endsWith("/") && !isRootPath(trimmed)) {
        trimmed = trimmed.slice(0, -1);
    }
    return trimmed;
}

function isRootPath(value: string): boolean {
    return value === "/"
        || /^[A-Za-z]:\/$/.test(value)
        || /^\/\/[^/]+\/[^/]+\/$/.test(value);
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
