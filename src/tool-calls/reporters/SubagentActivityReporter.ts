import type {ThreadItem} from "../../app-server/v2";
import type {ToolFacts} from "../ToolFacts";

type SubAgentActivityItem = ThreadItem & {type: "subAgentActivity"};

/** Reports a Codex subagent activity, for a client without native subagent sessions. */
export class SubagentActivityReporter {
    static activity(
        item: SubAgentActivityItem,
        status: "in_progress" | "completed",
        report: ToolFacts["report"],
        timing?: ToolFacts["subagentTiming"],
    ): ToolFacts {
        const name = item.agentPath.split("/").filter(Boolean).at(-1) ?? "subagent";
        return {
            toolCallId: item.id,
            report,
            ...(report === "start" ? {kind: "other" as const, title: activityTitle(item.kind, name)} : {}),
            status,
            input: {
                agentThreadId: item.agentThreadId,
                agentPath: item.agentPath,
                activityKind: item.kind,
            },
            subagent: true,
            subagentInfo: {threadId: item.agentThreadId, path: item.agentPath, activity: item.kind},
            ...(timing === undefined ? {} : {subagentTiming: timing}),
        };
    }
}

function activityTitle(kind: SubAgentActivityItem["kind"], name: string): string {
    switch (kind) {
        case "started":
            return `Start subagent ${name}`;
        case "interacted":
            return `Interact with subagent ${name}`;
        case "interrupted":
            return `Interrupt subagent ${name}`;
        case "completed":
            return `Complete subagent ${name}`;
    }
}
