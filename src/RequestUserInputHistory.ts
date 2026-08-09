import type {UpdateSessionEvent} from "./ACPSessionConnection";

/*
 * fork: shared rendering of a `request_user_input` question card. Live, the
 * app-server surfaces the request as a form elicitation and never exposes it
 * as a thread item, so CodexElicitationHandler re-emits the same
 * tool_call/tool_call_update pair once the user answers — otherwise the
 * settled elicitation card leaves no trace in the client's timeline. The
 * typed-item history carries neither the questions nor the answers, so the
 * replay path rebuilds the same pair from the rollout and shares these
 * renderers (see RequestUserInputReplay), which keeps the live and replayed
 * cards identical.
 */

export type UserInputQuestion = {
    id: string;
    question: string;
    options: Array<{label: string; description: string | null}>;
};

function userInputQuestionText(question: UserInputQuestion): string {
    const lines = [question.question];
    for (const option of question.options) {
        lines.push(option.description ? `- ${option.label} — ${option.description}` : `- ${option.label}`);
    }
    return lines.join("\n");
}

export function createUserInputToolCallEvent(
    toolCallId: string,
    questions: UserInputQuestion[],
): UpdateSessionEvent {
    const first = questions[0];
    return {
        sessionUpdate: "tool_call",
        toolCallId,
        kind: "other",
        title: questions.length === 1 && first ? first.question : "Input requested",
        status: "in_progress",
        content: questions.map((question) => ({
            type: "content",
            content: {type: "text", text: userInputQuestionText(question)},
        })),
    };
}

/*
 * Answer sections mirror the claude fork's AskUserQuestion replay rendering
 * (quoted question, then the bold answer) so both agents' history cards look
 * alike. `output` accepts either the rollout's JSON string or the live answers
 * object (`{ answers: { [questionId]: { answers: [...] } } }`).
 */
export function createUserInputAnswerUpdate(
    toolCallId: string,
    questions: UserInputQuestion[],
    output: unknown,
): UpdateSessionEvent | null {
    const answers = userInputAnswersFromOutput(output);
    if (!answers || questions.length === 0) {
        return null;
    }
    const text = questions.map((question) => {
        const picked = answers.get(question.id) ?? [];
        return [
            `> ${question.question}`,
            `**答案**：${picked.length > 0 ? picked.join(", ") : "（跳过）"}`,
        ].join("\n");
    }).join("\n\n");
    return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{type: "content", content: {type: "text", text}}],
    };
}

function userInputAnswersFromOutput(output: unknown): Map<string, string[]> | null {
    let value: unknown = output;
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    const record = asRecord(value);
    const answers = record ? asRecord(record["answers"]) : null;
    if (!answers) {
        return null;
    }
    const result = new Map<string, string[]>();
    for (const [id, entry] of Object.entries(answers)) {
        const entryRecord = asRecord(entry);
        const list = entryRecord && Array.isArray(entryRecord["answers"]) ? entryRecord["answers"] : [];
        result.set(id, list.filter((answer): answer is string => typeof answer === "string"));
    }
    return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}
