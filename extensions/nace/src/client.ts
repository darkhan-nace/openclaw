import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  responseWithRelease,
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  fetchWithProviderHttpGuard,
  resolveProviderHttpRequestConfigWithOriginTrust,
  resolveProviderTransportSsrFPolicy,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { parseRetryAfterHeaderSeconds } from "openclaw/plugin-sdk/retry-runtime";
import pkg from "../package.json" with { type: "json" };
import { HOSTED_BASE_URL, type RuntimeConfig } from "./config.js";
import { EvaluationError } from "./errors.js";

/** Drex counts state, questions and inline images together against this body limit. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export const CLIENT_NAME = "openclaw-nace";
export const CLIENT_HEADER_VALUE = `${CLIENT_NAME}/${pkg.version}`;

function httpError(response: Response): EvaluationError {
  const { status } = response;
  if (status === 401 || status === 403) {
    return new EvaluationError(
      "Nace authentication failed; check the configured API key.",
      "authentication",
    );
  }
  if (status === 429) {
    const milliseconds = response.headers.get("retry-after-ms");
    const parsedMilliseconds = milliseconds?.trim() ? Number(milliseconds) : Number.NaN;
    const seconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
    const retryAfterMs =
      Number.isFinite(parsedMilliseconds) && parsedMilliseconds >= 0
        ? parsedMilliseconds
        : seconds === undefined
          ? undefined
          : seconds * 1000;
    return new EvaluationError(
      "Nace rate limit reached; retry later.",
      "rate-limited",
      retryAfterMs,
    );
  }
  if (status === 400 || status === 413 || status === 422) {
    return new EvaluationError("Nace rejected the supplied input.", "unsupported-input");
  }
  if (status === 402) {
    return new EvaluationError(
      "Nace account has insufficient credit or a payment problem.",
      "transport",
    );
  }
  return new EvaluationError("Nace service rejected the evaluation request.", "transport");
}

export type NaceTransportRequest = {
  readonly body: string;
  readonly config: RuntimeConfig & { readonly apiKey: string };
  readonly signal: AbortSignal;
  readonly deadlineMonotonicMs: number;
  readonly isAdmissible: () => boolean;
};

/** POST one System One request. No retries, no ambient credentials, no error-body reads. */
export async function postSystemOne(request: NaceTransportRequest): Promise<unknown> {
  const { body, config, signal: callerSignal, deadlineMonotonicMs, isAdmissible } = request;
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    throw new EvaluationError("Nace request exceeds its size limit.", "unsupported-input");
  }
  const timeoutMs = deadlineMonotonicMs - performance.now();
  if (timeoutMs <= 0) {
    throw new EvaluationError("Nace evaluation timed out.", "transport");
  }
  const custom = config.baseUrl !== HOSTED_BASE_URL;
  const resolved = resolveProviderHttpRequestConfigWithOriginTrust({
    provider: "nace",
    capability: "other",
    transport: "http",
    baseUrl: config.baseUrl,
    defaultBaseUrl: HOSTED_BASE_URL,
    defaultHeaders: {
      Authorization: `Bearer ${config.apiKey}`,
      "X-Nace-Client": CLIENT_HEADER_VALUE,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  const endpoint = `${resolved.baseUrl}/systemone`;
  const policy = custom
    ? resolveProviderTransportSsrFPolicy({
        baseUrl: resolved.baseUrl,
        url: endpoint,
        allowPrivateNetwork: resolved.allowPrivateNetwork,
        trustConfiguredBaseUrlOrigin: resolved.trustConfiguredBaseUrlOrigin,
      })
    : undefined;
  const { signal, cleanup } = buildTimeoutAbortSignal({
    signal: callerSignal,
    timeoutMs,
    operation: "Nace evaluation",
  });
  let authorityFailure: { readonly error: unknown } | undefined;
  const assertActive = () => {
    signal?.throwIfAborted();
    let admitted: boolean;
    try {
      admitted = isAdmissible();
    } catch (error) {
      authorityFailure = { error };
      throw error;
    }
    if (performance.now() >= deadlineMonotonicMs || !admitted) {
      throw new EvaluationError("Nace evaluation is no longer admitted.", "transport");
    }
  };
  try {
    assertActive();
    const guardedRequest = {
      url: endpoint,
      fetchImpl: globalThis.fetch,
      requireHttps: !custom || new URL(endpoint).protocol === "https:",
      policy,
      dispatcherPolicy: resolved.dispatcherPolicy,
      maxRedirects: 0,
      signal,
      beforeRequest: assertActive,
      init: { method: "POST", headers: resolved.headers, body },
    };
    const guarded = await fetchWithProviderHttpGuard(
      !custom && !resolved.dispatcherPolicy && shouldUseEnvHttpProxyForUrl(endpoint)
        ? withTrustedEnvProxyGuardedFetchMode(guardedRequest)
        : guardedRequest,
    );
    let releasePromise: Promise<void> | undefined;
    const release = () => (releasePromise ??= Promise.resolve().then(() => guarded.release()));
    try {
      const response = responseWithRelease(guarded.response, release);
      if (!response.ok) {
        await response.body?.cancel();
        throw httpError(response);
      }
      const bytes = await readResponseWithLimit(response, MAX_RESPONSE_BYTES, {
        signal,
        onOverflow: () =>
          new EvaluationError("Nace response exceeds its size limit.", "invalid-response"),
      });
      let text: string;
      let payload: unknown;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        payload = JSON.parse(text);
      } catch {
        throw new EvaluationError("Nace returned invalid JSON.", "invalid-response");
      }
      if (text.includes(config.apiKey)) {
        throw new EvaluationError("Nace returned an invalid response.", "invalid-response");
      }
      return payload;
    } finally {
      await release();
    }
  } catch (error) {
    if (callerSignal.aborted) {
      throw new EvaluationError("Nace evaluation cancelled.", "transport");
    }
    if (authorityFailure) {
      throw authorityFailure.error;
    }
    if (signal?.aborted) {
      throw new EvaluationError("Nace evaluation timed out.", "transport");
    }
    if (error instanceof EvaluationError) {
      throw error;
    }
    throw new EvaluationError("Nace transport unavailable.", "transport");
  } finally {
    cleanup();
  }
}
