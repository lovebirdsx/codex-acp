import type {ServerNotification} from "../app-server";
import type {ThreadItem} from "../app-server/v2";
import type {UpdateSessionEvent} from "../ACPSessionConnection";

/*
 * Fork addition: the sub-agent trail of a client that reads the work of a sub-agent without
 * native subagent sessions (`clientCapabilities._meta["subagent-transcript"]`). The universe-editor
 * declares the capability; the claude fork reads the same literal for its flattened transcript.
 */

/**
 * The item types of a child thread that the client reads.
 *
 * `agentMessage` is here for the replay: a child turn holds its text as an item, while the live
 * session streams it as `item/agentMessage/delta`. The renderers already resolve the overlap the
 * way they do for the root thread: an `agentMessage` item renders to nothing on both events,
 * because its text is either streaming (live) or read from the item (replay).
 */
const TRANSCRIPT_ITEM_TYPES = new Set<string>([
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "webSearch",
    "imageView",
    "imageGeneration",
    "reasoning",
    "agentMessage",
]);

/** Tells whether an item of a child thread carries the work of the sub-agent. */
export function isChildTranscriptItem(item: ThreadItem): boolean {
    return TRANSCRIPT_ITEM_TYPES.has(item.type);
}

/**
 * Tells whether a notification of a child thread carries the work of the sub-agent.
 *
 * Lifecycle and thread state stay out: turns, plans, compaction, errors and approvals describe the
 * child conversation rather than what the sub-agent did, and the root turn state must not see them.
 * The terminal state of a sub-agent reaches the client as a `subAgentActivity` card instead.
 */
export function isChildTranscriptNotification(notification: ServerNotification): boolean {
    switch (notification.method) {
        case "item/started":
        case "item/completed":
            return isChildTranscriptItem(notification.params.item);
        case "item/agentMessage/delta":
        case "item/reasoning/summaryTextDelta":
        case "item/reasoning/summaryPartAdded":
        case "item/reasoning/textDelta":
        case "item/commandExecution/outputDelta":
        case "item/commandExecution/terminalInteraction":
        case "item/mcpToolCall/progress":
            return true;
        default:
            return false;
    }
}

/**
 * Attributes an update of a child thread to the card of the sub-agent activity that spawned it.
 * The client nests the update under that card, the way the claude fork attributes a sub-agent
 * update with `_meta.claudeCode.parentToolUseId`.
 */
export function stampChildParentToolCallId(
    update: UpdateSessionEvent,
    parentToolCallId: string,
): UpdateSessionEvent {
    const meta = (update as {_meta?: Record<string, unknown> | null})._meta;
    const codex = meta?.["codex"];
    return {
        ...update,
        _meta: {
            ...meta,
            codex: {
                ...(codex !== null && typeof codex === "object" ? codex : {}),
                parentToolCallId,
            },
        },
    } as UpdateSessionEvent;
}
