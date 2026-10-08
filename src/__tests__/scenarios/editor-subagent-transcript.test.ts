import type * as acp from "@agentclientprotocol/sdk";
import {describe, expect, it} from "vitest";
import {normalize, runScenario, type RecordedMessage} from "./scenario-harness";
import {
    CHILD_THREAD_ID,
    SCENARIOS,
    SESSION_ID,
    collab,
    completed,
    started,
    type Scenario,
    type ScenarioStep,
} from "./scenarios";

/*
 * fork: the sub-agent trail of a client that reads the work of a sub-agent without native subagent
 * sessions. The universe-editor declares the capability; the adapter forwards the work of a direct
 * child on the root session, attributed to the card of its `subAgentActivity` item. A client
 * without the capability keeps the flat representation of the baseline (see client-profiles.test.ts).
 */
const EDITOR_CAPABILITIES = {
    fs: {readTextFile: true, writeTextFile: true},
    terminal: true,
    _meta: {"subagent-transcript": true},
} as acp.ClientCapabilities;

const ROOT_SESSION = "session-1";

type Update = Record<string, any>;
/** One `session/update` notification: its session and its update. */
type Notified = {sessionId: string; update: Update};

async function notify(
    scenarioName: string,
    capabilities: acp.ClientCapabilities | "plain",
): Promise<Notified[]> {
    const scenario = SCENARIOS.find(candidate => candidate.name === scenarioName);
    if (scenario === undefined) throw new Error(`No scenario ${scenarioName}`);
    return await notifyScenario(scenario, capabilities);
}

async function notifyScenario(
    scenario: Scenario,
    capabilities: acp.ClientCapabilities | "plain",
): Promise<Notified[]> {
    const messages: RecordedMessage[] = normalize(await runScenario(scenario, capabilities));
    return messages
        .filter(message => message.method === "session/update")
        .map(message => {
            const params = message.params as {sessionId: string; update: Update};
            return {sessionId: params.sessionId, update: params.update};
        });
}

function subagentMeta(update: Update): unknown {
    return update["_meta"]?.["codex"]?.["subagent"];
}

function parentOf(update: Update): unknown {
    return update["_meta"]?.["codex"]?.["parentToolCallId"];
}

describe("the sub-agent trail of the editor client", () => {
    it("marks the sub-agent activity cards and nests the work of the sub-agent under them", async () => {
        const updates = (await notify("subagent-activity", EDITOR_CAPABILITIES)).map(entry => entry.update);

        const start = updates.find(update => update["toolCallId"] === "act-1" && update["sessionUpdate"] === "tool_call");
        expect(start?.["title"]).toBe("Start subagent weather");
        expect(subagentMeta(start!)).toEqual({
            activity: "started", path: "/root/weather", threadId: CHILD_THREAD_ID,
        });
        const complete = updates.find(
            update => update["toolCallId"] === "act-2" && update["sessionUpdate"] === "tool_call",
        );
        expect(complete?.["title"]).toBe("Complete subagent weather");
        expect(subagentMeta(complete!)).toEqual({
            activity: "completed", path: "/root/weather", threadId: CHILD_THREAD_ID,
        });

        // The text of the sub-agent goes on the root session, attributed to the activity card.
        const childText = updates.find(update => update["sessionUpdate"] === "agent_message_chunk");
        expect(childText?.["content"]).toEqual({type: "text", text: "Sunny"});
        expect(parentOf(childText!)).toBe("act-1");
    });

    it("attributes every tool call of a child thread to its activity card, on the root session", async () => {
        const entries = await notify("native-subagent-session", EDITOR_CAPABILITIES);
        expect(new Set(entries.map(entry => entry.sessionId))).toEqual(new Set([ROOT_SESSION]));

        const child = entries.map(entry => entry.update)
            .filter(update => update["toolCallId"] === "child-cmd" || update["toolCallId"] === "child-mcp"
                || update["sessionUpdate"] === "agent_message_chunk");
        expect(child.length).toBeGreaterThan(0);
        for (const update of child) {
            expect(parentOf(update)).toBe("act-1");
        }
        expect(child.some(update => update["sessionUpdate"] === "tool_call")).toBe(true);
    });

    it("keeps a grandchild out of the trail: the representation is one level deep", async () => {
        const updates = (await notify("nested-subagent-session", EDITOR_CAPABILITIES)).map(entry => entry.update);
        // The card of the direct child proves the scenario ran with the nested sub-agents.
        expect(updates.some(update => update["toolCallId"] === "act-1")).toBe(true);
        expect(updates.some(update => update["toolCallId"] === "grandchild-cmd")).toBe(false);
        expect(updates.some(update => (update["content"] as Update | undefined)?.["text"] === "Rain in Lyon"))
            .toBe(false);
    });

    it("forwards the output of a sub-agent that arrives after the child turn ended", async () => {
        const updates = (await notify("late-subagent-update", EDITOR_CAPABILITIES)).map(entry => entry.update);
        const late = updates.filter(update => parentOf(update) === "act-1");
        expect(late.length).toBeGreaterThan(0);
        // The turn state of a child thread never reaches the root session.
        expect(updates.some(update => update["sessionUpdate"]?.startsWith("turn"))).toBe(false);
    });

    it("sends no trail to a client that does not declare the capability", async () => {
        const updates = (await notify("subagent-activity", "plain")).map(entry => entry.update);
        expect(updates.some(update => subagentMeta(update) !== undefined)).toBe(false);
        expect(updates.some(update => parentOf(update) !== undefined)).toBe(false);
        expect(updates.some(update => update["sessionUpdate"] === "agent_message_chunk")).toBe(false);
        // The activity cards themselves stay: a client without the capability still sees them.
        expect(updates.some(update => update["toolCallId"] === "act-1")).toBe(true);
    });

    it("names the session of the trail with the root session of the thread", async () => {
        const entries = await notify("subagent-activity", EDITOR_CAPABILITIES);
        expect(entries.every(entry => entry.sessionId === SESSION_ID)).toBe(true);
    });
});

