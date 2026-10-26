import { vi, expect } from "vitest";
import { HUBSPOT_OAUTH_SCOPES } from "../src/generated/hubspot-grant-policy.js";
import { runCrmMapping } from "../src/crm-mapping/runtime.js";
import type {
  CrmMappingAction,
  State,
  LeadSource,
  Property,
} from "../src/crm-mapping/contracts.js";
export const ws = "89700000-0000-4000-a000-000000000001",
  leadRef = "89700000-0000-4000-a000-000000000002",
  runRef = "89700000-0000-4000-a000-000000000003";
export function fixture() {
  const state: State = {
    workspace_ref: ws,
    workspace_name: "Fixture",
    integration_ref: "89700000-0000-4000-a000-000000000004",
    portal_id: "52044090",
    provider: "hubspot",
    mapping_version: "a".repeat(64),
    mappings: [
      {
        id: "89700000-0000-4000-a000-000000000005",
        workspace_id: ws,
        provider: "hubspot",
        source_stage: "discovery",
        source_entity: "lead",
        source_field: "industry",
        label: "Industry",
        source_path: ["industry"],
        destination_object: "company",
        destination_field: "industry",
        write_rule: "only_if_empty",
        transform: "map_value",
        transform_config: { map: { "B2B software": "COMPUTER_SOFTWARE" } },
        value_source: "path",
        enabled: true,
        required_from_agent: false,
        fallback_group: null,
        fallback_priority: null,
        sort_order: 1,
        created_at: "2026-09-01",
        updated_at: "2026-09-01",
      },
    ],
  };
  const lead: LeadSource = {
    lead_ref: leadRef,
    name: "Abraham Jankans",
    company: "Launchpad Software",
    company_ref: ws,
    crm_contact_id: "123456789",
    crm_company_id: "987654321",
    discovery: {
      email: "founder@example.com",
      industry: "B2B software",
      person_city: null,
    },
    company_discovery: {
      company_name: "Launchpad Software",
      company_domain: "example.com",
    },
    lead_research: null,
    company_research: { headquarters_city: "Buenos Aires" },
  };
  const properties: { contact: Property[]; company: Property[] } = {
    contact: [
      { name: "email", label: "Email", type: "string", fieldType: "text" },
    ],
    company: [
      {
        name: "domain",
        label: "Company domain",
        type: "string",
        fieldType: "text",
      },
      {
        name: "industry",
        label: "Industry",
        type: "enumeration",
        fieldType: "select",
        options: [{ label: "Software", value: "COMPUTER_SOFTWARE" }],
      },
    ],
  };
  const records: {
    contact: Record<string, string | null>;
    company: Record<string, string | null>;
  } = {
    contact: { email: "founder@example.com" },
    company: { domain: "example.com", industry: null },
  };
  const grant = {
    access_token: "scoped-access",
    client_id: "client",
    client_secret: "fixture-only",
    refresh_token: "refresh",
    obtained_at_epoch: Math.floor(Date.now() / 1000),
    expires_at_epoch: Math.floor(Date.now() / 1000) + 3600,
    portal_id: state.portal_id,
    scopes: [...HUBSPOT_OAUTH_SCOPES],
  };
  // A bare token is an older HubSpot private app's; HubSpot reports its scopes.
  const credential: { secret: string | null; privateAppScopes: string[] | null } = { secret: null, privateAppScopes: null };
  let saved: Record<string, unknown> | null = null;
  const rpc = vi.fn(
    async (
      name: string,
      args: {
        p_server_key: string;
        p_operation: string;
        p_payload: Record<string, unknown>;
      },
    ): Promise<{ data: unknown; error: unknown }> => {
      const p = args.p_payload,
        operation = args.p_operation;
      expect(args.p_server_key).toBe("capability-key-with-sufficient-length");
      expect(name).toBe(
        ["credential", "rotate", "reconnect"].includes(operation)
          ? "lifty_crm_company_tools"
          : "lifty_crm_mapping_tools",
      );
      if (operation === "state")
        return { data: structuredClone(state), error: null };
      if (operation === "credential")
        return {
          data: {
            ...scope(),
            secret: credential.secret ?? JSON.stringify(grant),
            credential_version: "c".repeat(64),
          },
          error: null,
        };
      if (operation === "sources")
        return {
          data: { workspace_ref: ws, leads: [structuredClone(lead)] },
          error: null,
        };
      if (operation === "records")
        return {
          data: {
            ...scope(),
            run_ref: runRef,
            sync_state: "succeeded",
            leads: [structuredClone(lead)],
          },
          error: null,
        };
      if (operation === "status")
        return {
          data: saved ?? { state: "none", workspace_ref: ws },
          error: null,
        };
      if (operation === "sync") {
        saved = { ...p, run_ref: runRef, status: "queued", result: null };
        return { data: saved, error: null };
      }
      if (operation === "apply") {
        state.mapping_version = "b".repeat(64);
        return { data: { state: structuredClone(state) }, error: null };
      }
      return { data: null, error: { message: "unexpected_operation" } };
    },
  );
  const writes: string[] = [];
  const provider = vi.fn<typeof fetch>(async (url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer scoped-access",
    );
    if (String(url).includes("account-info"))
      return Response.json({ portalId: 52044090 });
    if (String(url).includes("private-apps/get/access-token-info"))
      return credential.privateAppScopes
        ? Response.json({ hubId: 52044090, appId: 1, userId: 2, scopes: credential.privateAppScopes })
        : new Response("unavailable", { status: 500 });
    const object = String(url).includes("/companies") ? "company" : "contact";
    if (String(url).includes("/batch/read"))
      return Response.json({
        results: [
          {
            id:
              object === "contact" ? lead.crm_contact_id : lead.crm_company_id,
            properties: records[object],
          },
        ],
      });
    if (init?.method === "POST") {
      const property = JSON.parse(String(init.body)) as Property;
      properties[object].push(property);
      writes.push(property.name);
      return Response.json(property);
    }
    if (new URL(String(url)).pathname.split("/").length > 5)
      return Response.json(
        properties[object].find(
          (p) => p.name === String(url).split("/").at(-1),
        ),
      );
    return Response.json({ results: properties[object] });
  });
  const enqueue = vi.fn(async () => {}),
    session = { userId: ws, client: { rpc } };
  const scope = () => ({
    workspace_ref: state.workspace_ref,
    integration_ref: state.integration_ref,
    portal_id: state.portal_id,
    mapping_version: state.mapping_version,
  });
  const settings = {
    serverKey: "capability-key-with-sufficient-length",
    fetch: provider,
    enqueue,
  };
  const run = (action: CrmMappingAction, input?: unknown) =>
    runCrmMapping(session, settings, action, input, { workspaceRef: ws });
  return {
    state,
    lead,
    properties,
    records,
    grant,
    credential,
    rpc,
    provider,
    writes,
    enqueue,
    session,
    settings,
    scope,
    run,
  };
}
