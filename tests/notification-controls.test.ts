import { describe, expect, it } from "vitest";
import { createCurrentClient as createApp } from "./current-client.js";
import { getNotificationConfig, setNotificationControls, setNotificationPreferences } from "../src/workspace-operations.js";
import { notificationsDatabase, workspaceRef, slackRef } from "./notification-fixtures.js";
import { callStageMcpTool } from "../src/mcp-stage-tools.js";

const global = { enabled: true, sources: ["email","linkedin"], channels: ["slack","email"], version: 1 };
const controls = { global, workspace: { enabled: false, sources: ["linkedin"], channels: ["email"], version: 1 } };
const headers = { authorization: "Bearer founder", "content-type": "application/json" };
function appFor(errors: Record<string, unknown> = {}, slack?: unknown) {
  const database = notificationsDatabase({ controls, errors, slack });
  const app = createApp({ authenticate: async () => ({ ok: true as const, session: { userId: "founder", client: database.client } }),
    getNotificationConfig,setNotificationControls,setNotificationPreferences });
  return { app, database, put: (path: string, body: unknown) => app.request(path,{ method:"PUT",headers,body:JSON.stringify(body) }) };
}

describe("notification owner controls", () => {
  it("forwards independent source and destination settings to the resolved workspace with compare-and-swap", async () => {
    const f=appFor();
    const response=await f.put("/v1/notifications/controls",{ enabled:false,sources:["linkedin"],channels:["email"],expected_version:0 });
    expect(response.status).toBe(200);
    expect((await response.json()).controls).toEqual(controls);
    expect(f.database.calls.find(c=>c.name==="set_controls")).toEqual({ schema:"notifications",name:"set_controls",
      args:{p_workspace_id:workspaceRef,p_expected_version:0,p_enabled:false,p_sources:["linkedin"],p_channels:["email"]} });
  });
  it("keeps complete destination choices atomic and permits email or Off without Slack", async () => {
    for (const channels of [[],["email"],["slack","email"]]) {
      const f=appFor({},channels.includes("slack") ? undefined : {status:"not_connected"});
      const response=await f.put("/v1/notifications/preferences",{notification_type:"sending_account.needs_reconnect",channels,slack_destination_ref:channels.includes("slack") ? slackRef : null});
      expect(response.status).toBe(200);
      expect(f.database.calls.find(c=>c.name==="set_preferences")?.args).toEqual({p_workspace_id:workspaceRef,p_type_code:"sending_account.needs_reconnect",p_channels:channels,p_slack_destination_id:channels.includes("slack") ? slackRef : null});
      expect(f.database.calls.some(c=>c.name==="set_subscription")).toBe(false);
    }
  });
  it("rejects foreign scope fields, duplicate filters and inconsistent Slack choices before writing", async () => {
    const f=appFor();
    for (const input of [
      {enabled:true,sources:["email"],channels:["email"],expected_version:0,workspace_ref:slackRef},
      {enabled:true,sources:["email","email"],channels:["email"],expected_version:0},
      {enabled:true,sources:["slack"],channels:["email"],expected_version:0},
    ]) expect((await f.put("/v1/notifications/controls",input)).status).toBe(400);
    expect((await f.put("/v1/notifications/preferences",{notification_type:"meeting.booked",channels:["slack"],slack_destination_ref:null})).status).toBe(400);
    expect(f.database.calls.some(c=>c.name==="set_controls"||c.name==="set_preferences")).toBe(false);
  });
  it("preserves stale-change and authorization refusals instead of reporting a saved preference", async () => {
    for (const [code,status] of [["40001",409],["42501",403]] as const) {
      const f=appFor({"notifications.set_controls":{code,message:"Refused"}});
      const response=await f.put("/v1/notifications/controls",{enabled:true,sources:["linkedin"],channels:["email"],expected_version:0});
      expect(response.status).toBe(status);
    }
  });
  it("exposes strict MCP capabilities without allowing a caller to replace their workspace through the body", async () => {
    for (const [name,body,operation] of [
      ["notifications_controls_set",{enabled:true,sources:["linkedin"],channels:["email"],expected_version:0},"controls"],
      ["notifications_preferences_set",{notification_type:"reply.requires_action",channels:[],slack_destination_ref:null},"preferences"],
    ] as const) {
      const calls: {route:string;body:unknown}[]=[];
      const result=await callStageMcpTool(name,{body},new Request("https://api.example.test/mcp"),async (route,init)=>{
        calls.push({route,body:JSON.parse(String(init.body))});return Response.json({saved:true});
      });
      expect(result.isError).not.toBe(true);
      expect(calls).toEqual([{route:"/v1/workspace/notifications",body:{operation,values:body}}]);
    }
  });
});
