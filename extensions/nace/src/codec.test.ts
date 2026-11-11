import type { DecisionBatchV2 } from "openclaw/plugin-sdk/decisions";
import { describe, expect, it } from "vitest";
import { decodeNaceResponse, encodeNaceRequest } from "./codec.js";

const questions = {
  urgent: { type: "boolean", instructions: "Is this urgent?", criteria: null },
  route: {
    type: "choice",
    instructions: "Which team?",
    criteria: { support: "Service failures", billing: null },
  },
  impact: { type: "score", criteria: ["None", { level: "high" }] },
} satisfies DecisionBatchV2["questions"];
const batch: DecisionBatchV2 = { state: { type: "text", text: "Checkout is down." }, questions };
const png = "data:image/png;base64,iVBORw0KGgo=";

const wire = {
  model: "drex-max-v1.1",
  answers: {
    urgent: { type: "noul", noul: 0.98, confidence: 0.98 },
    route: {
      type: "choice",
      choice: "support",
      confidence: 0.9,
      probabilities: { support: 0.93, billing: 0.07 },
    },
    impact: {
      type: "score",
      score: 0.8,
      confidence: 0.6,
      legend: ["None", '{"level":"high"}'],
      probabilities: { "0": 0.2, "1": 0.8 },
    },
  },
  usage: { input_tokens: 41, output_tokens: 9 },
  evaluation_time_ms: 120.5,
  request_id: "req_synthetic",
};

describe("encodeNaceRequest", () => {
  it("renames boolean to noul, keeps ids, and omits null criteria", () => {
    expect(encodeNaceRequest(batch, "drex-latest")).toEqual({
      model: "drex-latest",
      state: "Checkout is down.",
      questions: {
        urgent: { type: "noul", instructions: "Is this urgent?" },
        route: questions.route,
        impact: questions.impact,
      },
    });
  });

  it("sends JSON state unchanged", () => {
    const state = { ticket: { id: 7, tags: ["a", null] } };
    expect(
      encodeNaceRequest({ ...batch, state: { type: "json", value: state } }, "m")?.state,
    ).toEqual(state);
  });

  it("sends an image through the top-level images array, with its text as state", () => {
    const image = { type: "image" as const, dataUri: png, text: "Listing photo" };
    expect(encodeNaceRequest({ ...batch, state: image }, "drex-max-v1.1")).toMatchObject({
      state: "Listing photo",
      images: [png],
    });
    expect(
      encodeNaceRequest({ ...batch, state: { type: "image", dataUri: png } }, "drex-latest"),
    ).toMatchObject({ state: "", images: [png] });
  });

  it.each([
    [
      "an image on a text-only model",
      { ...batch, state: { type: "image", dataUri: png } },
      "drex-v2.0",
    ],
    ["list state", { ...batch, state: { type: "list", items: [] } }, "drex-max-v1.1"],
    [
      "a box question",
      {
        state: { type: "image", dataUri: png },
        questions: { b: { type: "box", instructions: "the logo" } },
      },
      "drex-latest",
    ],
    [
      "a sort question",
      {
        state: {
          type: "list",
          items: [
            { id: "a", content: "x" },
            { id: "b", content: "y" },
          ],
        },
        questions: { s: { type: "sort", instructions: "by urgency" } },
      },
      "drex-latest",
    ],
    [
      "a blank question id",
      { ...batch, questions: { " ": { type: "boolean", instructions: "x" } } },
      "drex-latest",
    ],
  ] as const)("refuses %s without sending anything", (_name, input, model) => {
    expect(encodeNaceRequest(input as DecisionBatchV2, model)).toBeUndefined();
  });

  it("refuses more than 255 options", () => {
    const options = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, "d"]));
    expect(
      encodeNaceRequest(
        { ...batch, questions: { c: { type: "choice", criteria: options } } },
        "drex-latest",
      ),
    ).toBeUndefined();
  });
});

describe("decodeNaceResponse", () => {
  it("keeps typed answers, probabilities, usage and the request id", () => {
    expect(decodeNaceResponse(batch, wire)).toEqual({
      model: "drex-max-v1.1",
      answers: {
        urgent: { type: "boolean", probabilityTrue: 0.98 },
        route: {
          type: "choice",
          choice: "support",
          probabilities: { support: 0.93, billing: 0.07 },
          confidence: 0.9,
        },
        impact: { type: "score", score: 0.8, probabilities: [0.2, 0.8], confidence: 0.6 },
      },
      usage: { inputTokens: 41, outputTokens: 9 },
      metadata: { requestId: "req_synthetic" },
    });
  });

  it("accepts image token usage alongside the counted usage", () => {
    const result = decodeNaceResponse(batch, {
      ...wire,
      usage: { input_tokens: 300, output_tokens: 9, image_tokens: 256 },
    });
    expect(result?.usage).toMatchObject({ inputTokens: 300, outputTokens: 9 });
  });

  it.each([
    ["a missing answer", { ...wire, answers: { ...wire.answers, urgent: undefined } }],
    [
      "a choice outside the rubric",
      {
        ...wire,
        answers: { ...wire.answers, route: { ...wire.answers.route, choice: "sales" } },
      },
    ],
    [
      "score probabilities that miss a level",
      {
        ...wire,
        answers: { ...wire.answers, impact: { ...wire.answers.impact, probabilities: { "0": 1 } } },
      },
    ],
    ["missing usage", { ...wire, usage: undefined }],
    ["a non-object body", "ok"],
  ])("rejects %s", (_name, body) => {
    expect(decodeNaceResponse(batch, body)).toBeUndefined();
  });
});
