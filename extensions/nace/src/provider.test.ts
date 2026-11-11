import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  DecisionProviderV2,
} from "openclaw/plugin-sdk/decisions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import type * as SecretInputRuntime from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import pkg from "../package.json" with { type: "json" };
import { resolveRuntimeConfig } from "./config.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SecretInputRuntime>()),
  getPreparedPluginSecretInput: vi.fn(),
}));

const HOSTED = "https://console.nace.ai/v1/systemone";
const batch: DecisionBatchV2 = {
  state: { type: "json", value: { message: "Checkout is failing for all customers." } },
  questions: {
    escalate: {
      type: "boolean",
      instructions: "Does this need incident response?",
      criteria: { true: "Widespread outage", false: "Routine request" },
    },
    route: {
      type: "choice",
      criteria: { support: "Service failures", billing: "Payment questions" },
    },
    urgency: { type: "score", criteria: ["No disruption", "Workflow blocked", "Outage"] },
  },
};
const goodResponse = {
  model: "drex-max-v1.1",
  answers: {
    escalate: { type: "noul", noul: 0.96, confidence: 0.96 },
    route: {
      type: "choice",
      choice: "support",
      confidence: 0.97,
      probabilities: { support: 0.97, billing: 0.03 },
    },
    urgency: {
      type: "score",
      score: 1.85,
      confidence: 0.7,
      legend: ["No disruption", "Workflow blocked", "Outage"],
      probabilities: { "0": 0.02, "1": 0.11, "2": 0.87 },
    },
  },
  usage: { input_tokens: 88, output_tokens: 14 },
  evaluation_time_ms: 91.2,
  request_id: "req_synthetic",
};

function mockFetch(respond: () => Response) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

function registered(
  config: Record<string, unknown> = {},
  apiKey: () => string | undefined = () => "synthetic-key",
): DecisionProviderV2 {
  vi.mocked(getPreparedPluginSecretInput).mockImplementation(
    () => ({ value: apiKey() }) as ReturnType<typeof getPreparedPluginSecretInput>,
  );
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  const api = createTestPluginApi({
    id: "nace",
    runtime: createPluginRuntimeMock({
      config: { current: () => ({ plugins: { entries: { nace: { config } } } }) },
    }),
    registerDecisionProvider,
  });
  plugin.register(api);
  const provider = registerDecisionProvider.mock.calls[0]![0];
  if (provider.contractVersion !== 2) {
    throw new Error("Expected the prepared Nace provider");
  }
  return provider;
}
const context = (
  overrides: Partial<DecisionProviderContextV2> = {},
): DecisionProviderContextV2 => ({
  model: { provider: "nace", id: "drex-latest", name: "Drex" },
  config: {},
  auth: { mode: "api-key", apiKey: "synthetic-key" },
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 2000,
  isAdmissible: () => true,
  ...overrides,
});
const sentHeaders = (fetch: ReturnType<typeof mockFetch>) =>
  new Headers(fetch.mock.lastCall?.[1]?.headers);
const sentBody = (fetch: ReturnType<typeof mockFetch>) => {
  const body = fetch.mock.lastCall?.[1]?.body;
  return JSON.parse(typeof body === "string" ? body : "null");
};
const sentUrl = (fetch: ReturnType<typeof mockFetch>) => {
  const input = fetch.mock.calls[0]![0];
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
};

beforeEach(() => {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    vi.stubEnv(key, "");
    vi.stubEnv(key.toLowerCase(), "");
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registration", () => {
  it("registers the nace V2 provider with plugin-scoped synthetic auth", () => {
    const provider = registered();
    expect(provider).toMatchObject({ id: "nace", contractVersion: 2 });
    expect(provider.provider?.resolveSyntheticAuth?.({} as never)).toMatchObject({
      apiKey: "synthetic-key",
      mode: "api-key",
    });
  });

  it("offers no synthetic auth and the hosted route without a credential", () => {
    const provider = registered({}, () => undefined);
    expect(provider.provider?.resolveSyntheticAuth?.({} as never)).toBeUndefined();
    expect(
      provider.provider?.normalizeTransport?.({
        provider: "nace",
        modelId: "drex-latest",
      } as never),
    ).toEqual({ baseUrl: "https://console.nace.ai/v1" });
    expect(
      provider.provider?.normalizeTransport?.({ provider: "openai", modelId: "gpt" } as never),
    ).toBeUndefined();
  });
});

