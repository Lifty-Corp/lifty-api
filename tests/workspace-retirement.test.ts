import { describe,it,expect,vi } from "vitest";
import { createCurrentClient as createApp } from "./current-client.js";
import { createWorkspaceRetirement } from "../src/workspace-retirement.js";
const workspace="22222222-2222-4222-8222-222222222222",user="11111111-1111-4111-8111-111111111111",key="retirement-test-"+"x".repeat(40);
const body={confirm_slug:"senja",confirm_name:"Senja"};
const receipt={workspace_ref:workspace,slug:"senja",name:"Senja",state:"deleted",budget_preserved:true};
const path=`/v1/workspaces/${workspace}/retire`;
const post=(value:unknown=body)=>({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
function harness(data:unknown=receipt,error:unknown=null){
 const rpc=vi.fn(async()=>({data,error}));
 const app=createApp({authenticate:async()=>({ok:true,session:{userId:user,client:{rpc}}}),retireWorkspace:createWorkspaceRetirement(),log:()=>{}});
 return {app,rpc};
}
describe("workspace retirement API boundary",()=>{
 it("requires authenticated session before attempting retirement",async()=>{
  const operation=vi.fn();expect((await createApp({retireWorkspace:operation}).request(path,post())).status).toBe(401);expect(operation).not.toHaveBeenCalled();
 });
 it("binds exact path ID, name and slug to caller JWT without an email service key",async()=>{
  const h=harness();const response=await h.app.request(path,post());
  expect(response.status).toBe(200);expect(await response.json()).toEqual(receipt);expect(response.headers.get("cache-control")).toBe("no-store");
  expect(h.rpc).toHaveBeenCalledWith("retire_lifty_workspace",{p_payload:{workspace_ref:workspace,...body}});
 });
 it("rejects missing identity, body ID override and privileged options",async()=>{
  const h=harness();for(const value of [{},{confirm_slug:"senja"},{...body,workspace_ref:user},{...body,p_server_key:key},{...body,reset_budget:true}])expect((await h.app.request(path,post(value))).status).toBe(400);
  expect((await h.app.request("/v1/workspaces/not-a-uuid/retire",post())).status).toBe(400);expect(h.rpc).not.toHaveBeenCalled();
 });
 it.each(["workspace_forbidden","workspace_history_retained","workspace_identity_mismatch","workspace_cross_tenant_reference","workspace_retirement_blocked","workspace_linkedin_retention_required","workspace_email_disconnect_required","workspace_integration_disconnect_required","workspace_integration_revocation_pending"])("preserves SQL guard %s without exposing details",async message=>{
  const h=harness(null,{code:"PT409",message,details:"private-db-context"});const response=await h.app.request(path,post());expect(response.status).toBe(409);const text=await response.text();expect(text).toContain(message.toUpperCase());expect(text).not.toContain("private-db-context");expect(h.rpc).toHaveBeenCalledTimes(1);
 });
 it("explains common history and integration guards without a workspace category",async()=>{
  for(const [message,expected] of [["workspace_forbidden","workspace member or LIFT admin"],["workspace_history_retained","business history"],["workspace_integration_disconnect_required","every integration"]]){
   const response=await harness(null,{code:message==="workspace_forbidden"?"PT403":"PT409",message}).app.request(path,post());
   expect((await response.json()).error.message).toContain(expected);
  }
 });
 it("supports exact request replay without broadening the identity",async()=>{
  const h=harness();await h.app.request(path,post());await h.app.request(path,post());expect(h.rpc.mock.calls[0]).toEqual(h.rpc.mock.calls[1]);
 });
 it("fails closed on mismatched receipts, budget changes or unknown SQL errors",async()=>{
  for(const data of [{...receipt,workspace_ref:user},{...receipt,slug:"other"},{...receipt,name:"Other"},{...receipt,budget_preserved:false}])expect((await harness(data).app.request(path,post())).status).toBe(502);
  const response=await harness(null,{message:key,code:"XX000"}).app.request(path,post());expect(response.status).toBe(502);expect(await response.text()).not.toContain(key);
 });
});
