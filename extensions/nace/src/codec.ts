import {
  decodeSystemOneResponse,
  encodeSystemOneQuestions,
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatchResultV2,
  type DecisionBatchV2,
  type JsonValue,
} from "openclaw/plugin-sdk/decisions";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "../openclaw.plugin.json" with { type: "json" };

export type NaceRequest = {
  readonly model: string;
  readonly state: JsonValue;
  readonly images?: readonly string[];
  readonly questions: Readonly<Record<string, unknown>>;
};

const MODELS = manifest.modelCatalog.providers.nace.models;
const MAX_OPTIONS = 255;
const IMAGE_DATA_URI = /^data:image\/(?:png|jpeg|webp);base64,/;

export function supportsImages(model: string): boolean {
  return (MODELS.find((entry) => entry.id === model)?.inference.decision.input ?? []).some(
    (kind) => kind === "image",
  );
}

function admitsQuestions(batch: DecisionBatchV2): boolean {
  // The host already bounds question count (400) and requires at least two options.
  return Object.entries(batch.questions).every(([id, question]) => {
    if (id.trim() === "") {
      return false;
    }
    switch (question.type) {
      case "boolean":
        return true;
      case "choice":
        return Object.keys(question.criteria).length <= MAX_OPTIONS;
      case "score":
        return question.criteria.length <= MAX_OPTIONS;
      case "sort":
      case "box":
      case "tags":
        return false;
      default: {
        const unknown: never = question;
        return unknown;
      }
    }
  });
}

/** Translate an admitted batch to the System One body, or undefined when Nace cannot take it. */
export function encodeNaceRequest(batch: DecisionBatchV2, model: string): NaceRequest | undefined {
  if (!validateDecisionBatchV2(batch) || !admitsQuestions(batch)) {
    return undefined;
  }
  const questions = Object.fromEntries(
    Object.entries(encodeSystemOneQuestions(batch)).map(([id, question]) => [
      id,
      "criteria" in question && question.criteria === null
        ? Object.fromEntries(Object.entries(question).filter(([key]) => key !== "criteria"))
        : question,
    ]),
  );
  const { state } = batch;
  switch (state.type) {
    case "text":
      return { model, state: state.text, questions };
    case "json":
      return { model, state: state.value, questions };
    case "image":
      return supportsImages(model) && IMAGE_DATA_URI.test(state.dataUri)
        ? { model, state: state.text ?? "", images: [state.dataUri], questions }
        : undefined;
    case "list":
      return undefined;
    default: {
      const unknown: never = state;
      return unknown;
    }
  }
}

/** Decode a System One response, preserve Nace's request id, and validate it against the batch. */
export function decodeNaceResponse(
  batch: DecisionBatchV2,
  wire: unknown,
): DecisionBatchResultV2 | undefined {
  const decoded = decodeSystemOneResponse(batch, wire, { confidence: "optional" });
  if (!isRecord(decoded) || !isRecord(wire)) {
    return undefined;
  }
  const requestId = typeof wire.request_id === "string" ? wire.request_id : undefined;
  const result = {
    ...decoded,
    ...(requestId === undefined ? {} : { metadata: { requestId } }),
  };
  return validateDecisionResultV2(batch, result) ? result : undefined;
}
