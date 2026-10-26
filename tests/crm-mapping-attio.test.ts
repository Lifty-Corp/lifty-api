import { describe, expect, it, vi } from "vitest";
import { runCrmMapping } from "../src/crm-mapping/runtime.js";
import type { CrmMappingAction, LeadSource, State } from "../src/crm-mapping/contracts.js";

const ws = "12380000-0000-4000-a000-00000000000a";
const attioWorkspace = "aaaaaaaa-1238-4000-a000-000000000001";
const person = "bbbbbbbb-1238-4000-a000-000000000002";
const company = "cccccccc-1238-4000-a000-000000000003";
const token = `attio-access-${"x".repeat(40)}`;

function attioFixture(options: { self?: Record<string, unknown>; selfStatus?: number } = {}) {
  const state: State = {
    provider: "attio", workspace_ref: ws, workspace_name: "Acme", integration_ref: "12380000-0000-4000-a000-000000000011",
    portal_id: attioWorkspace, mapping_version: "a".repeat(64),
    mappings: [{
      id: "12380000-0000-4000-a000-000000000021", workspace_id: ws, provider: "attio", source_stage: "discovery", source_entity: "lead",
      source_field: "industry", label: "Industry", source_path: ["industry"], destination_object: "company", destination_field: "industry",
      write_rule: "only_if_empty", transform: "none", transform_config: {}, value_source: "path", enabled: true, required_from_agent: false,
      fallback_group: null, fallback_priority: null, sort_order: 1,
      created_at: "2026-10-05", updated_at: "2026-10-05",
    }],
  };
  const lead: LeadSource = {
    lead_ref: "12380000-0000-4000-a000-000000000031", name: "Ada Founder", company: "Acme", company_ref: ws,
    crm_contact_id: person, crm_company_id: company,
    discovery: { email: "ada@acme.com", industry: "Software" }, company_discovery: { company_name: "Acme", company_domain: "acme.com" },
    lead_research: null, company_research: null,
  };
  const scope = { workspace_ref: ws, integration_ref: state.integration_ref, portal_id: attioWorkspace };
  const rpcCalls: string[] = [];
  const rpc = vi.fn(async (_name: string, args: { p_operation: string; p_payload: Record<string, unknown> }) => {
    rpcCalls.push(args.p_operation);
    switch (args.p_operation) {
      case "state": return { data: structuredClone(state), error: null };
      case "credential": return { data: { ...scope, secret: token, credential_version: "c".repeat(64) }, error: null };
      case "reconnect": return { data: { status: "reconnect_required" }, error: null };
      case "sources": return { data: { workspace_ref: ws, leads: [structuredClone(lead)] }, error: null };
      case "records": return { data: { ...scope, run_ref: "12380000-0000-4000-a000-000000000041", sync_state: "succeeded", leads: [structuredClone(lead)] }, error: null };
      default: return { data: null, error: { message: "unexpected_operation" } };
    }
  });
  const attributes: Record<string, Array<Record<string, unknown>>> = {
    people: [
      { api_slug: "email_addresses", title: "Email addresses", type: "email-address", is_writable: true, is_archived: false, is_multiselect: true },
      { api_slug: "name", title: "Name", type: "personal-name", is_writable: true, is_archived: false },
    ],
    companies: [
      { api_slug: "domains", title: "Domains", type: "domain", is_writable: true, is_archived: false, is_multiselect: true },
      { api_slug: "industry", title: "Industry", type: "select", is_writable: true, is_archived: false },
    ],
  };
  const optionsBySlug: Record<string, Array<{ title: string; is_archived: boolean }>> = { industry: [{ title: "Software", is_archived: false }, { title: "Old", is_archived: true }] };
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    const path = new URL(String(url)).pathname.replace(/^\/v2/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    if (path === "/self") return Response.json({ active: true, workspace_id: attioWorkspace, ...options.self }, { status: options.selfStatus ?? 200 });
    const match = path.match(/^\/objects\/(people|companies)\/(attributes|records\/query)(?:\/([a-z_]+))?(?:\/(options|statuses))?$/);
    const object = match?.[1] as "people" | "companies";
    if (match?.[2] === "records/query") {
      expect(body.filter.record_id.$in).toEqual([object === "people" ? person : company]);
      return Response.json({ data: [object === "people"
        ? { id: { record_id: person }, web_url: `https://app.attio.com/acme/person/${person}`, values: { email_addresses: [{ email_address: "other@acme.com" }, { email_address: "ADA@acme.com" }] } }
        : { id: { record_id: company }, web_url: `https://app.attio.com/acme/company/${company}`, values: { domains: [{ domain: "acme.com" }], industry: [] } }] });
    }
    if (match?.[4] && method === "GET") return Response.json({ data: optionsBySlug[match[3]!] ?? [] });
    if (match?.[4] && method === "POST") { (optionsBySlug[match[3]!] ??= []).push({ title: body.data.title, is_archived: false }); return Response.json({ data: {} }); }
    if (match?.[3] && method === "GET") return Response.json({ data: attributes[object]!.find(a => a.api_slug === match[3]) });
    if (match?.[2] === "attributes" && method === "POST") {
      attributes[object]!.push({ api_slug: body.data.api_slug, title: body.data.title, type: body.data.type, is_writable: true, is_archived: false });
      return Response.json({ data: {} });
    }
    if (match?.[2] === "attributes") return Response.json({ data: attributes[object] });
    return Response.json({}, { status: 404 });
  });
  const session = { userId: ws, client: { rpc } };
  const run = (action: CrmMappingAction, input?: unknown) =>
    runCrmMapping(session, { serverKey: "capability-key-with-sufficient-length", fetch, enqueue: vi.fn(async () => {}) }, action, input, { workspaceRef: ws });
  return { state, lead, run, requests, rpcCalls, scope: { ...scope, mapping_version: state.mapping_version } };
}

