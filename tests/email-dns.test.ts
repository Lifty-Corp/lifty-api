import { describe, expect, it } from "vitest";
import { createEmailDnsOperations } from "../src/email-dns.js";
import { createCurrentClient as createApp } from "./current-client.js";

const workspace = "22222222-2222-4222-8222-222222222222";
const connection = "55555555-5555-4555-8555-555555555555";
const recheckRef = "77777777-7777-4777-8777-777777777777";

const stored = (overrides: Record<string, unknown> = {}) => ({
  workspace_ref: workspace, connection_ref: connection, domain: "acme.example", state: "failing",
  checked_at: "2026-11-05T15:00:00.000000+00:00", provider: "google", failing: ["spf", "dkim"],
  fixes: [
    { record: "spf", step: "Add this TXT record at your DNS host.", dns: { type: "TXT", name: "@", value: "v=spf1 include:_spf.google.com ~all" } },
    { record: "dkim", step: "Generate the key.", adminUrl: "https://admin.google.com/ac/appsettings/740348119625", adminLabel: "Open Google Admin console" },
  ],
  recheck: null, ...overrides,
});

function harness(options: { data?: unknown; error?: unknown } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const operations = createEmailDnsOperations();
  const session = { userId: "11111111-1111-4111-8111-111111111111", client: { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return options.error ? { data: null, error: options.error } : { data: options.data ?? stored(), error: null };
  } } };
  const client = createApp({ log: () => {},
    authenticate: async () => ({ ok: true, session }),
    getEmailDns: operations.status, recheckEmailDns: operations.recheck });
  const get = (query: string) => client.request(`/v1/email/dns${query}`, { headers: { authorization: "Bearer test" } });
  const post = (body: unknown) => client.request("/v1/email/dns/recheck", { method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { calls, get, post };
}
const target = { workspace, connection_ref: connection };

describe("email DNS routes", () => {
  it("reads one exact account through the member session and renames only the public fields", async () => {
    const h = harness();
    const response = await h.get(`?workspace=${workspace}&connection_ref=${connection}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { fixes: Record<string, unknown>[] };
    expect(body.fixes[1]).toEqual({ record: "dkim", step: "Generate the key.",
      admin_url: "https://admin.google.com/ac/appsettings/740348119625", admin_label: "Open Google Admin console" });
    expect(h.calls).toEqual([{ name: "lifty_email_dns", args: { p_operation: "status", p_payload: target } }]);
  });

  it("records the click through the same authorization and returns the pending request", async () => {
    const h = harness({ data: stored({ recheck: { recheck_ref: recheckRef, state: "pending", requested_at: "2026-11-05T15:00:00+00:00",
      deadline_at: "2026-11-05T15:30:00+00:00", completed_at: null, failing: [] } }) });
    const response = await h.post(target);
    expect(response.status).toBe(200);
    expect((await response.json() as { recheck: { state: string } }).recheck.state).toBe("pending");
    expect(h.calls).toEqual([{ name: "lifty_email_dns", args: { p_operation: "recheck", p_payload: target } }]);
  });

  it.each([
    ["email_connection_required", 409, "EMAIL_CONNECTION_REQUIRED"], ["email_workspace_forbidden", 403, "EMAIL_WORKSPACE_FORBIDDEN"],
    ["email_workspace_suspended", 409, "EMAIL_WORKSPACE_SUSPENDED"], ["unexpected_internal_detail", 502, "EMAIL_DNS_UNAVAILABLE"],
  ])("maps the database refusal %s without leaking it", async (message, status, code) => {
    const response = await harness({ error: { message } }).post(target);
    expect(response.status).toBe(status);
    const body = await response.text();
    expect(JSON.parse(body).error.code).toBe(code);
    expect(body).not.toContain("unexpected_internal_detail");
  });

  it("requires an explicit account before reaching the database", async () => {
    const h = harness();
    expect((await h.get(`?workspace=${workspace}`)).status).toBe(400);
    expect((await h.post({ workspace })).status).toBe(400);
    expect((await h.post({ ...target, connection_ref: "other" })).status).toBe(400);
    expect((await h.post({ ...target, tags: ["extra"] })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it("refuses an answer about another account", async () => {
    const response = await harness({ data: stored({ connection_ref: "66666666-6666-4666-8666-666666666666" }) }).post(target);
    expect(response.status).toBe(502);
  });

  it("publishes both routes as authenticated OpenAPI", async () => {
    const contract = await (await createApp({ log: () => {} }).request("/openapi.json")).json() as { paths: Record<string, Record<string, { security?: unknown[] }>> };
    expect(contract.paths["/v1/email/dns"]?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(contract.paths["/v1/email/dns/recheck"]?.post?.security).toEqual([{ bearerAuth: [] }]);
  });
});
