import {describe, expect, it} from "vitest";
import {readExtraModelEffortMeta} from "../ExtraModels";

describe("readExtraModelEffortMeta", () => {
    it("degrades to an empty map for an absent or malformed payload", () => {
        expect(readExtraModelEffortMeta(undefined)).toEqual(new Map());
        expect(readExtraModelEffortMeta(null)).toEqual(new Map());
        expect(readExtraModelEffortMeta({})).toEqual(new Map());
        expect(readExtraModelEffortMeta({extraModelEffort: "nope"})).toEqual(new Map());
        expect(readExtraModelEffortMeta({extraModelEffort: [{id: 1}]})).toEqual(new Map());
        expect(readExtraModelEffortMeta({extraModelEffort: [{id: "a", effortLevels: "low"}]})).toEqual(
            new Map(),
        );
    });

    it("trims ids and levels and de-duplicates levels", () => {
        const result = readExtraModelEffortMeta({
            extraModelEffort: [
                {id: "  model-a  ", effortLevels: [" low ", "", "  high ", "low"]},
                {id: "   ", effortLevels: ["low"]},
            ],
        });
        expect(result).toEqual(new Map([["model-a", ["low", "high"]]]));
    });

    it("keeps the first declaration for a duplicate id", () => {
        const result = readExtraModelEffortMeta({
            extraModelEffort: [
                {id: "model-a", effortLevels: ["low"]},
                {id: "model-a", effortLevels: ["high"]},
            ],
        });
        expect(result).toEqual(new Map([["model-a", ["low"]]]));
    });

    it("caps at MAX_EXTRA_MODELS entries", () => {
        const entries: Array<{id: string; effortLevels: string[]}> = [];
        for (let i = 0; i < 70; i++) {
            entries.push({id: `model-${i}`, effortLevels: ["low"]});
        }
        const result = readExtraModelEffortMeta({extraModelEffort: entries});
        expect(result.size).toBe(64);
    });
});
