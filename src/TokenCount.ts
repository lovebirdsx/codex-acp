import type {Usage} from "@agentclientprotocol/sdk";
import type {TokenUsageBreakdown} from "./app-server/v2";

/**
 * Token usage information for a turn.
 * This interface decouples our API from Codex's internal types.
 *
 * [totalTokens]: total number of tokens used (the sum of all other fields)
 * [inputTokens]: number of non-cached input tokens
 * [cachedInputTokens]: number of cached input tokens
 * [outputTokens]: number of output tokens (including reasoning output tokens)
 * [reasoningOutputTokens]: number of reasoning output tokens
 */
export interface TokenCount {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
}

/**
 * Maps Codex's TokenUsageBreakdown to our TokenCount interface.
 * This explicit mapping ensures compile-time errors if Codex changes their types.
 * Note: Codex includes cached input tokens in the input token count, so they are subtracted here.
 */
export function toTokenCount(usage: TokenUsageBreakdown): TokenCount {

    return {
        totalTokens: usage.totalTokens,
        inputTokens: usage.inputTokens - usage.cachedInputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
    };
}

/**
 * Adds two token counts field-by-field.
 */
export function sumTokenCounts(left: TokenCount, right: TokenCount): TokenCount {
    return {
        totalTokens: left.totalTokens + right.totalTokens,
        inputTokens: left.inputTokens + right.inputTokens,
        cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
        outputTokens: left.outputTokens + right.outputTokens,
        reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    };
}

/**
 * Aggregates the main-thread cumulative usage with every sub-agent thread's
 * latest snapshot. Sub-agent threads each report their own cumulative
 * `thread/tokenUsage/updated` snapshots; folding them into the session total
 * is what lets the client price sub-agent work. Returns null when there is no
 * usage at all (main thread included).
 */
export function aggregateTokenCounts(
    primary: TokenCount | null,
    subagents: Iterable<TokenCount>,
): TokenCount | null {
    let result = primary;
    for (const subagent of subagents) {
        result = result == null ? subagent : sumTokenCounts(result, subagent);
    }
    return result;
}

/**
 * Maps our per-turn token breakdown to ACP PromptResponse usage fields.
 * Cached input tokens are reported as ACP cache reads, and reasoning output
 * tokens are exposed through ACP's thoughtTokens field.
 */
export function toPromptUsage(tokenCount: TokenCount): Usage {
    return {
        totalTokens: tokenCount.totalTokens,
        inputTokens: tokenCount.inputTokens,
        cachedReadTokens: tokenCount.cachedInputTokens,
        outputTokens: tokenCount.outputTokens,
        thoughtTokens: tokenCount.reasoningOutputTokens,
    };
}
