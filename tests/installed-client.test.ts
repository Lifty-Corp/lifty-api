import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { SUPPORTED_CLIENT_CONTRACTS } from "../src/agent-context.js";
import { stageOperations } from "../src/stage-contracts.js";
import { receipt } from "./senders-fixtures.js";

// What installed clients already depend on. @liftleadershipgroup/lifty
// 0.1.0-next.35 implements lifty-cli-context.v11; founders are not asked to
// update for API releases (LIF-1293). A failure here means the change breaks
// installed clients: keep the old shape, or make it a deliberate transport
// change with a new contract and client release.
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Routes each client calls without the operation catalog (its dist/cli.js).
const directRoutes: Record<string, readonly (readonly [string, string])[]> = {
  "lifty-cli-context.v11": [["GET", "/v1/me/workspaces"], ["GET", "/v1/workspace/summary"]],
};

// LIF-1771 S-17: the CLI has no Senders code. Its generic dispatcher reads the
// catalog and builds the request from `method`, `route` and `cli.operation`.
// Every new control must work through exactly that, with the same receipts.
const senderId = "33333333-3333-4333-8333-333333333333";
const handoff = receipt("handoff.ready");
const settings = receipt("settings.defaults");
const approve = { action: "approve_sample_and_transfer", confirm: true, source_sender_id: handoff.source_sender_id, replacement_sender_id: handoff.replacement.sender_id,
  scope_sha256: handoff.scope_sha256, settings_sha256: handoff.settings_sha256, context_sha256: handoff.context_sha256, revision: handoff.revision };
const stopTarget = { scope: "account", account_id: receipt("stop.set").stop.account_id };
const reply = receipt("handoff.held").samples[0];
const scope = receipt("sender.transfer_scope");
const controls: readonly { stage: string; command: string; path?: Record<string, string>; query?: Record<string, string>; body?: unknown; rpc: string; fixture: string }[] = [
  { stage: "senders", command: "POST pause", path: { id: senderId }, body: { expected_version: 2, confirm: true }, rpc: "pause_lifty_sender", fixture: "sender.pause" },
  { stage: "senders", command: "POST resume", path: { id: senderId }, body: { expected_version: 3, confirm: true }, rpc: "resume_lifty_sender", fixture: "sender.resume" },
  { stage: "senders", command: "GET settings-get", rpc: "get_lifty_workspace_settings", fixture: "settings.defaults" },
  { stage: "senders", command: "PATCH settings-patch", body: { expected_version: 0, handoff: { sample_size: 3 } }, rpc: "update_lifty_workspace_settings", fixture: "settings.update" },
  { stage: "senders", command: "GET handoff-get", path: { handoff_ref: "163" }, rpc: "get_lifty_sender_handoff", fixture: "handoff.ready" },
  { stage: "senders", command: "POST handoff-prepare", path: { handoff_ref: "163" }, body: {}, rpc: "prepare_lifty_sender_handoff", fixture: "handoff.ready" },
  { stage: "senders", command: "POST handoff-approve", path: { handoff_ref: "163" }, body: approve, rpc: "approve_lifty_sender_handoff", fixture: "handoff.approve" },
  { stage: "senders", command: "POST handoff-cancel", path: { handoff_ref: "164" }, body: { confirm: true, revision: handoff.revision }, rpc: "cancel_lifty_sender_handoff", fixture: "handoff.cancel" },
  { stage: "senders", command: "POST handoff-settings-revise", path: { handoff_ref: "163" }, body: { revision: handoff.revision, generation_settings: { instructions: "Short." } }, rpc: "revise_lifty_sender_handoff_settings", fixture: "handoff.ready" },
  { stage: "senders", command: "POST handoff-reply-revise", path: { handoff_ref: "154", turn_ref: reply.turn_ref }, body: { turn_version: reply.turn_version, draft_event_ref: reply.draft_event_ref, text: "Hi." }, rpc: "revise_lifty_sender_handoff_reply", fixture: "handoff.held" },
  { stage: "senders", command: "GET transfer-scope", path: { id: scope.sender_id }, rpc: "get_lifty_sender_transfer_scope", fixture: "sender.transfer_scope" },
  { stage: "senders", command: "GET stops-get", rpc: "get_lifty_stops", fixture: "stop.list" },
  { stage: "senders", command: "POST stop-set", body: { ...stopTarget, reason: "setup" }, rpc: "set_lifty_stop", fixture: "stop.set" },
  { stage: "senders", command: "POST stop-release", body: stopTarget, rpc: "release_lifty_stop", fixture: "stop.release" },
  { stage: "senders", command: "POST stop-review", body: { ...stopTarget, review_by: "2026-11-30T00:00:00Z" }, rpc: "move_lifty_stop_review", fixture: "stop.move" },
  { stage: "sending-accounts", command: "GET incidents-get", rpc: "get_lifty_recovery_incidents", fixture: "recovery.incidents" },
  { stage: "campaigns", command: "GET reply_counts_get", query: { sender_id: receipt("review.counts.sender").counts.senders[0].sender_id }, rpc: "get_lifty_reply_turn_counts", fixture: "review.counts.sender" },
];

