// Packaged upgrade proof; this helper never imports candidate product source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, write, writeJson } from "../fixtures/common.mjs";

const POLICIES = new Set(["omitted", "false", "true"]);

function required(name) {
  assert(process.env[name], `Missing isolated proof path: ${name}`);
  return process.env[name];
}
const artifact = (name) => path.join(required("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"), name);

function cli(args, label) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  write(artifact(`${label}.out`), result.stdout ?? "");
  write(artifact(`${label}.err`), result.stderr ?? "");
  assert.equal(result.status, 0, `${label} failed; inspect Advisor scenario artifacts`);
  return result.stdout;
}

function cliJson(args, label) {
  const text = cli(args, label);
  const start = text.search(/^\s*\{/mu);
  assert(start >= 0, `${label} did not return JSON`);
  return JSON.parse(text.slice(start));
}

// Exit 3 marks a baseline that has no off-by-default Advisor to upgrade from.
function labsBaseline(packageRoot) {
  const file = path.join(packageRoot, "dist/extensions/advisor/openclaw.plugin.json");
  if (!fs.existsSync(file) || readJson(file).enabledByDefault !== false) {
    process.exit(3);
  }
}

function configure(policy) {
  assert(POLICIES.has(policy), `Unknown Advisor policy: ${policy}`);
  const set = (key, value, label) =>
    cli(["config", "set", key, JSON.stringify(value), "--strict-json"], `set-${label}`);
  set(
    "gateway",
    {
      mode: "local",
      bind: "loopback",
      port: 18789,
      reload: { mode: "off" },
      auth: {
        mode: "token",
        token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
      },
    },
    "gateway",
  );
  set("agents.defaults.workspace", path.join(required("OPENCLAW_STATE_DIR"), "workspace"), "ws");
  if (policy !== "omitted") {
    set("plugins.entries.advisor.enabled", policy === "true", "advisor");
  }
  cli(["config", "validate", "--json"], "baseline-config-validation");
}

function rpc(method, label) {
  const url = "ws://127.0.0.1:18789";
  const address = cli(["gateway", "call", "--help"], "gateway-call-help").includes("--expect-url")
    ? ["--expect-url", url]
    : ["--url", url, "--token", required("GATEWAY_AUTH_TOKEN_REF")];
  return cliJson(["gateway", "call", method, ...address, "--params", "{}", "--json"], label);
}

function probe(stage, policy, expectedVersion) {
  assert(POLICIES.has(policy), `Unknown Advisor policy: ${policy}`);
  const entries = readJson(required("OPENCLAW_CONFIG_PATH")).plugins?.entries ?? {};
  if (policy === "omitted") {
    assert.equal(Object.hasOwn(entries, "advisor"), false, "Upgrade wrote an Advisor override");
  } else {
    assert.equal(entries.advisor?.enabled, policy === "true", "Upgrade changed Advisor enablement");
  }
  const status = cliJson(
    [
      "gateway",
      "status",
      "--url",
      "ws://127.0.0.1:18789",
      "--token",
      required("GATEWAY_AUTH_TOKEN_REF"),
      "--require-rpc",
      "--timeout",
      "30000",
      "--json",
    ],
    `${stage}-status`,
  );
  assert.equal(status.gateway?.version, expectedVersion, "Advisor probe reached the wrong Gateway");
  const plugin = rpc("plugins.list", `${stage}-plugins`).plugins?.find(
    (entry) => entry.id === "advisor",
  );
  assert(plugin, "Gateway did not list the bundled Advisor plugin");
  // Labs-off baselines run Advisor only on an explicit opt-in; the candidate
  // runs it unless the operator explicitly turned it off.
  const active = policy === "true" || (stage === "candidate" && policy === "omitted");
  assert.equal(plugin.enabled, active, `${stage} Advisor enablement differs for ${policy}`);
  if (active) {
    assert.equal(plugin.runtime?.state, "active", `${stage} Gateway did not load Advisor`);
  } else {
    assert.notEqual(plugin.runtime?.state, "active", `${stage} Gateway loaded disabled Advisor`);
  }
  writeJson(artifact(`${stage}-proof.json`), {
    status: "passed",
    stage,
    policy,
    servingVersion: status.gateway.version,
    enabled: plugin.enabled,
    runtimeState: plugin.runtime?.state ?? null,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "labs-baseline") {
    labsBaseline(args[0]);
  } else if (mode === "configure") {
    configure(args[0]);
  } else if (mode === "probe") {
    probe(...args);
  } else {
    throw new Error(`Unknown Advisor upgrade proof mode: ${mode}`);
  }
}