describe("Attio CRM mapping", () => {
  it("reads People and Companies attributes with select options for the catalog", async () => {
    const f = attioFixture();
    const catalog = await f.run("catalog") as { provider: string; properties: Record<string, Array<Record<string, unknown>>> };
    expect(catalog.provider).toBe("attio");
    expect(catalog.properties.company!.find(p => p.name === "industry")).toMatchObject({ type: "select", label: "Industry",
      options: [{ label: "Software", value: "Software", hidden: false }, { label: "Old", value: "Old", hidden: true }],
      modificationMetadata: { readOnlyValue: false } });
    // Identity attributes are written natively by the sync, never through mappings.
    expect(catalog.properties.contact!.find(p => p.name === "email_addresses")).toMatchObject({ modificationMetadata: { readOnlyValue: true } });
  });

  it("previews Attio records with the shared evaluator and the Jobs flattening", async () => {
    const f = attioFixture();
    const preview = await f.run("preview", { ...f.scope, lead_refs: [f.lead.lead_ref] }) as {
      plan: { records: Array<{ record_id: string; expected: unknown; proposed: unknown; evaluations: Array<{ mappings: Array<{ provider: string }> }> }> };
      issues: Array<{ reason: string; object: string }>;
    };
    expect(preview.plan.records).toEqual([expect.objectContaining({ record_id: company, expected: { domains: "acme.com", industry: null }, proposed: { industry: "Software" } })]);
    expect(preview.plan.records[0]!.evaluations[0]!.mappings[0]!.provider).toBe("attio");
    // A select value outside the live options is reported, never proposed.
    const invalid = attioFixture();
    invalid.lead.discovery.industry = "Fintech";
    const rejected = await invalid.run("preview", { ...invalid.scope, lead_refs: [invalid.lead.lead_ref] }) as typeof preview;
    expect(rejected.plan.records).toEqual([]);
    expect(rejected.issues).toEqual(expect.arrayContaining([expect.objectContaining({ object: "company", reason: "invalid_enum" })]));
  });

  // LIF-1584: operator workspaces also map to Attio LIFT objects, with research descriptions as labels.
  it("keeps saved LIFT-object mappings readable without previewing or enabling them here", async () => {
    const f = attioFixture();
    f.state.mappings.push({ ...f.state.mappings[0]!, id: "12380000-0000-4000-a000-000000000022", destination_object: "lift_company",
      destination_field: "gifting_insights", source_stage: "research", source_field: "gifting_insights",
      source_path: ["custom_fields", "gifting_insights"], label: "Gifting insights: ".padEnd(600, "x"), required_from_agent: true });
    const catalog = await f.run("catalog") as { schema_version: string; mappings: Array<{ destination_object: string }> };
    expect(catalog.mappings.map(m => m.destination_object)).toEqual(["company", "lift_company"]);
    const preview = await f.run("preview", { ...f.scope, lead_refs: [f.lead.lead_ref] }) as { plan: { records: Array<{ proposed: unknown }> } };
    expect(preview.plan.records).toEqual([expect.objectContaining({ proposed: { industry: "Software" } })]);
    const { created_at: _c, updated_at: updated, ...values } = f.state.mappings[1]!;
    await expect(f.run("apply", { ...f.scope, schema_version: catalog.schema_version,
      edits: [{ ...values, destination_field: "other", expected_updated_at: updated }] })).rejects.toMatchObject({ code: "MAPPING_PROPERTY_UNAVAILABLE" });
  });

  it("returns Attio's own verified record URLs and checks every identity value", async () => {
    const f = attioFixture();
    const records = await f.run("records", {}) as { provider: string; leads: Array<Record<string, unknown>> };
    expect(records.provider).toBe("attio");
    expect(records.leads[0]).toMatchObject({
      contact_status: "verified", contact_url: `https://app.attio.com/acme/person/${person}`,
      company_status: "verified", company_url: `https://app.attio.com/acme/company/${company}`,
    });
  });

  it("creates an Attio select attribute when the token can change the schema, and reads it back", async () => {
    const f = attioFixture({ self: { scope: "meeting:read note:read-write object_configuration:read-write record_permission:read-write" } });
    const catalog = await f.run("catalog") as { schema_version: string; capabilities: unknown };
    expect(catalog.capabilities).toEqual({ credential: "oauth",
      scopes: ["meeting:read", "note:read-write", "object_configuration:read-write", "record_permission:read-write"],
      map_fields: { state: "available", missing_scopes: [] },
      create_fields: { contact: { state: "available", missing_scopes: [] }, company: { state: "available", missing_scopes: [] } } });
    const created = await f.run("property_create", { ...f.scope, schema_version: catalog.schema_version, object: "company",
      property: { name: "icp_tier", label: "ICP tier", type: "select", options: [{ label: "A" }, { label: "B" }] } }) as { state: string; property: Record<string, unknown> };
    expect(created).toMatchObject({ state: "created", property: { name: "icp_tier", type: "select", options: [{ value: "A" }, { value: "B" }] } });
    expect(f.requests.filter(r => r.method === "POST" && /attributes/.test(r.path)).map(r => r.path)).toEqual([
      "/objects/companies/attributes", "/objects/companies/attributes/icp_tier/options", "/objects/companies/attributes/icp_tier/options"]);
    // A token Attio reports without schema write is refused before any write, naming the scope.
    const readOnly = attioFixture({ self: { scope: "object_configuration:read record_permission:read-write" } });
    await expect(readOnly.run("property_create", { ...readOnly.scope, schema_version: catalog.schema_version, object: "company",
      property: { name: "tier", label: "Tier", type: "text" } })).rejects.toMatchObject({ code: "ATTIO_PERMISSION_REQUIRED", status: 409,
      issues: [expect.objectContaining({ message: "The Attio connection lacks object_configuration:read-write." })] });
    expect(readOnly.requests.some(r => r.method === "POST")).toBe(false);
    // A HubSpot property definition never creates an Attio attribute.
    await expect(f.run("property_create", { ...f.scope, schema_version: catalog.schema_version, object: "company",
      property: { name: "tier", label: "Tier", groupName: "companyinformation", type: "string", fieldType: "text" } }))
      .rejects.toMatchObject({ code: "INVALID_PROPERTY_DEFINITION" });
  });

  it("binds the stored token to the connected Attio workspace and marks a revoked one for reconnect", async () => {
    const moved = attioFixture({ self: { workspace_id: "dddddddd-1238-4000-a000-000000000004" } });
    await expect(moved.run("catalog")).rejects.toMatchObject({ code: "WORKSPACE_OR_PORTAL_CHANGED" });
    const revoked = attioFixture({ selfStatus: 401 });
    await expect(revoked.run("catalog")).rejects.toMatchObject({ code: "ATTIO_RECONNECT_REQUIRED" });
    expect(revoked.rpcCalls).toContain("reconnect");
    const inactive = attioFixture({ self: { active: false } });
    await expect(inactive.run("catalog")).rejects.toMatchObject({ code: "ATTIO_RECONNECT_REQUIRED" });
  });
});
