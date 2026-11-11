import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { resolveRuntimeConfig } from "./src/config.js";
import { createNaceDecisionProvider } from "./src/provider.js";

export default definePluginEntry({
  id: "nace",
  name: "Nace Drex",
  description: manifest.description,
  configSchema: { jsonSchema: manifest.configSchema },
  register(api) {
    api.registerDecisionProvider(
      createNaceDecisionProvider(() =>
        resolveRuntimeConfig(
          api.runtime.config.current(),
          () => getPreparedPluginSecretInput("nace", "apiKey").value,
        ),
      ),
    );
  },
});
