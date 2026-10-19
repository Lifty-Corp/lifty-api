#!/usr/bin/env bash

set -euo pipefail
umask 077

EXPECTED_APP_NAME="lifty-api-staging"
EXPECTED_COMPONENT="api"
EXPECTED_REPOSITORY="https://github.com/LIFT-Leadership-Group/lifty-api.git"
EXPECTED_BRANCH="main"
APP_NAME="${LIFTY_DO_APP_NAME:-$EXPECTED_APP_NAME}"
COMPONENT="${LIFTY_DO_COMPONENT:-$EXPECTED_COMPONENT}"

fail() {
  printf 'digitalocean: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

resolve_app_id() {
  [[ "$APP_NAME" == "$EXPECTED_APP_NAME" ]] \
    || fail "app name '$APP_NAME' is not the allowed staging target"
  [[ "$COMPONENT" == "$EXPECTED_COMPONENT" ]] \
    || fail "component '$COMPONENT' is not the allowed staging component"

  local matches lookup_status
  matches="$(doctl apps list -o json | jq -r --arg name "$APP_NAME" \
    '.[] | select(.spec.name == $name) | .id')" || {
      lookup_status=$?
      return "$lookup_status"
    }
  [[ -n "$matches" ]] || fail "app '$APP_NAME' was not found"
  [[ "$matches" != *$'\n'* ]] || fail "more than one app is named '$APP_NAME'"
  if [[ -n "${LIFTY_DO_APP_ID:-}" && "$LIFTY_DO_APP_ID" != "$matches" ]]; then
    fail "app id '$LIFTY_DO_APP_ID' does not match staging app '$APP_NAME' ($matches)"
  fi
  printf '%s\n' "$matches"
}

validate_target() {
  local app_id="$1" app_json="$2" app_count actual_id actual_name
  local component_count total_components repository branch
  app_count="$(jq -r 'length' <<<"$app_json")"
  actual_id="$(jq -er '.[0].id' <<<"$app_json")"
  actual_name="$(jq -er '.[0].spec.name' <<<"$app_json")"
  [[ "$app_count" == "1" && "$actual_id" == "$app_id" \
    && "$actual_name" == "$EXPECTED_APP_NAME" ]] \
    || fail "resolved app record is not staging"

  component_count="$(jq -r --arg component "$EXPECTED_COMPONENT" \
    '[.[0].spec.services[]? | select(.name == $component)] | length' \
    <<<"$app_json")"
  total_components="$(jq -r '
    [.[0].spec.services[]?, .[0].spec.workers[]?, .[0].spec.jobs[]?,
     .[0].spec.static_sites[]?, .[0].spec.functions[]?] | length
  ' <<<"$app_json")"
  [[ "$component_count" == "1" && "$total_components" == "1" ]] \
    || fail "staging must contain exactly one '$EXPECTED_COMPONENT' component"

  repository="$(jq -er --arg component "$EXPECTED_COMPONENT" \
    '.[0].spec.services[] | select(.name == $component) | .git.repo_clone_url' \
    <<<"$app_json")"
  [[ "$repository" == "$EXPECTED_REPOSITORY" ]] \
    || fail "repository is not the approved staging source"
  branch="$(jq -er --arg component "$EXPECTED_COMPONENT" \
    '.[0].spec.services[] | select(.name == $component) | .git.branch' \
    <<<"$app_json")"
  [[ "$branch" == "$EXPECTED_BRANCH" ]] \
    || fail "branch is not the approved staging source"
}

# Only these retired integration credentials may be removed from the live spec.
# The remaining spec, including every other encrypted value, passes through.
prepare_deployment_spec() {
  jq -cS '
    def retire:
      map(select(.key != "INSTANTLY_API_KEY" and .key != "HEYREACH_API_KEY"
        and .key != "SMARTLEAD_API_KEY" and .key != "SMARTDELIVERY_API_KEY"));
    .[0].spec |
    (if has("envs") then .envs |= retire else . end) |
    .services |= map(if has("envs") then .envs |= retire else . end)
  '
}

retired_environment_count() {
  jq -r '
    [.[0].spec | (.envs[]?, .services[]?.envs[]?) |
      select(.key == "INSTANTLY_API_KEY" or .key == "HEYREACH_API_KEY"
        or .key == "SMARTLEAD_API_KEY" or .key == "SMARTDELIVERY_API_KEY")] | length
  '
}

show_status() {
  require_command doctl
  require_command jq

  local app_id app_json deployment_id deployment_json
  app_id="$(resolve_app_id)"
  app_json="$(doctl apps get "$app_id" -o json)"
  deployment_id="$(jq -er '.[0].active_deployment.id' <<<"$app_json")"
  deployment_json="$(doctl apps get-deployment "$app_id" "$deployment_id" -o json)"

  jq -r --arg component "$COMPONENT" '
    .[0] |
    "App: \(.spec.name) (\(.id))",
    "Region: \(.region.slug)",
    "Ingress: \(.default_ingress)",
    "Deployment: \(.active_deployment.id) (\(.active_deployment.phase))",
    (.spec.services[] | select(.name == $component) |
      "Source: \(.git.repo_clone_url // ("https://github.com/" + .github.repo))#\(.git.branch // .github.branch)")
  ' <<<"$app_json"
  jq -r --arg component "$COMPONENT" '
    .[0].services[] | select(.name == $component) |
    "Commit: \(.source_commit_hash // "unknown")"
  ' <<<"$deployment_json"
}

show_logs() {
  require_command doctl
  require_command jq

  local app_id log_type="run" tail_lines="100"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --type)
        [[ $# -ge 2 ]] || fail "--type requires a value"
        log_type="$2"
        shift 2
        ;;
      --type=*)
        log_type="${1#*=}"
        shift
        ;;
      --tail)
        [[ $# -ge 2 ]] || fail "--tail requires a value"
        tail_lines="$2"
        shift 2
        ;;
      --tail=*)
        tail_lines="${1#*=}"
        shift
        ;;
      *)
        fail "unsupported logs option: $1"
        ;;
    esac
  done
  case "$log_type" in
    run|build|deploy|run_restarted|autoscale_event) ;;
    *) fail "unsupported log type: $log_type" ;;
  esac
  [[ "$tail_lines" =~ ^[0-9]+$ ]] \
    || fail "--tail must be a non-negative integer"

  app_id="$(resolve_app_id)"
  doctl apps logs "$app_id" "$COMPONENT" \
    --type "$log_type" --tail "$tail_lines" --no-prefix
}

