import assert from "node:assert/strict";
import { validateDecisionResultV2, type DecisionBatchV2 } from "openclaw/plugin-sdk/decisions";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { HOSTED_BASE_URL } from "./config.js";
import { createNaceDecisionProvider } from "./provider.js";

const live = process.env.OPENCLAW_LIVE_TEST === "1" && Boolean(process.env.NACE_API_KEY);

it.runIf(live).each([
  { kind: "text", model: "drex-v2.0" },
  { kind: "text", model: "drex-latest" },
  { kind: "image", model: "drex-latest" },
])(
  "evaluates a synthetic $kind batch on $model through the registered Nace provider",
  async ({ kind, model }) => {
    const apiKey = process.env.NACE_API_KEY;
    assert(apiKey);
    const provider = createNaceDecisionProvider(() => ({
      apiKey,
      baseUrl: process.env.NACE_BASE_URL ?? HOSTED_BASE_URL,
    }));
    const batch: DecisionBatchV2 = {
      state:
        kind === "image"
          ? {
              type: "image",
              dataUri: `data:image/png;base64,${createSolidPngBuffer(320, 320, { r: 255, g: 0, b: 0 }).toString("base64")}`,
              text: "Inspect the image.",
            }
          : { type: "text", text: "The square is entirely red." },
      questions: {
        red: { type: "boolean", instructions: "Is the square red?" },
        color: {
          type: "choice",
          instructions: "What is the dominant color?",
          criteria: { red: "Red", blue: "Blue" },
        },
        coverage: {
          type: "score",
          instructions: "How much of the square is red?",
          criteria: ["None", "About half", "All"],
        },
      },
    };
    const outcome = await provider.evaluate(batch, {
      model: { provider: "nace", id: model, name: model },
      config: {},
      auth: { mode: "api-key", apiKey },
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 30_000,
      isAdmissible: () => true,
    });
    if (outcome.status !== "ok") {
      throw new Error(`Nace live evaluation unavailable: ${outcome.reason}`);
    }
    expect(validateDecisionResultV2(batch, outcome.result)).toBe(true);
    const { answers, usage, metadata } = outcome.result;
    expect(answers.color).toMatchObject({ type: "choice", choice: "red" });
    assert(answers.red?.type === "boolean" && answers.coverage?.type === "score");
    expect(answers.red.probabilityTrue).toBeGreaterThan(0.5);
    expect(answers.coverage.score).toBeGreaterThan(1);
    // Only synthetic answers, usage and the request id; never headers or the key.
    console.log(JSON.stringify({ kind, model, requestId: metadata?.requestId, answers, usage }));
    expect(usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
  },
  40_000,
);