describe("installed clients", () => {
  it.each(controls)("run $stage $command from the catalog alone", async ({ stage, command, path, query, body, rpc, fixture }) => {
    const calls: string[] = [];
    const client = { rpc: async (name: string) => {
      calls.push(name);
      return { data: name === "get_lifty_workspace_settings" && rpc !== name ? settings : receipt(fixture), error: null };
    } };
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client } }), enqueueHandoffReplies: async () => ({ id: "run" }), log: () => {} });
    const context = await (await app.request(`/v1/context/${stage}?client_contract=${SUPPORTED_CLIENT_CONTRACTS[0]}`)).json();
    const [method, name] = command.split(" ") as [string, string];
    // The client's resolveStageOperation: one operation per method and cli name.
    const operations = Object.values(context.operations as Record<string, { method: string; route: string; cli?: { operation?: string } }>)
      .filter(item => item.method === method && item.cli?.operation === name);
    expect(operations).toHaveLength(1);
    const route = operations[0]!.route.replace(/\{([^}]+)\}/g, (_, key: string) => path![key]!);
    const response = await app.request(`${route}${query ? `?${new URLSearchParams(query)}` : ""}`, { method,
      headers: { authorization: "Bearer founder", "x-lifty-client-contract": SUPPORTED_CLIENT_CONTRACTS[0]!, "x-lifty-workspace": "example", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(calls.at(-1)).toBe(rpc);
  });


  it("keep the transport contracts they send", () => {
    // Change only with the transport itself, never for an API or context release.
    expect(SUPPORTED_CLIENT_CONTRACTS).toEqual(Object.keys(directRoutes));
  });

  it("receive every context in the envelope and catalog shape they validate", async () => {
    const app = createApp();
    for (const [contract, task] of SUPPORTED_CLIENT_CONTRACTS.flatMap(contract =>
      ["stages", ...Object.keys(stageOperations)].map(task => [contract, task] as const))) {
      const response = await app.request(`/v1/context/${task}?client_contract=${contract}`);
      expect(response.status, task).toBe(200);
      expect(response.headers.get("content-type"), task).toMatch(/^application\/json(?:\s*;|$)/i);
      const value = await response.json();
      // The client's readTaskContext check.
      expect(object(value) && value.format === "lifty-context.v1" && value.task === task
        && /^sha256:[a-f0-9]{64}$/.test(String(value.revision))
        && typeof value.instructions === "string" && value.instructions.trim() !== ""
        && object(value.schemas) && Object.values(value.schemas).every(object)
        && object(value.references) && Object.values(value.references).every(item => typeof item === "string"), task).toBe(true);
      // The client's resolveStageOperation and request builder: one command per
      // method and name, and routes made of literal segments or whole placeholders.
      const commands = new Set<string>();
      for (const [key, operation] of Object.entries((value.operations ?? {}) as Record<string, { method: string; route: string; cli?: { operation?: string } }>)) {
        const name = `${task}.${key}`;
        expect(["GET", "POST", "PATCH", "DELETE"], name).toContain(operation.method);
        expect(operation.route, name).toMatch(/^\/v1\/[A-Za-z0-9_{}/-]+$/);
        for (const segment of operation.route.split("/").slice(1))
          expect(segment, name).toMatch(/^(?:[A-Za-z0-9_-]+|\{.+\})$/);
        const command = `${operation.method} ${operation.cli?.operation ?? key}`;
        expect(commands.has(command), `${task}: ${command}`).toBe(false);
        commands.add(command);
      }
    }
  });

  it("keep reaching the routes they call directly", async () => {
    const app = createApp({
      authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      log: () => {},
    });
    for (const [contract, method, path] of Object.entries(directRoutes).flatMap(([contract, routes]) =>
      routes.map(([method, path]) => [contract, method, path] as const))) {
      const response = await app.request(path, {
        method,
        headers: { authorization: "Bearer founder", "x-lifty-client-contract": contract, "content-type": "application/json" },
        ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
      });
      // An unrouted path gets the framework's plain-text 404; a routed one
      // answers in JSON even when its dependencies are not configured.
      expect(response.headers.get("content-type") ?? "", `${contract} ${method} ${path} returned ${response.status}`).toMatch(/application\/json/);
      expect(response.status, `${contract} ${method} ${path}`).not.toBe(409);
    }
  });
});