run_smoke() {
  require_command curl
  require_command doctl
  require_command jq

  local app_id app_json ingress smoke_dir auth_body auth_status
  app_id="$(resolve_app_id)"
  app_json="$(doctl apps get "$app_id" -o json)"
  ingress="$(jq -er '.[0].default_ingress' <<<"$app_json")"
  ingress="${ingress%/}"
  smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/lifty-do-smoke.XXXXXX")"
  auth_body="$smoke_dir/unauthorized.json"
  trap 'rm -rf -- "$smoke_dir"' EXIT

  curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
    "$ingress/healthz" \
    | jq -e '.status == "ok"' >/dev/null
  curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
    "$ingress/readyz" \
    | jq -e '.status == "ready"' >/dev/null
  curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
    "$ingress/readyz/crm" \
    | jq -e '.status == "ready" and .capability == "lifty-crm-company.v1"' >/dev/null
  curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
    "$ingress/readyz/crm-mapping" \
    | jq -e '.status == "ready" and .capability == "lifty-crm-mapping.v1"' >/dev/null
  curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
    "$ingress/openapi.json" \
    | jq -e '.openapi == "3.1.0"' >/dev/null

  curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
    "$ingress/v1/context/business?client_contract=lifty-cli-context.v11" \
    | jq -e '.task == "business" and .operations.get.route == "/v1/workspace/business" and .operations.patch.method == "PATCH"' >/dev/null
  curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
    "$ingress/v1/context/setup?client_contract=lifty-cli-context.v11" \
    | jq -e '.task == "setup" and .operations.delete_draft.method == "DELETE" and .operations.generation_context.route == "/v1/workspace/setup/context"' >/dev/null

  auth_status="$(curl --silent --show-error --connect-timeout 5 --max-time 20 \
    --output "$auth_body" --write-out '%{http_code}' \
    "$ingress/v1/workspace")"
  [[ "$auth_status" == "401" ]] \
    || fail "unauthenticated /v1/workspace returned HTTP $auth_status, expected 401"
  jq -e '.error.code == "UNAUTHORIZED"' "$auth_body" >/dev/null \
    || fail "unauthenticated response did not use the UNAUTHORIZED envelope"

  # The default ingress proves the deployment; the PRIMARY domain is what
  # founders and MCP clients use, and it must advertise its own /mcp resource.
  local primary
  primary="$(jq -r '[.[0].spec.domains[]? | select(.type == "PRIMARY") | .domain][0] // empty' <<<"$app_json")"
  if [[ -n "$primary" ]]; then
    curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
      "https://$primary/healthz" \
      | jq -e '.status == "ok"' >/dev/null
    curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
      "https://$primary/.well-known/oauth-protected-resource/mcp" \
      | jq -e --arg resource "https://$primary/mcp" '.resource == $resource' >/dev/null \
      || fail "https://$primary does not advertise https://$primary/mcp as its MCP resource"
  fi

  rm -rf -- "$smoke_dir"
  trap - EXIT
  printf 'Smoke checks passed: %s%s (v6 Business/setup catalog)\n' "$ingress" "${primary:+ and https://$primary}"
}

