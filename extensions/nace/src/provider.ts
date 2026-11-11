import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { decodeNaceResponse, encodeNaceRequest } from "./codec.js";
import type { RuntimeConfig } from "./config.js";
import { decisionFailure } from "./errors.js";

const loadClient = createLazyRuntimeModule(() => import("./client.js"));

/** One provider: Nace's hosted System One route, selected as `nace/<model>`. */
export function createNaceDecisionProvider(getConfig: () => RuntimeConfig): DecisionProviderV2 {
  return {
    id: "nace",
    contractVersion: 2,
    provider: {
      label: "Nace Drex",
      auth: [],
      authScope: "plugin",
      resolveSyntheticAuth: () => {
        const { apiKey } = getConfig();
        return apiKey ? { apiKey, source: "nace plugin", mode: "api-key" } : undefined;
      },
      normalizeTransport: ({ provider }) =>
        provider === "nace" ? { baseUrl: getConfig().baseUrl } : undefined,
    },
    async evaluate(batch, context) {
      const { signal, deadlineMonotonicMs, isAdmissible } = context;
      signal.throwIfAborted();
      if (context.reasoning !== undefined && context.reasoning !== "auto") {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const request = encodeNaceRequest(batch, context.model.id);
      if (!request) {
        return { status: "unavailable", reason: "unsupported-input" };
      }
      const apiKey = context.auth.apiKey;
      if (!apiKey) {
        return { status: "unavailable", reason: "credentials-unavailable" };
      }
      const { postSystemOne } = await loadClient();
      signal.throwIfAborted();
      const config = { ...getConfig(), apiKey };
      let wire: unknown;
      try {
        wire = await postSystemOne({
          body: JSON.stringify(request),
          config,
          signal,
          deadlineMonotonicMs,
          // Only the current owner of the credential may authorize egress.
          isAdmissible: () => isAdmissible() && getConfig().apiKey === apiKey,
        });
      } catch (error) {
        signal.throwIfAborted();
        return decisionFailure(error);
      }
      signal.throwIfAborted();
      const result = decodeNaceResponse(batch, wire);
      return result
        ? { status: "ok", result }
        : { status: "unavailable", reason: "invalid-response" };
    },
  };
}
