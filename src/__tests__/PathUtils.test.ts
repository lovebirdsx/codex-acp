import {describe, expect, it} from "vitest";
import {arePathsEqual} from "../PathUtils";

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