deploy_app() {
  [[ $# -le 2 && ( $# -lt 2 || "${2:-}" == "--force-rebuild" ) ]] \
    || fail "deploy accepts only <full-sha> [--force-rebuild]"
  require_command doctl
  require_command git
  require_command jq

  local expected_commit="${1:-}" app_id app_json repository branch
  local remote_commit deployment_id deployment_json active_commit
  local deployment_spec retired_count
  [[ "$expected_commit" =~ ^[0-9a-fA-F]{40}$ ]] \
    || fail "deploy requires the full 40-character expected commit SHA"
  expected_commit="$(printf '%s' "$expected_commit" | tr '[:upper:]' '[:lower:]')"

  app_id="$(resolve_app_id)"
  app_json="$(doctl apps get "$app_id" -o json)"
  validate_target "$app_id" "$app_json"
  repository="$(jq -er --arg component "$COMPONENT" \
    '.[0].spec.services[] | select(.name == $component) | .git.repo_clone_url' \
    <<<"$app_json")"
  branch="$(jq -er --arg component "$COMPONENT" \
    '.[0].spec.services[] | select(.name == $component) | .git.branch' \
    <<<"$app_json")"
  remote_commit="$(git ls-remote "$repository" "refs/heads/$branch" \
    | awk 'NR == 1 { print $1 }')"
  [[ "$remote_commit" == "$expected_commit" ]] \
    || fail "remote $repository#$branch is $remote_commit, expected $expected_commit"

  retired_count="$(retired_environment_count <<<"$app_json")"
  if [[ "$retired_count" != "0" ]]; then
    [[ "${2:-}" != "--force-rebuild" ]] \
      || fail "retired environment cleanup requires one source/spec deployment; rerun without --force-rebuild"
    deployment_spec="$(prepare_deployment_spec <<<"$app_json")"
    # Updating sources and the filtered spec is the deployment. Do not also
    # create a second deployment; never print the spec or its encrypted values.
    doctl apps update "$app_id" --spec - --update-sources --wait -o json \
      <<<"$deployment_spec" >/dev/null
  elif [[ "${2:-}" == "--force-rebuild" ]]; then
    doctl apps create-deployment "$app_id" --force-rebuild --wait -o json >/dev/null
  else
    doctl apps create-deployment "$app_id" --wait -o json >/dev/null
  fi
  app_json="$(doctl apps get "$app_id" -o json)"
  deployment_id="$(jq -er '.[0].active_deployment.id' <<<"$app_json")"
  deployment_json="$(doctl apps get-deployment \
    "$app_id" "$deployment_id" -o json)"
  active_commit="$(jq -er --arg component "$COMPONENT" \
    '.[0].services[] | select(.name == $component) | .source_commit_hash' \
    <<<"$deployment_json")"
  [[ "$active_commit" == "$expected_commit" ]] \
    || fail "active deployment is $active_commit, expected $expected_commit"
  if [[ "$retired_count" != "0" ]]; then
    jq -e '.[0].spec | type == "object"' <<<"$deployment_json" >/dev/null \
      || fail "active deployment did not return its spec for environment verification"
    [[ "$(retired_environment_count <<<"$app_json")" == "0" \
      && "$(retired_environment_count <<<"$deployment_json")" == "0" ]] \
      || fail "retired provider credentials remain in the configured or active deployment"
    printf 'Retired provider environment entries removed: %s\n' "$retired_count"
  fi

  show_status
  run_smoke
}

run_doctor() {
  require_command curl
  require_command doctl
  require_command jq

  doctl auth list >/dev/null
  local app_id
  app_id="$(resolve_app_id)"
  printf 'DigitalOcean access ready: %s\n' "$app_id"
}

usage() {
  cat <<'EOF'
Usage: scripts/digitalocean.sh <command> [options]

Commands:
  doctor             Check local tooling, authentication, and app access
  status             Show the app, deployment, source commit, and ingress
  logs [options]     Read bounded logs (--tail N, --type TYPE)
  deploy <full-sha> [--force-rebuild]
                     Deploy and verify one exact remote commit (reuse eligible builds)
  smoke              Probe health, readiness, OpenAPI, v6 context, and fail-closed auth
  help                Show this help

Environment:
  LIFTY_DO_APP_ID     Optional assertion for the resolved staging app ID
EOF
}

case "${1:-help}" in
  help|-h|--help)
    usage
    ;;
  status)
    show_status
    ;;
  doctor)
    run_doctor
    ;;
  logs)
    shift
    show_logs "$@"
    ;;
  smoke)
    run_smoke
    ;;
  deploy)
    shift
    deploy_app "$@"
    ;;
  *)
    printf 'Command not implemented yet: %s\n' "$1" >&2
    exit 2
    ;;
esac
