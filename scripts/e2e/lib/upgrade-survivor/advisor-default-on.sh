#!/usr/bin/env bash

# Advisor shipped as an off-by-default Labs plugin before it became default-on.
# Each enablement policy gets a pristine copy of the published install and its
# own real updater invocation; editing config after the update proves nothing.
ADVISOR_POLICIES="omitted false true"

advisor_default_on_enabled() {
  [ "$SCENARIO" = "legacy-operator-state" ] && [ "$UPDATE_RESTART_MODE" = "manual" ] &&
    [ "$CANDIDATE_KIND" = "tarball" ] && [ -f "$RUNTIME_ROOT/advisor-default-on/labs-baseline" ]
}

capture_advisor_default_on() {
  local root="$RUNTIME_ROOT/advisor-default-on" status=0
  [ "$UPDATE_RESTART_MODE" = "manual" ] && [ "$CANDIDATE_KIND" = "tarball" ] || return 0
  [ "$(read_installed_version)" = "$baseline_version" ] || return 1
  # Baselines without Advisor, or with it already on, have no Labs-off specimen.
  node scripts/e2e/lib/upgrade-survivor/advisor-default-on.mjs labs-baseline "$(package_root)" || status=$?
  [ "$status" != 3 ] || return 0
  [ "$status" = 0 ] || return "$status"
  rm -rf "$root"
  mkdir -p "$root"
  cp -a "$npm_config_prefix" "$root/npm-prefix"
  : >"$root/labs-baseline"
}

verify_advisor_default_on() (
  trap - EXIT ERR HUP INT TERM
  local policy="$1" source_artifacts="$ARTIFACT_ROOT"
  local probe="$RUNTIME_ROOT/advisor-default-on/$policy"
  local helper=scripts/e2e/lib/upgrade-survivor/advisor-default-on.mjs
  rm -rf "$probe"
  mkdir -p "$probe/home" "$probe/state"
  cp -a "$RUNTIME_ROOT/advisor-default-on/npm-prefix" "$probe/npm-prefix"
  ARTIFACT_ROOT="$source_artifacts/advisor-default-on-$policy"
  mkdir -p "$ARTIFACT_ROOT"
  export HOME="$probe/home" USERPROFILE="$probe/home" OPENCLAW_HOME="$probe/home"
  export OPENCLAW_STATE_DIR="$probe/state" OPENCLAW_CONFIG_PATH="$probe/state/openclaw.json"
  export OPENCLAW_TEST_WORKSPACE_DIR="$probe/state/workspace" OPENCLAW_GATEWAY_PORT=18789
  unset OPENCLAW_PROFILE OPENCLAW_AGENT_DIR PI_CODING_AGENT_DIR DISCORD_BOT_TOKEN TELEGRAM_BOT_TOKEN
  export npm_config_prefix="$probe/npm-prefix" NPM_CONFIG_PREFIX="$probe/npm-prefix"
  export PATH="$npm_config_prefix/bin:$PATH"
  export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_ROOT"
  BASELINE_PACKAGE_ROOT="$npm_config_prefix/lib/node_modules/openclaw"
  UPDATE_JSON="$ARTIFACT_ROOT/update.json"
  UPDATE_ERR="$ARTIFACT_ROOT/update.err"
  POST_UPDATE_VALIDATE_JSON="$ARTIFACT_ROOT/post-update-validate.json"
  POST_UPDATE_VALIDATE_ERR="$ARTIFACT_ROOT/post-update-validate.err"
  GATEWAY_LOG="$ARTIFACT_ROOT/baseline-gateway.log"
  SYSTEMCTL_SHIM_PID_FILE="$ARTIFACT_ROOT/systemctl-shim.pid"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$SYSTEMCTL_SHIM_PID_FILE"
  gateway_pid=""
  update_repair_required=0
  initial_update_observation_root=""
  trap stop_gateway EXIT
  [ "$(read_installed_version)" = "$baseline_version" ] || return 1
  node "$helper" configure "$policy"
  start_gateway
  node "$helper" probe baseline "$policy" "$baseline_version"
  stop_gateway
  update_candidate
  [ "$update_outcome" = success ] && [ "$update_repair_required" = 0 ] || {
    echo "Advisor $policy upgrade required additional repair" >&2
    return 1
  }
  GATEWAY_LOG="$ARTIFACT_ROOT/candidate-gateway.log"
  start_gateway
  node "$helper" probe candidate "$policy" "$candidate_version"
  stop_gateway
)
