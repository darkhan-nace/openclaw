# Nace Drex for OpenClaw

External OpenClaw decision-provider plugin that sends `decision_evaluate` requests
straight to Nace's Drex System One API (`POST /v1/systemone`). It gives the
decision model role Choice, Score, and Boolean judgments, plus one image per request on Drex Max.
Disabled by default; installing or enabling it selects no model.

Models, selected as `nace/<model>`:

| Model reference      | Model         | Input       |
| -------------------- | ------------- | ----------- |
| `nace/drex-latest`   | Drex (alias)  | text, image |
| `nace/drex-max-v1.1` | Drex Max v1.1 | text, image |
| `nace/drex-v2.0`     | Drex 2.0      | text        |

Configure a Nace API key from [console.nace.ai](https://console.nace.ai) as a protected
SecretRef, enable the plugin, then select a model:

```json5
{
  plugins: {
    allow: ["nace"],
    entries: {
      nace: {
        enabled: true,
        config: { apiKey: { source: "env", provider: "default", id: "NACE_API_KEY" } },
      },
    },
  },
  agents: {
    defaults: { decisionModel: "nace/drex-latest" },
  },
}
```

Every request carries `X-Nace-Client: openclaw-nace/<plugin version>`. A missing key,
an authentication failure, a rate limit, or a Nace outage leaves the tool available and
returns an unavailable result. The plugin never switches to another provider.

See the [Nace Drex setup guide](https://docs.openclaw.ai/plugins/nace) for limits, error
mapping, images, and the optional `baseUrl` setting.

## Live adapter test

From a matching source checkout, inject a Nace-issued `NACE_API_KEY` through your secret
manager, then run:

```sh
OPENCLAW_LIVE_TEST=1 node scripts/run-vitest.mjs --config test/vitest/vitest.live.config.ts extensions/nace/src/decisions.live.test.ts
```

The test sends synthetic Boolean, Choice, and Score questions (text, and a generated PNG on
Drex Max) to `https://console.nace.ai` and consumes the account's balance. It skips without
the opt-in flag and the key.
