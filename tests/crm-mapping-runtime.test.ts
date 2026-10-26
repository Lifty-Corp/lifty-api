import { describe, it, expect } from "vitest";
import { fixture, leadRef, runRef } from "./crm-mapping-fixture.js";
import * as C from "../src/crm-mapping/contracts.js";
import { runCrmMapping } from "../src/crm-mapping/runtime.js";
describe("scoped CRM mapping runtime", () => {
  it("exposes full property catalog including native Industry without credentials", async () => {
    const f = fixture();
    const catalog = C.CrmMappingCatalogSchema.parse(await f.run("catalog"));
    expect(catalog.properties.company.some((p) => p.name === "industry")).toBe(
      true,
    );
    expect(catalog.sources.discovery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "person_city" }),
        expect.objectContaining({ column: "industry" }),
      ]),
    );
    expect(JSON.stringify(catalog)).not.toMatch(
      /scoped-access|fixture-only|capability-key/,
    );
  });
  it("keeps personal and company locations separate with saved evidence", async () => {
    const f = fixture();
    expect(await f.run("sources", { lead_refs: [leadRef] })).toMatchObject({
      leads: [
        {
          discovery: { person_city: null },
          company_research: { headquarters_city: "Buenos Aires" },
        },
      ],
    });
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("previews and schedules exactly the selected applied revision; retries reuse receipt", async () => {
    const f = fixture();
    const preview = C.CrmMappingPreviewSchema.parse(
      await f.run("preview", { ...f.scope(), lead_refs: [leadRef] }),
    );
    const request = {
      ...f.scope(),
      lead_refs: [leadRef],
      preview_digest: preview.preview_digest,
      request_ref: runRef,
    };
    expect(await f.run("sync", request)).toMatchObject({
      status: "queued",
      run_ref: runRef,
    });
    expect(f.enqueue).toHaveBeenCalledWith(runRef, f.state.workspace_ref);
    const calls = f.provider.mock.calls.length;
    f.records.company.industry = "COMPUTER_SOFTWARE";
    expect(await f.run("sync", request)).toMatchObject({ run_ref: runRef });
    expect(f.provider.mock.calls).toHaveLength(calls);
    expect(
      f.rpc.mock.calls.filter(([, a]) => a.p_operation === "sync"),
    ).toHaveLength(1);
    expect(f.writes).toEqual([]);
  });
  it("rejects changed CRM values between preview and scheduling", async () => {
    const f = fixture();
    const preview = C.CrmMappingPreviewSchema.parse(
      await f.run("preview", { ...f.scope(), lead_refs: [leadRef] }),
    );
    f.records.company.industry = "OTHER";
    await expect(
      f.run("sync", {
        ...f.scope(),
        lead_refs: [leadRef],
        preview_digest: preview.preview_digest,
        request_ref: runRef,
      }),
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("cannot schedule an empty preview as successful updates", async () => {
    const f = fixture();
    f.lead.discovery.industry = null;
    const preview = C.CrmMappingPreviewSchema.parse(
      await f.run("preview", { ...f.scope(), lead_refs: [leadRef] }),
    );
    await expect(
      f.run("sync", {
        ...f.scope(),
        lead_refs: [leadRef],
        preview_digest: preview.preview_digest,
        request_ref: runRef,
      }),
    ).rejects.toMatchObject({ code: "NO_FIELDS_TO_APPLY" });
  });
  it("applies general mapping edits through shared validator and atomic capability", async () => {
    const f = fixture();
    const catalog = C.CrmMappingCatalogSchema.parse(await f.run("catalog"));
    const { created_at: _c, updated_at, id, ...values } = f.state.mappings[0]!;
    const edit = {
      ...values,
      id,
      expected_updated_at: updated_at,
      write_rule: "overwrite_lift_field",
    };
    expect(
      await f.run("apply", {
        ...f.scope(),
        schema_version: catalog.schema_version,
        edits: [edit],
      }),
    ).toMatchObject({ state: "applied", mapping_version: "b".repeat(64) });
    expect(
      f.rpc.mock.calls.find(([, a]) => a.p_operation === "apply")?.[1].p_payload
        .updates,
    ).toMatchObject([
      {
        id,
        expected_updated_at: updated_at,
        values: { write_rule: "overwrite_lift_field" },
      },
    ]);
    expect(f.writes).toEqual([]);
  });
  it("rejects stale per-row edits and leaves unrelated mappings intact", async () => {
    const f = fixture(),
      catalog = C.CrmMappingCatalogSchema.parse(await f.run("catalog"));
    const { created_at: _c, updated_at: _u, ...values } = f.state.mappings[0]!;
    await expect(
      f.run("apply", {
        ...f.scope(),
        schema_version: catalog.schema_version,
        edits: [{ ...values, expected_updated_at: "old" }],
      }),
    ).rejects.toMatchObject({ code: "STALE_CONTEXT" });
    expect(f.rpc.mock.calls.some(([, a]) => a.p_operation === "apply")).toBe(
      false,
    );
  });
  it("creates a property when the connection's own scopes allow it and verifies the schema", async () => {
    const f = fixture(),
      catalog = C.CrmMappingCatalogSchema.parse(await f.run("catalog"));
    expect(catalog.capabilities).toMatchObject({ credential: "oauth",
      map_fields: { state: "available" }, create_fields: { contact: { state: "available" }, company: { state: "available" } } });
    expect(catalog).not.toHaveProperty("allow_provisioning");
    const request = {
      ...f.scope(),
      schema_version: catalog.schema_version,
      object: "contact",
      property: {
        name: "lifty_test",
        label: "Lifty Test",
        groupName: "contactinformation",
        type: "string",
        fieldType: "text",
      },
    };
    // The database's retired allow_provisioning flag no longer decides.
    f.rpc.mockImplementationOnce(async () => ({ data: { ...structuredClone(f.state), allow_provisioning: false }, error: null }));
    expect(await f.run("property_create", request)).toMatchObject({
      state: "created",
      property: { name: "lifty_test" },
    });
    expect(f.writes).toEqual(["lifty_test"]);
  });
  it("reads a private-app token's scopes from HubSpot and refuses creation it does not allow", async () => {
    const f = fixture();
    f.credential.secret = "scoped-access";
    f.credential.privateAppScopes = ["crm.objects.companies.write", "crm.objects.contacts.write", "crm.schemas.contacts.write"];
    const catalog = C.CrmMappingCatalogSchema.parse(await f.run("catalog"));
    expect(catalog.capabilities).toEqual({
      credential: "private_app",
      scopes: ["crm.objects.companies.write", "crm.objects.contacts.write", "crm.schemas.contacts.write"],
      map_fields: { state: "available", missing_scopes: [] },
      create_fields: { contact: { state: "available", missing_scopes: [] },
        company: { state: "missing_permission", missing_scopes: ["crm.schemas.companies.write"] } },
    });
    const info = f.provider.mock.calls.find(([url]) => String(url).includes("access-token-info"))!;
    expect(JSON.parse(String(info[1]!.body))).toEqual({ tokenKey: "scoped-access" });
    await expect(f.run("property_create", {
      ...f.scope(), schema_version: catalog.schema_version, object: "company",
      property: { name: "lifty_tier", label: "Lifty tier", groupName: "companyinformation", type: "string", fieldType: "text" },
    })).rejects.toMatchObject({ code: "HUBSPOT_PERMISSION_REQUIRED", status: 409,
      issues: [expect.objectContaining({ message: "The HubSpot connection lacks crm.schemas.companies.write." })] });
    expect(f.writes).toEqual([]);
    // Unreadable scopes are unknown: HubSpot decides, and its refusal is the same named state.
    const unknown = fixture();
    unknown.credential.secret = "scoped-access";
    const unread = C.CrmMappingCatalogSchema.parse(await unknown.run("catalog"));
    expect(unread.capabilities).toMatchObject({ credential: "private_app", scopes: null,
      map_fields: { state: "unknown" }, create_fields: { company: { state: "unknown", missing_scopes: [] } } });
    const provider = unknown.provider.getMockImplementation()!;
    unknown.provider.mockImplementation(async (url, init) => init?.method === "POST" && String(url).includes("/crm/v3/properties/")
      ? Response.json({ category: "MISSING_SCOPES" }, { status: 403 }) : provider(url, init));
    await expect(unknown.run("property_create", {
      ...unknown.scope(), schema_version: unread.schema_version, object: "company",
      property: { name: "lifty_tier", label: "Lifty tier", groupName: "companyinformation", type: "string", fieldType: "text" },
    })).rejects.toMatchObject({ code: "HUBSPOT_PERMISSION_REQUIRED", status: 409 });
  });
  it("reports the connection state the CRM page gates on instead of failing", async () => {
    const f = fixture();
    expect(await f.run("capabilities")).toMatchObject({ workspace_ref: f.state.workspace_ref, connection: "connected",
      provider: "hubspot", portal_id: "52044090", capabilities: { credential: "oauth", create_fields: { company: { state: "available" } } } });
    for (const [message, expected] of [
      ["lifty_attio_reconnect_required", { connection: "reconnect_required", provider: "attio" }],
      ["lifty_hubspot_reconnect_required", { connection: "reconnect_required", provider: "hubspot" }],
      ["lifty_company_mapping_unsupported", { connection: "not_connected", provider: null }],
      ["lifty_hubspot_connection_unavailable", { connection: "not_connected", provider: null }],
    ] as const) {
      f.rpc.mockImplementationOnce(async () => ({ data: null, error: { code: "PT409", message } }));
      expect(await f.run("capabilities")).toEqual({ workspace_ref: f.state.workspace_ref, ...expected });
    }
    // Anything else stays an error, never a guessed state.
    f.rpc.mockImplementationOnce(async () => ({ data: null, error: { code: "PT403", message: "lifty_crm_mapping_forbidden" } }));
    await expect(f.run("capabilities")).rejects.toMatchObject({ code: "FORBIDDEN_WORKSPACE" });
  });
  it("finds existing Industry before creating a duplicate property", async () => {
    const f = fixture(),
      catalog = C.CrmMappingCatalogSchema.parse(await f.run("catalog"));
    await expect(
      f.run("property_create", {
        ...f.scope(),
        schema_version: catalog.schema_version,
        object: "company",
        property: {
          name: "industry_new",
          label: "Industry",
          groupName: "companyinformation",
          type: "string",
          fieldType: "text",
        },
      }),
    ).rejects.toMatchObject({ code: "HUBSPOT_PROPERTY_ALREADY_EXISTS" });
    expect(f.writes).toEqual([]);
  });
  it("denies mismatched provider portals before property or record access", async () => {
    const f = fixture();
    f.provider.mockResolvedValue(Response.json({ portalId: 999 }));
    await expect(f.run("catalog")).rejects.toMatchObject({
      code: "WORKSPACE_OR_PORTAL_CHANGED",
    });
    expect(f.writes).toEqual([]);
  });
  it("maintenance blocks all mutations before storage/provider work", async () => {
    const f = fixture();
    for (const action of ["apply", "sync", "property_create"] as const)
      await expect(
        runCrmMapping(f.session, { ...f.settings, readOnly: true }, action, {}),
      ).rejects.toMatchObject({ code: "MAINTENANCE_READ_ONLY" });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("safely strips unknown storage failure details", async () => {
    const f = fixture();
    f.rpc.mockRejectedValue(new Error("fixture-only-secret"));
    await expect(f.run("catalog")).rejects.toMatchObject({
      code: "CRM_MAPPING_UNAVAILABLE",
    });
  });
});
