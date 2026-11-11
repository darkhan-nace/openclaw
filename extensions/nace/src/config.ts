import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export const HOSTED_BASE_URL = "https://console.nace.ai/v1";

const BASE_URL_PATTERN = new RegExp(
  "^(?:https://(?:console|drex)\\.nace\\.ai|https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]{1,5})?)(?:/v1)?/?$",
);

export type RuntimeConfig = {
  apiKey?: string;
  baseUrl: string;
};

type RuntimeSnapshot = ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>;

/** Accept only Nace hosts or a loopback origin, and return the API root ending in /v1. */
function apiBaseUrl(value: unknown): string {
  if (value === undefined) {
    return HOSTED_BASE_URL;
  }
  const parsed =
    typeof value === "string" && value === value.trim() && BASE_URL_PATTERN.test(value)
      ? URL.parse(value)
      : null;
  if (!parsed) {
    throw new Error(
      "Invalid Nace baseUrl; use https://console.nace.ai/v1, https://drex.nace.ai/v1, or an http(s) loopback origin.",
    );
  }
  return `${parsed.origin}/v1`;
}

/** Validate plugin settings; the credential comes from the host's prepared SecretRef, not here. */
export function resolveRuntimeConfig(
  snapshot: RuntimeSnapshot,
  preparedApiKey: () => string | undefined,
): RuntimeConfig {
  const configured = snapshot.plugins?.entries?.nace?.config;
  const baseUrl = apiBaseUrl(configured?.baseUrl);
  const key = preparedApiKey();
  return { apiKey: key?.trim() ? key : undefined, baseUrl };
}
