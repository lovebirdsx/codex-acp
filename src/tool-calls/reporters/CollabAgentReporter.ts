import type {ThreadItem} from "../../app-server/v2";
import type {ToolFacts} from "../ToolFacts";
import {toToolStatus} from "./ToolStatus";

type CollabAgentToolCallItem = ThreadItem & {type: "collabAgentToolCall"};

/**
 * Reports a Codex collaboration tool call, for a client without native subagent sessions.
 * The prompt is input that the user reads.
 * `rawInput` keeps `senderThreadId`, `receiverThreadIds`, and `agentsStates`, because AIR recognizes
 * a collaboration tool call by these three keys.
 * Only a spawn is a subagent. A wait, a message, a resume, or a close controls an existing subagent.
 * A client that is not AIR also gets the Codex `status` in `rawInput`.
 * The spawn card is the card of the threads it created: a client that reads the sub-agent trail
 * nests their work under it (`subagentInfo`). The app-server names those threads only in the
 * completed item.
 */
export class CollabAgentReporter {
    static started(item: CollabAgentToolCallItem): ToolFacts {
        return {
            ...facts(item, "start"),
            kind: "other",
            ...(item.prompt ? {readableInput: item.prompt} : {}),
        };
    }

    static completed(item: CollabAgentToolCallItem): ToolFacts {
        return facts(item, "update");
    }
}

function facts(item: CollabAgentToolCallItem, report: ToolFacts["report"]): ToolFacts {
    const input = {
        prompt: item.prompt,
        senderThreadId: item.senderThreadId,
        receiverThreadIds: item.receiverThreadIds,
        agentsStates: item.agentsStates,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
    };
    return {
        toolCallId: item.id,
        report,
        title: item.tool,
        status: toToolStatus(item.status),
        input,
        ...(item.tool === "spawnAgent" ? {subagent: true, subagentInfo: spawnInfo(item)} : {}),
        standard: {
            content: null,
            rawInput: {...input, status: item.status},
            rawOutput: null,
        },
    };
}

function spawnInfo(item: CollabAgentToolCallItem): NonNullable<ToolFacts["subagentInfo"]> {
    // A spawn that created several threads at once names none of them: the card is theirs.
    const threadId = item.receiverThreadIds.length === 1 ? item.receiverThreadIds[0] : undefined;
    return threadId === undefined ? {activity: item.tool} : {threadId, activity: item.tool};
}
