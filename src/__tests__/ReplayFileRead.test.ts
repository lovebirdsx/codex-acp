import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockFiles, mockSizes, readCalls } = vi.hoisted(() => ({
    mockFiles: new Map<string, string>(),
    mockSizes: new Map<string, number>(),
    readCalls: [] as string[],
}));

vi.mock("node:fs/promises", () => ({
    readFile: async (filePath: string) => {
        readCalls.push(filePath);
        const content = mockFiles.get(filePath);
        if (content === undefined) {
            throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
        }
        return content;
    },
    stat: async (filePath: string) => {
        if (!mockFiles.has(filePath) && !mockSizes.has(filePath)) {
            throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
        }
        return { isFile: () => true, size: mockSizes.get(filePath) ?? mockFiles.get(filePath)!.length };
    },
}));

const { readFileWithinCap } = await import("../ReplayFileRead");

describe("readFileWithinCap", () => {
    beforeEach(() => {
        mockFiles.clear();
        mockSizes.clear();
        readCalls.length = 0;
    });

    it("reads a file under the cap", async () => {
        mockFiles.set("/tmp/small.cpp", "int main() {}");
        expect(await readFileWithinCap("/tmp/small.cpp", 1024)).toBe("int main() {}");
    });

    it("skips a file over the cap without reading it, reporting the size", async () => {
        mockFiles.set("/tmp/huge.bin", "x");
        mockSizes.set("/tmp/huge.bin", 500 * 1024 * 1024);
        const oversize = vi.fn();
        expect(await readFileWithinCap("/tmp/huge.bin", 8 * 1024 * 1024, oversize)).toBeNull();
        expect(oversize).toHaveBeenCalledWith(500 * 1024 * 1024);
        // The stat comes first: an oversized file is never materialised.
        expect(readCalls).toEqual([]);
    });

    it("returns null for a missing file", async () => {
        expect(await readFileWithinCap("/tmp/gone.cpp", 1024)).toBeNull();
    });
});
