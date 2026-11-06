import { describe, expect, it } from "vitest";
import { createCurrentClient as createApp } from "./current-client.js";
import { getWorkspaceStatus, getNotificationTiming, setNotificationTiming } from "../src/workspace-operations.js";
import { callStageMcpTool } from "../src/mcp-stage-tools.js";
import { notificationsDatabase, workspaceRef, slackRef } from "./notification-fixtures.js";

const headers = { authorization: "Bearer founder", "content-type": "application/json" };
const timing = { kind: "calendar", frequency: "weekly", weekday: 0, hour: 9, minute: 30, timezone: "America/Argentina/Buenos_Aires" };
const configuration = { workspaceId: workspaceRef, typeCode: "email.deliverability", editable: true, effective: timing,
  global: { timing: { kind: "immediate" }, version: 8 }, workspace: { timing, version: 2 } };
function fixture(options: { result?: unknown; error?: unknown } = {}) {
  const db = notificationsDatabase();
  const calls: { name: string; args?: Record<string, unknown> }[] = [];
  const client = { ...db.client, schema: (schema: string) => ({ rpc: async (name: string, args?: Record<string, unknown>) => {
    if (name !== "get_timing" && name !== "set_timing") return db.client.schema(schema).rpc(name, args);
    calls.push({ name, ...(args === undefined ? {} : { args }) });
    return { data: options.result ?? configuration, error: options.error ?? null };
  } }) };
  const app = createApp({ authenticate: async () => ({ ok: true as const, session: { userId: "founder", client } }), getWorkspace: getWorkspaceStatus, getNotificationTiming, setNotificationTiming });
  const put = (value: unknown) => app.request("/v1/notifications/timing", { method: "PUT", headers, body: JSON.stringify(value) });
  return { app, put, calls };
}

describe("notification timing authenticated boundary", () => {
  it("uses the selected workspace and carries its version, weekly timezone and inheritance reset intact", async () => {
    const f = fixture();
    const read = await f.app.request("/v1/notifications/timing/email.deliverability", { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(configuration);
    expect((await f.put({ notification_type: "email.deliverability", expected_version: 2, timing })).status).toBe(200);
    expect((await f.put({ notification_type: "email.deliverability", expected_version: 3, timing: null })).status).toBe(200);
    expect(f.calls).toEqual([
      { name: "get_timing", args: { p_workspace_id: workspaceRef, p_type_code: "email.deliverability" } },
      { name: "set_timing", args: { p_workspace_id: workspaceRef, p_type_code: "email.deliverability", p_expected_version: 2, p_timing: timing } },
      { name: "set_timing", args: { p_workspace_id: workspaceRef, p_type_code: "email.deliverability", p_expected_version: 3, p_timing: null } },
    ]);
  });
  it("rejects scope injection and ambiguous or invalid schedules before reaching the database", async () => {
    const f = fixture();
    const valid = { notification_type: "email.deliverability", expected_version: 0, timing };
    for (const body of [
      { ...valid, workspaceId: slackRef }, { ...valid, expected_version: -1 },
      { ...valid, timing: { ...timing, weekday: undefined } }, { ...valid, timing: { ...timing, timezone: "Invalid/Zone" } },
      { ...valid, timing: { kind: "delay", delayMinutes: 1.5 } }, { ...valid, timing: { kind: "immediate", delayMinutes: 30 } },
    ]) expect((await f.put(body)).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });
  it("does not accept another tenant or type's timing response", async () => {
    for (const result of [{ ...configuration, workspaceId: slackRef }, { ...configuration, typeCode: "reply.requires_action" }, { ...configuration, workspace: null }]) {
      const f = fixture({ result });
      expect((await f.app.request("/v1/notifications/timing/email.deliverability", { headers })).status).toBe(502);
    }
  });
  it("preserves permission and CAS failures without a blind retry", async () => {
    for (const [code, status] of [["40001", 409], ["42501", 403], ["22023", 400]] as const) {
      const f = fixture({ error: { code, message: "Rejected" } });
      expect((await f.put({ notification_type: "email.deliverability", expected_version: 2, timing })).status).toBe(status);
      expect(f.calls).toHaveLength(1);
    }
  });
  it("exposes timing through the same MCP and stage transport with its explicit CAS input", async () => {
    const f = fixture();
    const body = { notification_type: "email.deliverability", expected_version: 2, timing };
    const result = await callStageMcpTool("notifications_timing_set", { body }, new Request("https://api.example.test/mcp", { headers }),
      async (route, init) => f.app.request(route, init));
    expect(result.isError).not.toBe(true);
    expect(f.calls[0]?.args).toEqual({ p_workspace_id: workspaceRef, p_type_code: "email.deliverability", p_expected_version: 2, p_timing: timing });
  });
});
