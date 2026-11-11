import type {
  ProviderDecisionOutcomeV2,
  ProviderFailureReason,
} from "openclaw/plugin-sdk/decisions";

export class EvaluationError extends Error {
  constructor(
    message: string,
    readonly reason: ProviderFailureReason,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EvaluationError";
  }
}

/** Only these fixed outcomes leave the plugin; raw causes and Nace error bodies stay discarded. */
export function decisionFailure(
  error: unknown,
): Extract<ProviderDecisionOutcomeV2, { status: "unavailable" }> {
  if (error instanceof EvaluationError) {
    return {
      status: "unavailable",
      reason: error.reason,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  return { status: "unavailable", reason: "invalid-response" };
}
