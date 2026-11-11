---
summary: "Use Nace Drex for typed Boolean, Choice, and Score decisions, including images on Drex Max"
title: "Nace Drex"
read_when:
  - Configuring Nace Drex as a decision model
  - Calling decision_evaluate against the Nace System One API
  - Debugging a Nace credential, rate limit, or request rejection
---

# Nace Drex

The `nace` plugin connects the optional [decision model role](/concepts/decision-models) to
[Nace Drex](https://console.nace.ai/docs/drex), a family of hosted models for Boolean judgments,
choices, and rubric scores. Its models appear in the **Decision** picker, never in the
conversational model picker. The plugin does not replace your chat model or provide text
generation or tool calling.

This adapter requires the prepared Decision V2 API. Released OpenClaw `2026.11.3` exposes V1
only. Packaged use requires a supporting paired host/plugin release; the plugin's host floor
alone does not establish V2 compatibility.

## Install

The plugin is packaged separately from core for publication to npm and ClawHub, which is
pending a supporting release. Once published, install it on a compatible host:

```sh
openclaw plugins install @openclaw/nace
```

Until a supporting release is available, use a source checkout containing the prepared V2
decision-provider API and `extensions/nace`. Build it with `pnpm install --frozen-lockfile` and
`pnpm build`, then apply the configuration below.

## Enable and configure

Create an API key at [console.nace.ai](https://console.nace.ai) and store it in **Settings →
Secrets**. Merge this configuration with your existing settings; preserve other entries in
`plugins.allow`:

```json5
{
  plugins: {
    allow: ["nace"],
    entries: {
      nace: {
        enabled: true,
        config: {
          apiKey: { source: "env", provider: "default", id: "NACE_API_KEY" },
        },
      },
    },
  },
  agents: {
    ownership: "explicit",
    defaults: { decisionModel: "nace/drex-latest" },
    entries: {
      research: { decisionModel: "nace/drex-v2.0" },
    },
  },
}
```

The plugin is disabled by default. Enabling it does not select a model, schedule work, or
change your primary model. An unset agent override inherits `agents.defaults.decisionModel`; an
empty override disables decisions for that agent.

Credentials must be SecretRefs, not plaintext. The plugin reads the host-prepared value for each
request. It does not read an ambient `NACE_API_KEY` itself or keep a previous key after a secret
refresh. Selecting a Nace model authorizes `decision_evaluate` and other enabled consumers to
send their selected evidence to Nace, and every `200` response is billed.

### Models

| Model reference      | Model         | Input       | Notes                                    |
| -------------------- | ------------- | ----------- | ---------------------------------------- |
| `nace/drex-latest`   | Drex          | text, image | Alias. Currently served by Drex Max v1.1 |
| `nace/drex-max-v1.1` | Drex Max v1.1 | text, image | 262,144 tokens across the whole request  |
| `nace/drex-v2.0`     | Drex 2.0      | text        | States up to 131,072 tokens              |

The alias moves to a newer Drex version only on an announced date; pin a version when your
thresholds depend on its behavior. The response `model` names the version that answered.
Pinned rows declare Nace's input price, $0.03 per million tokens with free output, checked
November 11, 2026. The alias row declares no price. Retired ids and the staff-preview Drex Max
Finance model are not listed.

## Decision contract

| OpenClaw | Nace   | Result                                                         |
| -------- | ------ | -------------------------------------------------------------- |
| Choice   | choice | Reported label and per-label probabilities                     |
| Score    | score  | Reported fractional zero-based position and index-aligned odds |
| Boolean  | noul   | Probability of true, preserved from 0 to 1                     |

Choice and Score accept 2 to 255 alternatives or levels. A request carries up to 400 questions
through the host; Nace allows 512. Each answer keeps its question ID and Nace's `confidence`.
The result `usage` reports Nace's input and output tokens, and `metadata.requestId` holds
the `request_id` that Nace returns, which identifies the call in Nace's logs. Reported
probabilities are estimates. The adapter preserves them and does not normalize them or pick a
label.

### Images

`nace/drex-latest` and `nace/drex-max-v1.1` accept one tagged PNG, JPEG, or WebP image with
optional accompanying text through Decision V2. Pass this shape to `decision_evaluate`,
replacing the placeholder with the base64 bytes of a real image:

```json
{
  "contractVersion": 2,
  "state": {
    "type": "image",
    "dataUri": "data:image/png;base64,<PNG_BYTES>",
    "text": "Inspect the delivery area."
  },
  "questions": {
    "package": { "type": "boolean", "instructions": "Is a package visible?" }
  }
}
```

The adapter sends the image in Nace's top-level `images` array. Drex counts state, questions,
and inline images against one 4 MiB request body, so the catalog declares 3,000,000 decoded
bytes per image. Remote image URLs, list state, and Box, Sort, and Tags questions are not
supported. `nace/drex-v2.0` is text-only and rejects image state before any request leaves the
host.

## Errors

The adapter never retries and never switches to another provider. It cancels error bodies
without reading them, because they can reflect submitted evidence. A failure returns an
unavailable result, and the tool stays available:

| Nace response                           | Unavailable reason        |
| --------------------------------------- | ------------------------- |
| No prepared credential                  | `credentials-unavailable` |
| 401, 403                                | `authentication`          |
| 429, with `retry-after-ms` when sent    | `rate-limited`            |
| 400, 413, 422                           | `unsupported-input`       |
| 402 (insufficient credit or payment)    | `transport`               |
| 5xx, including 529 overloaded           | `transport`               |
| Invalid JSON or a mismatched answer set | `invalid-response`        |

## Attribution and endpoint

Every request carries `X-Nace-Client: openclaw-nace/<plugin version>`, which Nace stores as the
client application. Requests go to `https://console.nace.ai/v1/systemone`. The optional
`baseUrl` setting accepts `https://console.nace.ai/v1`, `https://drex.nace.ai/v1`, or an
`http(s)` loopback origin, such as a local Drex dev server or a logging proxy. The API key is
sent to whichever of those you configure. Redirects are rejected.

## Verification

The adapter has synthetic HTTP-boundary tests for the wire format, typed answers, error
mapping, images, cancellation, and credential handling. Developers can run the live adapter
test from a source checkout with a protected `NACE_API_KEY`; it makes three paid requests with
synthetic evidence. See the plugin's `README.md`.