describe("evaluate", () => {
  it("sends one attributed request to Nace and returns typed answers", async () => {
    const fetch = mockFetch(() => json(goodResponse));
    const outcome = await registered().evaluate(batch, context());

    expect(fetch).toHaveBeenCalledOnce();
    expect(sentUrl(fetch)).toBe(HOSTED);
    const headers = sentHeaders(fetch);
    expect(headers.get("authorization")).toBe("Bearer synthetic-key");
    const client = headers.get("x-nace-client")!;
    expect(client).toBe(`openclaw-nace/${pkg.version}`);
    expect(client).toMatch(/^[A-Za-z0-9 ._@+-]+\/[A-Za-z0-9 ._@+-]+$/);
    expect(client.length).toBeLessThanOrEqual(64);
    expect(sentBody(fetch)).toEqual({
      model: "drex-latest",
      state: { message: "Checkout is failing for all customers." },
      questions: {
        escalate: {
          type: "noul",
          instructions: "Does this need incident response?",
          criteria: { true: "Widespread outage", false: "Routine request" },
        },
        route: batch.questions.route,
        urgency: batch.questions.urgency,
      },
    });
    expect(outcome).toEqual({
      status: "ok",
      result: {
        model: "drex-max-v1.1",
        answers: {
          escalate: { type: "boolean", probabilityTrue: 0.96 },
          route: {
            type: "choice",
            choice: "support",
            probabilities: { support: 0.97, billing: 0.03 },
            confidence: 0.97,
          },
          urgency: {
            type: "score",
            score: 1.85,
            probabilities: [0.02, 0.11, 0.87],
            confidence: 0.7,
          },
        },
        usage: { inputTokens: 88, outputTokens: 14 },
        metadata: { requestId: "req_synthetic" },
      },
    });
  });

  it("sends an image to an image-capable model and refuses it on Drex 2.0", async () => {
    const fetch = mockFetch(() => json(goodResponse));
    const withImage: DecisionBatchV2 = {
      ...batch,
      state: { type: "image", dataUri: "data:image/png;base64,iVBORw0KGgo=", text: "Photo" },
    };
    const provider = registered();
    await provider.evaluate(withImage, context());
    expect(sentBody(fetch)).toMatchObject({
      state: "Photo",
      images: ["data:image/png;base64,iVBORw0KGgo="],
    });

    fetch.mockClear();
    const refused = await provider.evaluate(
      withImage,
      context({ model: { provider: "nace", id: "drex-v2.0", name: "Drex 2.0" } }),
    );
    expect(refused).toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports missing credentials without any network call", async () => {
    const fetch = mockFetch(() => json(goodResponse));
    const outcome = await registered().evaluate(
      batch,
      context({ auth: { mode: "api-key", apiKey: undefined } }),
    );
    expect(outcome).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authentication", {}, undefined],
    [403, "authentication", {}, undefined],
    [402, "transport", {}, undefined],
    [422, "unsupported-input", {}, undefined],
    [500, "transport", {}, undefined],
    [529, "transport", {}, undefined],
    [429, "rate-limited", { "retry-after-ms": "250" }, 250],
  ] as const)(
    "maps HTTP %s to %s, once, without reading the body",
    async (status, reason, headers, retryAfterMs) => {
      const pull = vi.fn(() => {
        throw new Error("synthetic credential and submitted state");
      });
      const cancel = vi.fn();
      const fetch = mockFetch(
        () =>
          new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
            status,
            headers,
          }),
      );
      const outcome = await registered().evaluate(batch, context());
      expect(outcome).toEqual({ status: "unavailable", reason, retryAfterMs });
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("treats a transport failure as unavailable and does not retry", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetch);
    const outcome = await registered().evaluate(batch, context());
    expect(outcome).toEqual({ status: "unavailable", reason: "transport" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["a missing answer", { ...goodResponse, answers: { escalate: goodResponse.answers.escalate } }],
    ["no usage", { ...goodResponse, usage: undefined }],
    [
      "a choice outside the rubric",
      {
        ...goodResponse,
        answers: {
          ...goodResponse.answers,
          route: { ...goodResponse.answers.route, choice: "other" },
        },
      },
    ],
  ])("returns invalid-response for %s", async (_name, body) => {
    mockFetch(() => json(body));
    expect(await registered().evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "invalid-response",
    });
  });

  it("rejects a response that reflects the credential", async () => {
    mockFetch(() => json({ ...goodResponse, request_id: "echo synthetic-key" }));
    expect(await registered().evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "invalid-response",
    });
  });

  it("refuses a rotated credential before sending", async () => {
    const fetch = mockFetch(() => json(goodResponse));
    let key: string | undefined = "synthetic-key";
    const provider = registered({}, () => key);
    key = "rotated-key";
    expect(await provider.evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "transport",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses input Nace cannot take and non-auto reasoning before sending", async () => {
    const fetch = mockFetch(() => json(goodResponse));
    const provider = registered();
    const list: DecisionBatchV2 = { ...batch, state: { type: "list", items: [] } };
    expect(await provider.evaluate(list, context())).toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
    expect(await provider.evaluate(batch, context({ reasoning: "on" }))).toEqual({
      status: "unavailable",
      reason: "unsupported-input",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rethrows cancellation instead of turning it into an outcome", async () => {
    const controller = new AbortController();
    mockFetch(() => {
      controller.abort(new Error("cancelled"));
      throw new Error("aborted");
    });
    await expect(
      registered().evaluate(batch, context({ signal: controller.signal })),
    ).rejects.toThrow("cancelled");
  });

  it("uses a configured loopback base URL and keeps the attribution header", async () => {
    const fetch = mockFetch(() => json(goodResponse));
    await registered({ baseUrl: "http://127.0.0.1:8765" }).evaluate(batch, context());
    expect(sentUrl(fetch)).toBe("http://127.0.0.1:8765/v1/systemone");
    expect(sentHeaders(fetch).get("x-nace-client")).toBe(`openclaw-nace/${pkg.version}`);
  });
});

describe("configuration", () => {
  const snapshot = (config: Record<string, unknown>) =>
    ({ plugins: { entries: { nace: { config } } } }) as never;
  const key = () => "k";

  it("defaults to the hosted API root", () => {
    expect(resolveRuntimeConfig(snapshot({}), key)).toEqual({
      apiKey: "k",
      baseUrl: "https://console.nace.ai/v1",
    });
  });

  it.each([
    ["https://drex.nace.ai", "https://drex.nace.ai/v1"],
    ["https://console.nace.ai/v1/", "https://console.nace.ai/v1"],
    ["http://localhost:3000", "http://localhost:3000/v1"],
  ])("accepts %s", (baseUrl, expected) => {
    expect(resolveRuntimeConfig(snapshot({ baseUrl }), key).baseUrl).toBe(expected);
  });

  it.each([
    "https://evil.example.com/v1",
    "https://console.nace.ai.evil.example/v1",
    "https://user:pw@console.nace.ai/v1",
    "http://console.nace.ai/v1",
    "http://10.0.0.5:3000",
    " https://console.nace.ai/v1",
  ])("rejects base URL %s before any credential is sent", (baseUrl) => {
    expect(() => resolveRuntimeConfig(snapshot({ baseUrl }), key)).toThrow("Invalid Nace baseUrl");
  });

  it("treats a blank credential as missing", () => {
    expect(resolveRuntimeConfig(snapshot({}), () => "  ").apiKey).toBeUndefined();
  });
});
