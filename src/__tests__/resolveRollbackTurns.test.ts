import {describe, expect, it} from "vitest";
import {resolveRollbackTurns} from "../CodexAcpClient";
import type {Thread, Turn, ThreadItem} from "../app-server/v2";

function userTurn(id: string, clientId: string | null, msgId = `${id}-msg`): Turn {
    const item = {
        type: "userMessage",
        id: msgId,
        clientId,
        content: [],
    } as unknown as ThreadItem;
    return {id, items: [item]} as unknown as Turn;
}

function threadWith(turns: Turn[]): Thread {
    return {id: "t", turns} as unknown as Thread;
}

describe("resolveRollbackTurns", () => {
    it("returns the count of turns to drop so history rewinds before the anchor", () => {
        // 3 turns; anchoring the middle one drops it + the last → 2 turns.
        const thread = threadWith([
            userTurn("t0", "c0"),
            userTurn("t1", "c1"),
            userTurn("t2", "c2"),
        ]);
        expect(resolveRollbackTurns(thread, "c1")).toBe(2);
    });

    it("drops only the last turn when anchoring the final message", () => {
        const thread = threadWith([userTurn("t0", "c0"), userTurn("t1", "c1")]);
        expect(resolveRollbackTurns(thread, "c1")).toBe(1);
    });

    it("drops all turns when anchoring the first message", () => {
        const thread = threadWith([userTurn("t0", "c0"), userTurn("t1", "c1")]);
        expect(resolveRollbackTurns(thread, "c0")).toBe(2);
    });

    it("prefers clientId but falls back to the item id for older threads", () => {
        const thread = threadWith([userTurn("t0", null, "raw-0"), userTurn("t1", null, "raw-1")]);
        expect(resolveRollbackTurns(thread, "raw-1")).toBe(1);
    });

    it("returns undefined when the anchor is not found", () => {
        const thread = threadWith([userTurn("t0", "c0")]);
        expect(resolveRollbackTurns(thread, "missing")).toBeUndefined();
    });
});
