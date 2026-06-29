import {describe, expect, it} from "vitest";
import {arePathsEqual, gitWorktreePaths} from "../PathUtils";
import {tmpdir} from "node:os";
import {mkdtempSync, rmSync, realpathSync} from "node:fs";
import {join} from "node:path";
import {execFileSync} from "node:child_process";

describe("arePathsEqual", () => {
    it("returns false when either side is missing", () => {
        expect(arePathsEqual(undefined, "/a")).toBe(false);
        expect(arePathsEqual("/a", undefined)).toBe(false);
        expect(arePathsEqual("", "/a")).toBe(false);
    });

    it("treats an identical path as equal", () => {
        const p = process.cwd();
        expect(arePathsEqual(p, p)).toBe(true);
    });

    it("collapses redundant . and .. segments", () => {
        const base = process.cwd();
        expect(arePathsEqual(base, `${base}/sub/..`)).toBe(true);
        expect(arePathsEqual(base, `${base}/./.`)).toBe(true);
    });

    it("ignores trailing-slash differences", () => {
        const base = process.cwd();
        expect(arePathsEqual(base, `${base}/`)).toBe(true);
    });

    it.runIf(process.platform === "win32")(
        "matches Windows paths that differ only by separator (codex session/list repro)",
        () => {
            expect(arePathsEqual("F:\\test\\test\\md", "F:/test/test/md")).toBe(true);
        },
    );

    it.runIf(process.platform === "win32")("folds drive-letter and path casing on Windows", () => {
        expect(arePathsEqual("F:\\Test\\MD", "f:/test/md")).toBe(true);
    });

    it.runIf(process.platform === "linux")("is case-sensitive on linux", () => {
        expect(arePathsEqual("/test/MD", "/test/md")).toBe(false);
    });
});

describe("gitWorktreePaths", () => {
    const git = (cwd: string, ...a: string[]) =>
        execFileSync("git", a, {cwd, stdio: "ignore"});

    it("returns every sibling worktree of a repo, not just the queried one", () => {
        const tmp = realpathSync(mkdtempSync(join(tmpdir(), "codex-acp-wt-")));
        const main = join(tmp, "main");
        const linked = join(tmp, "linked");
        try {
            execFileSync("git", ["init", main], {cwd: tmp, stdio: "ignore"});
            git(main, "config", "user.email", "t@t.t");
            git(main, "config", "user.name", "t");
            git(main, "commit", "--allow-empty", "-m", "init");
            git(main, "worktree", "add", "-b", "feature", linked);

            // Querying from the linked worktree must surface the main checkout too.
            const roots = gitWorktreePaths(linked);
            expect(roots.some((r) => arePathsEqual(r, main))).toBe(true);
            expect(roots.some((r) => arePathsEqual(r, linked))).toBe(true);
        } finally {
            rmSync(tmp, {recursive: true, force: true});
        }
    });

    it("falls back to [cwd] for a directory outside any git repo", () => {
        const dir = mkdtempSync(join(tmpdir(), "codex-acp-no-git-"));
        try {
            expect(gitWorktreePaths(dir)).toEqual([dir]);
        } finally {
            rmSync(dir, {recursive: true, force: true});
        }
    });
});
