import path from "node:path";

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