/*
 * The shape the app-server sends for a collaboration spawn: the `started` item does not name its
 * threads yet, and the work of the child follows the `completed` item. Codex sends no
 * `subAgentActivity` item for such a child, so the card of the spawn is the only card the trail
 * can nest under.
 */
const childStep = (method: string, params: Record<string, unknown>): ScenarioStep => ({
    notify: {method, params: {threadId: CHILD_THREAD_ID, turnId: `${CHILD_THREAD_ID}-turn`, ...params}},
});

const childCommand = (overrides: Record<string, unknown>) => ({
    type: "commandExecution", id: "child-cmd", pluginId: null, scriptPath: null, command: "echo alpha",
    cwd: "/workspace", processId: "pid-1", source: "agent", status: "inProgress", commandActions: [],
    aggregatedOutput: null, exitCode: null, durationMs: null,
    ...overrides,
});

const spawnItem = (status: "inProgress" | "completed", receiverThreadIds: string[]) => ({
    type: "collabAgentToolCall", id: "spawn-1", tool: "spawnAgent", status, senderThreadId: SESSION_ID,
    receiverThreadIds, prompt: "Run echo alpha.", model: null, reasoningEffort: null,
    agentsStates: receiverThreadIds.length === 0
        ? {}
        : {[CHILD_THREAD_ID]: {status: "completed", message: "alpha"}},
});

const tokenUsage = (threadId: string) => {
    const count = {
        totalTokens: 1000, inputTokens: 800, cachedInputTokens: 200, cacheWriteInputTokens: 0,
        outputTokens: 300, reasoningOutputTokens: 50,
    };
    return childStep("thread/tokenUsage/updated", {
        tokenUsage: {total: count, last: count, modelContextWindow: null},
    });
};

const COLLABORATION_WORK: Scenario = {
    name: "collaboration-work",
    steps: [
        started(spawnItem("inProgress", [])),
        completed(spawnItem("completed", [CHILD_THREAD_ID])),
        started(childCommand({}), CHILD_THREAD_ID),
        childStep("item/commandExecution/outputDelta", {itemId: "child-cmd", delta: "alpha\n"}),
        completed(childCommand({
            status: "completed", aggregatedOutput: "alpha\n", exitCode: 0, durationMs: 3,
        }), CHILD_THREAD_ID),
        childStep("item/agentMessage/delta", {itemId: "child-msg", delta: "alpha"}),
        tokenUsage(CHILD_THREAD_ID),
        childStep("turn/completed", {
            turn: {
                id: `${CHILD_THREAD_ID}-turn`, items: [], itemsView: "notLoaded", status: "completed",
                error: null, startedAt: null, completedAt: null, durationMs: null,
            },
        }),
        // A control call addresses the thread of the same child: it is no spawn, so it is no
        // sub-agent card and it never takes the trail of the thread.
        started(collab("wait-1", "wait", "inProgress", "running")),
        completed(collab("wait-1", "wait", "completed", "running")),
    ],
};

describe("the sub-agent trail of a collaboration spawn", () => {
    it("marks the spawn card and nests the work of its thread under it", async () => {
        const updates = (await notifyScenario(COLLABORATION_WORK, EDITOR_CAPABILITIES))
            .map(entry => entry.update);

        const card = updates.find(
            update => update["toolCallId"] === "spawn-1" && update["sessionUpdate"] === "tool_call",
        );
        expect(subagentMeta(card!)).toEqual({activity: "spawnAgent"});
        // Only the completed item names the thread of the child.
        const done = updates.find(
            update => update["toolCallId"] === "spawn-1" && update["sessionUpdate"] === "tool_call_update",
        );
        expect(subagentMeta(done!)).toEqual({activity: "spawnAgent", threadId: CHILD_THREAD_ID});

        const child = updates.filter(update => parentOf(update) !== undefined);
        expect(child.length).toBeGreaterThan(0);
        for (const update of child) expect(parentOf(update)).toBe("spawn-1");
        expect(child.some(update => update["toolCallId"] === "child-cmd")).toBe(true);
        expect(child.some(update => update["messageId"] === "child-msg")).toBe(true);
        // The tally of the child lands on the card of the spawn.
        const cardUpdates = updates.filter(update => update["toolCallId"] === "spawn-1");
        expect(cardUpdates.some(update => update["_meta"]?.["_universe/subagentStats"] !== undefined)).toBe(true);
        // The control call is no sub-agent.
        expect(subagentMeta(updates.find(update => update["toolCallId"] === "wait-1")!)).toBeUndefined();
        // The turn state of the child never reaches the root session.
        expect(updates.some(update => update["sessionUpdate"]?.startsWith("turn"))).toBe(false);
    });

    it("sends no trail of a collaboration spawn to a client without the capability", async () => {
        const updates = (await notifyScenario(COLLABORATION_WORK, "plain")).map(entry => entry.update);
        expect(updates.some(update => subagentMeta(update) !== undefined)).toBe(false);
        expect(updates.some(update => parentOf(update) !== undefined)).toBe(false);
        expect(updates.some(update => update["sessionUpdate"] === "agent_message_chunk")).toBe(false);
        // The card of the spawn itself stays.
        expect(updates.some(update => update["toolCallId"] === "spawn-1")).toBe(true);
    });
});
