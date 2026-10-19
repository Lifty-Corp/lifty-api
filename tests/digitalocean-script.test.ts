import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const script = new URL("../scripts/digitalocean.sh", import.meta.url).pathname;
const expectedCommit = "def4567890abcdef1234567890abcdef12345678";
const expectedRepository =
  "https://github.com/LIFT-Leadership-Group/lifty-api.git";

function runDeployPreflight(
  app: Record<string, unknown>,
  remoteCommit = expectedCommit,
) {
  const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
  const fakeDoctl = join(fakeBin, "doctl");
  const fakeGit = join(fakeBin, "git");
  const calls = join(fakeBin, "doctl-calls.log");
  writeFileSync(
    fakeDoctl,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '${JSON.stringify([app])}'
elif [[ "$1 $2" == "apps create-deployment" ]]; then
  exit 88
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
  );
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' '${remoteCommit}' 'refs/heads/main'
`,
  );
  chmodSync(fakeDoctl, 0o755);
  chmodSync(fakeGit, 0o755);

  try {
    const result = spawnSync("bash", [script, "deploy", expectedCommit], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_DOCTL_CALLS: calls,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    return {
      result,
      calls: readFileSync(calls, "utf8"),
    };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

describe("DigitalOcean operations script", () => {
  it("documents the complete agent-facing command surface without requiring credentials", () => {
    const result = spawnSync("bash", [script, "help"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("logs");
    expect(result.stdout).toContain("deploy");
    expect(result.stdout).toContain("smoke");
  });

  it("checks the local tools, authentication, and target app before operations", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "auth list" ]]; then
  printf '%s\\n' 'default (current)'
elif [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    chmodSync(fakeDoctl, 0o755);

    try {
      const result = spawnSync("bash", [script, "doctor"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("DigitalOcean access ready: app-123");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("propagates DigitalOcean lookup failures instead of reporting a missing app", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "auth list" ]]; then
  exit 0
elif [[ "$1 $2" == "apps list" ]]; then
  printf '%s\\n' 'DigitalOcean API unavailable' >&2
  exit 77
fi
exit 64
`,
    );
    chmodSync(fakeDoctl, 0o755);

    try {
      const result = spawnSync("bash", [script, "doctor"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("DigitalOcean API unavailable");
      expect(result.stderr).not.toContain("was not found");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("resolves the app by name and reports the exact active source", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging","services":[{"name":"api","git":{"repo_clone_url":"${expectedRepository}","branch":"main"}}]},"region":{"slug":"sfo"},"default_ingress":"https://api.example.test","active_deployment":{"id":"dep-456","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps get-deployment" ]]; then
  printf '%s' '[{"id":"dep-456","phase":"ACTIVE","services":[{"name":"api","source_commit_hash":"abc123"}]}]'
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    chmodSync(fakeDoctl, 0o755);

    try {
      const result = spawnSync("bash", [script, "status"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("lifty-api-staging (app-123)");
      expect(result.stdout).toContain("dep-456 (ACTIVE)");
      expect(result.stdout).toContain("abc123");
      expect(result.stdout).toContain("https://api.example.test");
      expect(result.stdout).toContain(`${expectedRepository}#main`);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("reads bounded runtime logs from the resolved app and component", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const calls = join(fakeBin, "calls.log");
    writeFileSync(calls, "");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps logs" ]]; then
  printf '%s\\n' '{"event":"request_failed","request_id":"safe-id"}'
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    chmodSync(fakeDoctl, 0o755);

    try {
      const result = spawnSync("bash", [script, "logs", "--tail", "12"], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"event":"request_failed"');
      expect(readFileSync(calls, "utf8")).toContain(
        "apps logs app-123 api --type run --tail 12 --no-prefix",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("rejects unsupported doctl flags instead of forwarding credentials or tracing", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const calls = join(fakeBin, "calls.log");
    writeFileSync(calls, "");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
exit 88
`,
    );
    chmodSync(fakeDoctl, 0o755);

    try {
      const result = spawnSync("bash", [script, "logs", "--trace"], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsupported logs option: --trace");
      expect(readFileSync(calls, "utf8")).toBe("");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it.each([
    ["ready", "lifty-crm-mapping.v1", true],
    ["ready", "lifty-crm-company.v1", false],
    ["not_ready", "lifty-crm-mapping.v1", false],
  ] as const)("smoke gates mapping capability (%s/%s) and verifies authentication fails closed", (mappingStatus, mappingVersion, shouldPass) => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeCurl = join(fakeBin, "curl");
    const calls = join(fakeBin, "curl-calls.log");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"},"default_ingress":"https://api.example.test","active_deployment":{"id":"dep-456","phase":"ACTIVE"}}]'
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    writeFileSync(
      fakeCurl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CURL_CALLS"
url="\${!#}"
case "$url" in
  */healthz) printf '%s' '{"status":"ok"}' ;;
  */readyz/crm) printf '%s' '{"status":"ready","capability":"lifty-crm-company.v1"}' ;;
  */readyz/crm-mapping) printf '%s' '{"status":"${mappingStatus}","capability":"${mappingVersion}"}' ;;
  */readyz) printf '%s' '{"status":"ready"}' ;;
  */openapi.json) printf '%s' '{"openapi":"3.1.0"}' ;;
  */v1/context/business\\?client_contract=lifty-cli-context.v11) printf '%s' '{"task":"business","operations":{"get":{"route":"/v1/workspace/business"},"patch":{"method":"PATCH"}}}' ;;
  */v1/context/setup\\?client_contract=lifty-cli-context.v11) printf '%s' '{"task":"setup","operations":{"delete_draft":{"method":"DELETE"},"generation_context":{"route":"/v1/workspace/setup/context"}}}' ;;
  */v1/workspace)
    output=''
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--output" ]]; then output="$2"; shift 2; else shift; fi
    done
    printf '%s' '{"error":{"code":"UNAUTHORIZED"}}' > "$output"
    printf '401'
    ;;
  *) exit 22 ;;
esac
`,
    );
    chmodSync(fakeDoctl, 0o755);
    chmodSync(fakeCurl, 0o755);

    try {
      const result = spawnSync("bash", [script, "smoke"], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_CURL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      if (!shouldPass) {
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain("Smoke checks passed");
        expect(readFileSync(calls, "utf8")).not.toContain("/v1/workspace");
        return;
      }
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Smoke checks passed: https://api.example.test",
      );
      const curlCalls = readFileSync(calls, "utf8").trim().split("\n");
      expect(curlCalls).toHaveLength(8);
      expect(curlCalls.join("\n")).toContain("/v1/context/business?client_contract=lifty-cli-context.v11");
      expect(curlCalls.join("\n")).toContain("/v1/context/setup?client_contract=lifty-cli-context.v11");
      expect(curlCalls.join("\n")).toContain("https://api.example.test/readyz/crm");
      expect(curlCalls.join("\n")).toContain("https://api.example.test/readyz/crm-mapping");
      for (const call of curlCalls) {
        expect(call).toContain("--connect-timeout 5 --max-time 20");
      }
      expect(curlCalls.join("\n")).toContain(
        "https://api.example.test/v1/workspace",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it.each([
    ["https://api.canonical.test/mcp", true],
    ["https://api.example.test/mcp", false],
  ] as const)("smoke checks the PRIMARY domain advertises its own MCP resource (%s)", (resource, shouldPass) => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeCurl = join(fakeBin, "curl");
    const calls = join(fakeBin, "curl-calls.log");
    writeFileSync(fakeDoctl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging","domains":[{"domain":"warmup.canonical.test","type":"ALIAS"},{"domain":"api.canonical.test","type":"PRIMARY"}]},"default_ingress":"https://api.example.test","active_deployment":{"id":"dep-456","phase":"ACTIVE"}}]'
else
  exit 64
fi
`);
    writeFileSync(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CURL_CALLS"
url="\${!#}"
case "$url" in
  */.well-known/oauth-protected-resource/mcp) printf '%s' '{"resource":"${resource}"}' ;;
  */healthz) printf '%s' '{"status":"ok"}' ;;
  */readyz/crm) printf '%s' '{"status":"ready","capability":"lifty-crm-company.v1"}' ;;
  */readyz/crm-mapping) printf '%s' '{"status":"ready","capability":"lifty-crm-mapping.v1"}' ;;
  */readyz) printf '%s' '{"status":"ready"}' ;;
  */openapi.json) printf '%s' '{"openapi":"3.1.0"}' ;;
  */v1/context/business\\?client_contract=lifty-cli-context.v11) printf '%s' '{"task":"business","operations":{"get":{"route":"/v1/workspace/business"},"patch":{"method":"PATCH"}}}' ;;
  */v1/context/setup\\?client_contract=lifty-cli-context.v11) printf '%s' '{"task":"setup","operations":{"delete_draft":{"method":"DELETE"},"generation_context":{"route":"/v1/workspace/setup/context"}}}' ;;
  */v1/workspace)
    output=''
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--output" ]]; then output="$2"; shift 2; else shift; fi
    done
    printf '%s' '{"error":{"code":"UNAUTHORIZED"}}' > "$output"
    printf '401'
    ;;
  *) exit 22 ;;
esac
`);
    chmodSync(fakeDoctl, 0o755);
    chmodSync(fakeCurl, 0o755);
    try {
      const result = spawnSync("bash", [script, "smoke"], { encoding: "utf8",
        env: { ...process.env, FAKE_CURL_CALLS: calls, PATH: `${fakeBin}:${process.env.PATH ?? ""}` } });
      const curlCalls = readFileSync(calls, "utf8").trim().split("\n");
      expect(curlCalls).toHaveLength(10);
      expect(curlCalls.join("\n")).toContain("https://api.canonical.test/.well-known/oauth-protected-resource/mcp");
      if (!shouldPass) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("does not advertise https://api.canonical.test/mcp");
        return;
      }
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Smoke checks passed: https://api.example.test and https://api.canonical.test");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("refuses to deploy when an app-id override does not resolve to staging", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeGit = join(fakeBin, "git");
    const calls = join(fakeBin, "doctl-calls.log");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}},{"id":"prod-999","spec":{"name":"lifty-api-production"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"prod-999","spec":{"name":"lifty-api-production","services":[{"name":"api","git":{"repo_clone_url":"${expectedRepository}","branch":"main"}}]},"active_deployment":{"id":"dep-prod","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps create-deployment" ]]; then
  exit 88
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' '${expectedCommit}' 'refs/heads/main'
`,
    );
    chmodSync(fakeDoctl, 0o755);
    chmodSync(fakeGit, 0o755);

    try {
      const result = spawnSync("bash", [script, "deploy", expectedCommit], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          LIFTY_DO_APP_ID: "prod-999",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not match staging app");
      expect(readFileSync(calls, "utf8")).not.toContain(
        "apps create-deployment",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("refuses to deploy when the staging app source is not the approved repository", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeGit = join(fakeBin, "git");
    const calls = join(fakeBin, "doctl-calls.log");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging","services":[{"name":"api","git":{"repo_clone_url":"https://github.com/attacker/repository.git","branch":"main"}}]},"active_deployment":{"id":"dep-456","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps create-deployment" ]]; then
  exit 88
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' '${expectedCommit}' 'refs/heads/main'
`,
    );
    chmodSync(fakeDoctl, 0o755);
    chmodSync(fakeGit, 0o755);

    try {
      const result = spawnSync("bash", [script, "deploy", expectedCommit], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("repository is not the approved staging source");
      expect(readFileSync(calls, "utf8")).not.toContain(
        "apps create-deployment",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("refuses to deploy when staging contains an unexpected component", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeGit = join(fakeBin, "git");
    const calls = join(fakeBin, "doctl-calls.log");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging","services":[{"name":"api","git":{"repo_clone_url":"${expectedRepository}","branch":"main"}},{"name":"unexpected-worker","git":{"repo_clone_url":"${expectedRepository}","branch":"main"}}]},"active_deployment":{"id":"dep-456","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps create-deployment" ]]; then
  exit 88
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' '${expectedCommit}' 'refs/heads/main'
`,
    );
    chmodSync(fakeDoctl, 0o755);
    chmodSync(fakeGit, 0o755);

    try {
      const result = spawnSync("bash", [script, "deploy", expectedCommit], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("exactly one 'api' component");
      expect(readFileSync(calls, "utf8")).not.toContain(
        "apps create-deployment",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("refuses to deploy from a branch other than main", () => {
    const { result, calls } = runDeployPreflight({
      id: "app-123",
      spec: {
        name: "lifty-api-staging",
        services: [{
          name: "api",
          git: { repo_clone_url: expectedRepository, branch: "release" },
        }],
      },
      active_deployment: { id: "dep-456", phase: "ACTIVE" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("branch is not the approved staging source");
    expect(calls).not.toContain("apps create-deployment");
  });

  it("refuses to deploy when the resolved app record is not staging", () => {
    const { result, calls } = runDeployPreflight({
      id: "app-123",
      spec: {
        name: "lifty-api-production",
        services: [{
          name: "api",
          git: { repo_clone_url: expectedRepository, branch: "main" },
        }],
      },
      active_deployment: { id: "dep-456", phase: "ACTIVE" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("resolved app record is not staging");
    expect(calls).not.toContain("apps create-deployment");
  });

  it("refuses to deploy when the expected SHA is not the remote branch head", () => {
    const differentCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { result, calls } = runDeployPreflight({
      id: "app-123",
      spec: {
        name: "lifty-api-staging",
        services: [{
          name: "api",
          git: { repo_clone_url: expectedRepository, branch: "main" },
        }],
      },
      active_deployment: { id: "dep-456", phase: "ACTIVE" },
    }, differentCommit);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `remote ${expectedRepository}#main is ${differentCommit}, expected ${expectedCommit}`,
    );
    expect(calls).not.toContain("apps create-deployment");
  });

  it.each([
    ["--trace"],
    ["--force-rebuild", "--trace"],
    ["--force-rebuild=false"],
    [""],
  ])("rejects unsupported deploy arguments: %j", (...options) => {
    const result = spawnSync("bash", [script, "deploy", expectedCommit, ...options], {
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("deploy accepts only <full-sha> [--force-rebuild]");
  });

  it.each([
    { forceRebuild: false, retired: false, activeLeak: false },
    { forceRebuild: true, retired: false, activeLeak: false },
    { forceRebuild: false, retired: true, activeLeak: false },
    { forceRebuild: true, retired: true, activeLeak: false },
    { forceRebuild: false, retired: true, activeLeak: true },
  ])("deploys once with exact source and retired-environment checks: %j", (options) => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeCurl = join(fakeBin, "curl");
    const fakeGit = join(fakeBin, "git");
    const calls = join(fakeBin, "doctl-calls.log");
    const appFile = join(fakeBin, "app.json");
    const submittedSpec = join(fakeBin, "submitted-spec.json");
    const keptAppEnv = { key: "WORKSPACE_MODE", value: "production", scope: "RUN_TIME" };
    const keptServiceEnv = { key: "MAILIVERY_API_KEY", value: "keep-mailivery-private", type: "SECRET", scope: "RUN_TIME" };
    const spec = {
      name: "lifty-api-staging",
      envs: [keptAppEnv, ...(options.retired ? [
        { key: "INSTANTLY_API_KEY", value: "retired-secret-instantly", type: "SECRET" },
        { key: "HEYREACH_API_KEY", value: "retired-secret-heyreach", type: "SECRET" },
      ] : [])],
      services: [{
        name: "api", git: { repo_clone_url: expectedRepository, branch: "main" },
        envs: [keptServiceEnv, ...(options.retired ? [
          { key: "SMARTLEAD_API_KEY", value: "retired-secret-smartlead", type: "SECRET", scope: "RUN_TIME" },
          { key: "SMARTDELIVERY_API_KEY", value: "retired-secret-smartdelivery", type: "SECRET" },
        ] : [])],
      }],
    };
    writeFileSync(appFile, JSON.stringify([{ id: "app-123", spec,
      region: { slug: "sfo" }, default_ingress: "https://api.example.test",
      active_deployment: { id: "dep-789", phase: "ACTIVE" },
    }]));
    writeFileSync(fakeDoctl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps create-deployment" ]]; then
  printf '%s' '[]'
elif [[ "$1 $2" == "apps update" ]]; then
  cat > "$FAKE_SUBMITTED_SPEC"
  jq --slurpfile spec "$FAKE_SUBMITTED_SPEC" '.[0].spec = $spec[0]' "$FAKE_APP_FILE" > "$FAKE_APP_FILE.next"
  mv "$FAKE_APP_FILE.next" "$FAKE_APP_FILE"
  printf '%s' '[]'
elif [[ "$1 $2" == "apps get" ]]; then
  cat "$FAKE_APP_FILE"
elif [[ "$1 $2" == "apps get-deployment" ]]; then
  jq --arg commit '${expectedCommit}' --arg leak "$FAKE_ACTIVE_LEAK" '
    [.[0] | {id:"dep-789",phase:"ACTIVE",spec:.spec,services:[{name:"api",source_commit_hash:$commit}]} |
      if $leak == "true" then .spec.services[0].envs += [{key:"SMARTLEAD_API_KEY",value:"retired-secret-still-active"}] else . end]
  ' "$FAKE_APP_FILE"
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`);
    writeFileSync(fakeGit, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "ls-remote" && "$2" == "${expectedRepository}" && "$3" == "refs/heads/main" ]]; then
  printf '%s\\t%s\\n' '${expectedCommit}' 'refs/heads/main'
else
  exit 64
fi
`);
    writeFileSync(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
case "$url" in
  */healthz) printf '%s' '{"status":"ok"}' ;;
  */readyz/crm) printf '%s' '{"status":"ready","capability":"lifty-crm-company.v1"}' ;;
  */readyz/crm-mapping) printf '%s' '{"status":"ready","capability":"lifty-crm-mapping.v1"}' ;;
  */readyz) printf '%s' '{"status":"ready"}' ;;
  */openapi.json) printf '%s' '{"openapi":"3.1.0"}' ;;
  */v1/context/business\\?client_contract=lifty-cli-context.v11) printf '%s' '{"task":"business","operations":{"get":{"route":"/v1/workspace/business"},"patch":{"method":"PATCH"}}}' ;;
  */v1/context/setup\\?client_contract=lifty-cli-context.v11) printf '%s' '{"task":"setup","operations":{"delete_draft":{"method":"DELETE"},"generation_context":{"route":"/v1/workspace/setup/context"}}}' ;;
  */v1/workspace)
    output=''
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--output" ]]; then output="$2"; shift 2; else shift; fi
    done
    printf '%s' '{"error":{"code":"UNAUTHORIZED"}}' > "$output"
    printf '401'
    ;;
  *) exit 22 ;;
esac
`);
    for (const executable of [fakeDoctl, fakeCurl, fakeGit]) chmodSync(executable, 0o755);
    try {
      const result = spawnSync("bash", [script, "deploy", expectedCommit, ...(options.forceRebuild ? ["--force-rebuild"] : [])], {
        encoding: "utf8", env: {
          ...process.env, FAKE_DOCTL_CALLS: calls, FAKE_APP_FILE: appFile,
          FAKE_SUBMITTED_SPEC: submittedSpec, FAKE_ACTIVE_LEAK: String(options.activeLeak),
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });
      const doctlCalls = readFileSync(calls, "utf8");
      const mutations = doctlCalls.trim().split("\n").filter(call => /^apps (update|create-deployment) /.test(call));
      expect(result.stdout + result.stderr).not.toMatch(/retired-secret|keep-mailivery-private/);
      if (options.retired && options.forceRebuild) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("rerun without --force-rebuild");
        expect(mutations).toEqual([]);
        return;
      }
      expect(mutations).toEqual([options.retired
        ? "apps update app-123 --spec - --update-sources --wait -o json"
        : `apps create-deployment app-123${options.forceRebuild ? " --force-rebuild" : ""} --wait -o json`]);
      if (options.retired) {
        expect(JSON.parse(readFileSync(submittedSpec, "utf8"))).toEqual({
          ...spec, envs: [keptAppEnv], services: [{ ...spec.services[0], envs: [keptServiceEnv] }],
        });
      }
      if (options.activeLeak) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("retired provider credentials remain");
        expect(result.stdout).not.toContain("Smoke checks passed");
        return;
      }
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Deployment: dep-789 (ACTIVE)");
      expect(result.stdout).toContain(`Commit: ${expectedCommit}`);
      expect(result.stdout).toContain("Smoke checks passed: https://api.example.test");
      if (options.retired) expect(result.stdout).toContain("Retired provider environment entries removed: 4");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
