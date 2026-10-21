import { describe, it, expect, vi } from "vitest";
import { createCurrentClient as createApp, type AuthSession } from "./current-client.js";
import { createEmailCampaignOperations } from "../src/email-campaign.js";
import { EmailCampaignRequest } from "../src/email-campaign-contracts.js";

const workspace = "22222222-2222-4222-8222-222222222222";
const reference = "11111111-1111-4111-8111-111111111111";
const secret = "test-campaign-server-key-" + "x".repeat(40);
const digest = "a".repeat(64);
const preview = {
  campaign_ref: reference, workspace_ref: workspace, state: "draft", version_ref: reference, digest,
  content: { name: "Test campaign", connection_ref: reference, provider: "unipile", sender_email: "sender@example.test", lead_ref: reference, recipient_email: "recipient@example.test", start_at: "2026-09-14T21:00:00Z", daily_limit: 10, stop_on_reply: true, steps: [{ subject: "Test", text: "Test only", delay_minutes: 0 }] },
  approved: false, mailbox_use: "personal", blockers: ["email_placement_required"], execution_ref: null, execution_state: null, steps: [], replies: [],
};
const request = (operation = "preview", extra = {}) => ({ operation, payload: { workspace: "senja", campaign_ref: reference, ...extra } });
const session = (rpc: unknown): AuthSession => ({ userId: reference, client: { rpc } });
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
function harness(response: {data:unknown;error:unknown} = {data:preview,error:null}) {
  const rpc = vi.fn(async () => response);
  const authenticated = session(rpc);
  const operation = createEmailCampaignOperations(secret);
  const app = createApp({ authenticate: async () => ({ ok: true, session: authenticated }), emailCampaign: operation, log: () => {} });
  return { rpc, operation, app, authenticated };
}
describe("campaign authenticated narrow capability", () => {
  it("authenticates before parsing or invoking the campaign operation", async () => {
    const operation = vi.fn();
    const app = createApp({ emailCampaign: operation });
    expect((await app.request("/v1/email/campaign", post(request()))).status).toBe(401);
    expect(operation).not.toHaveBeenCalled();
  });
  it("forwards the explicit workspace only through the caller JWT client with dedicated server key", async () => {
    const h = harness();
    const response = await h.app.request("/v1/email/campaign", post(request()));
    expect(response.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("lifty_email_campaign", { p_server_key: secret, p_operation: "preview", p_payload: { workspace: "senja", campaign_ref: reference } });
    expect(await response.text()).not.toContain(secret);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["email_workspace_forbidden", "email_campaign_forbidden", "email_target_forbidden", "email_connection_forbidden"])("preserves database tenant isolation: %s", async message => {
    const h = harness({data:null,error:{code:"PT403",message}});
    const response = await h.app.request("/v1/email/campaign", post(request()));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe(message.toUpperCase());
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it("rejects secret/server/tenant overrides, missing workspace and missing explicit approval digest before RPC", async () => {
    const h = harness();
    for (const body of [request("approve"), request("activate", { digest: "bad" }), request("preview", {workspace:undefined}), request("preview",{workspace_id:workspace}), {...request(),p_server_key:secret}, {...request(),operation:"evidence"}]) {
      expect((await h.app.request("/v1/email/campaign", post(body))).status).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("strips unapproved internal fields from successful results", async () => {
    const h = harness({data:{...preview,server_key:secret,content:{...preview.content,provider_access_token:secret},replies:[{message_ref:reference,received_at:"2026-09-14T22:00:00Z",provider_message_id:"provider-private",event_ref:reference}]},error:null});
    const response = await h.app.request("/v1/email/campaign", post(request()));
    const text = await response.text();
    expect(response.status).toBe(200); expect(text).not.toContain(secret); expect(text).not.toContain("provider-private"); expect(JSON.parse(text).content).not.toHaveProperty("provider");
  });
  it("masks named vendors in historical blockers while retaining exact recovery refs", async () => {
    const h = harness({ data: { ...preview, blockers: ["email_smartlead_unavailable"] }, error: null });
    const response = await h.app.request("/v1/email/campaign", post(request()));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({ campaign_ref: reference, version_ref: preview.version_ref, digest, blockers: ["email_delivery_unavailable"] });
    expect(JSON.stringify(data)).not.toMatch(/smartlead|unipile/i);
  });
  it("fails closed on invalid cap and does not echo provider/database failures", async () => {
    for (const response of [{data:{...preview,content:{...preview.content,daily_limit:11}},error:null},{data:null,error:{code:"XX000",message:secret}}]) {
      const h = harness(response); const result = await h.app.request("/v1/email/campaign", post(request()));
      expect(result.status).toBe(502); expect(await result.text()).not.toContain(secret);
    }
  });
  it("does not retry ambiguous mutations, and preserves digest on repeated requests", async () => {
    const h = harness();
    const body = request("cancel",{digest,confirm_cancel:true});
    await h.app.request("/v1/email/campaign",post(body)); await h.app.request("/v1/email/campaign",post(body));
    expect(h.rpc.mock.calls[0]).toEqual(h.rpc.mock.calls[1]);
    const failing = vi.fn(async () => {throw new Error(secret);});
    await expect(createEmailCampaignOperations(secret)(session(failing),EmailCampaignRequest.parse(body))).rejects.toMatchObject({code:"EMAIL_CAMPAIGN_UNAVAILABLE"});
    expect(failing).toHaveBeenCalledTimes(1);
  });
  it("reports warmup, placement, suppression and stale approval without activating a connection", async () => {
    for (const message of ["email_warmup_required","email_placement_required","email_target_suppressed","email_approval_stale"]) {
      const h = harness({data:null,error:{code:"PT409",message}});
      expect((await h.app.request("/v1/email/campaign",post(request("placement",{digest})))).status).toBe(409);
      expect(h.rpc).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects the retired provider selector and unsafe steps", async () => {
    const h = harness();
    expect((await h.app.request("/v1/email/campaign",post({operation:"provider",payload:{workspace:"senja",channel:"email",provider:"heyreach"}}))).status).toBe(400);
    const payload = { workspace:"senja",lead_ref:reference,connection_ref:reference,name:"Test",start_at:"2026-09-14T21:00:00Z",steps:preview.content.steps };
    for (const steps of [[{subject:"Header\r\nBcc: other",text:"Test",delay_minutes:0}],[...preview.content.steps,{subject:"Followup",text:"Test",delay_minutes:0}]]) {
      expect((await h.app.request("/v1/email/campaign",post({operation:"prepare",payload:{...payload,steps}}))).status).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("exposes the authenticated public contract without secrets", async () => {
    const doc = await (await createApp().request("/openapi.json")).json();
    expect(doc.paths["/v1/email/campaign"].post.operationId).toBe("emailCampaign");
    expect(JSON.stringify(doc)).not.toContain("p_server_key");
  });
});

describe("placement request lifecycle",()=>{
  const placement={workspace_ref:workspace,campaign_ref:reference,digest,placement_ref:reference,status:"awaiting_confirmation",passed:null,seed_count:4};
  it("uses separate narrow placement RPC and never records passed evidence or triggers sends",async()=>{
    const h=harness({data:placement,error:null});
    const response=await h.app.request("/v1/email/campaign",post(request("placement",{digest})));
    expect(response.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("lifty_email_placement",{p_server_key:secret,p_operation:"start",p_payload:{workspace:"senja",campaign_ref:reference,digest}});
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual(placement);
  });
  it("reads same placement through authenticated GET without starting a test",async()=>{
    const h=harness({data:placement,error:null});
    const url=`/v1/email/campaign/placement?workspace=senja&campaign_ref=${reference}&digest=${digest}`;
    expect((await createApp().request(url)).status).toBe(401);
    expect((await h.app.request(url)).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("lifty_email_placement",{p_server_key:secret,p_operation:"status",p_payload:{workspace:"senja",campaign_ref:reference,digest}});
  });
  it("fails closed when placement RPC is unavailable or its response references another campaign",async()=>{
    for(const response of [{data:null,error:{code:"PGRST202",message:"internal-schema-secret"}},{data:{...placement,campaign_ref:workspace},error:null}]){
      const h=harness(response);const result=await h.app.request("/v1/email/campaign",post(request("placement",{digest})));
      expect(result.status).toBe(502);expect(await result.text()).not.toContain("internal-schema-secret");expect(h.rpc).toHaveBeenCalledTimes(1);
    }
  });
  it("preserves exact copy whitespace in preview, keeping displayed content bound to its digest",async()=>{
    const content={...preview.content,steps:[{subject:" Test ",text:"\nTest only\n",delay_minutes:0}]};
    const h=harness({data:{...preview,content},error:null});
    const result=await (await h.app.request("/v1/email/campaign",post(request()))).json();
    expect(result.content.steps).toEqual(content.steps);
  });
});

describe("explicit placement seed confirmation",()=>{
  const placement={workspace_ref:workspace,campaign_ref:reference,digest,placement_ref:reference,status:"ready",passed:null,seed_count:4,test_ref:"test_1"};
  const payload={workspace:"senja",campaign_ref:reference,digest,placement_ref:reference,test_ref:"test_1",seed_count:4,confirm_seeds:true};
  it("requires exact references, count and explicit true then passes only to confirm RPC",async()=>{
    const h=harness({data:placement,error:null});
    for(const missing of ["placement_ref","test_ref","seed_count","confirm_seeds"]) {
      const incomplete={...payload};delete incomplete[missing as keyof typeof incomplete];
      expect((await h.app.request("/v1/email/campaign",post({operation:"placement-confirm",payload:incomplete}))).status).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled();
    const result=await h.app.request("/v1/email/campaign",post({operation:"placement-confirm",payload}));
    expect(result.status).toBe(200);expect(await result.json()).toEqual(placement);
    expect(h.rpc).toHaveBeenCalledWith("lifty_email_placement",{p_server_key:secret,p_operation:"confirm",p_payload:payload});
  });
  it("rejects false confirmation or more than ten seeds before making a call",async()=>{
    const h=harness();for(const override of [{confirm_seeds:false},{seed_count:11},{seed_count:0}])expect((await h.app.request("/v1/email/campaign",post({operation:"placement-confirm",payload:{...payload,...override}}))).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("preserves public test reference and drops unrecognized provider reason text",async()=>{
    const h=harness({data:{...placement,reason:"provider-private-content"},error:null});
    const response=await h.app.request("/v1/email/campaign",post(request("placement",{digest})));
    const result=await response.json();expect(result.test_ref).toBe("test_1");expect(result.reason).toBeUndefined();
  });
});

describe("placement SQL error contract",()=>{
  it.each(["email_placement_campaign_stale","email_mailbox_unbound","email_placement_not_started","email_placement_confirmation_mismatch","email_placement_not_confirmable"])("renders actionable %s without database details",async message=>{
    const h=harness({data:null,error:{code:"PT409",message,details:"private database context"}});
    const result=await h.app.request("/v1/email/campaign",post(request("placement",{digest})));
    expect(result.status).toBe(409);const body=await result.json();expect(body.error.code).toBe(message.toUpperCase());expect(JSON.stringify(body)).not.toContain("private database context");expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("member-only exact placement seed preview",()=>{
  const seedPreview={workspace_ref:workspace,campaign_ref:reference,digest,placement_ref:reference,status:"awaiting_confirmation",passed:null,seed_count:2,test_ref:"99",seed_emails:["seed@example.test","detection@example.test"]};
  const url=`/v1/email/campaign/placement/preview?workspace=${workspace}&campaign_ref=${reference}&digest=${digest}`;
  it("authenticates before accessing seed recipients",async()=>{
    const emailCampaign=vi.fn();
    const response=await createApp({emailCampaign}).request(url);
    expect(response.status).toBe(401);expect(emailCampaign).not.toHaveBeenCalled();
  });
  it("returns exact stored recipients including detection through the caller JWT read-only capability",async()=>{
    const h=harness({data:{...seedPreview,tracking_code:"private-provider-code",provider_body:{secret}},error:null});
    const response=await h.app.request(url);
    expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(seedPreview);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("lifty_email_placement_preview",{p_server_key:secret,p_payload:{workspace,campaign_ref:reference,digest}});
  });
  it("supports the operation through POST without falling through to status or losing the list",async()=>{
    const h=harness({data:seedPreview,error:null});
    const response=await h.app.request("/v1/email/campaign",post(request("placement-preview",{digest})));
    expect(response.status).toBe(200);expect(await response.json()).toEqual(seedPreview);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("lifty_email_placement_preview",{p_server_key:secret,p_payload:{workspace:"senja",campaign_ref:reference,digest}});
  });
  it("preserves null before an authenticated provider test exists without fabricating recipients",async()=>{
    const pending={...seedPreview,status:"queued",seed_emails:null,seed_count:null,test_ref:null};
    const h=harness({data:pending,error:null});
    expect(await (await h.app.request(url)).json()).toEqual(pending);
  });
  it.each([
    {seed_emails:undefined}, {seed_emails:[]}, {seed_emails:["bad address"]},
    {seed_emails:["seed@example.test","SEED@example.test"]}, {seed_count:3},
    {test_ref:null}, {seed_emails:null}, {seed_emails:null,test_ref:null},
    {campaign_ref:workspace}, {workspace_ref:reference}, {digest:"b".repeat(64)},
  ])("fails closed on incomplete or foreign stored seed snapshots: %j",async(override)=>{
    const h=harness({data:{...seedPreview,...override},error:null});
    const response=await h.app.request(url);
    expect(response.status).toBe(502);expect(await response.text()).not.toContain("seed@example.test");
  });
  it("still exposes a blocked larger batch for informed review without weakening the ten-recipient confirmation cap",async()=>{
    const large={...seedPreview,status:"blocked",reason:"seed_batch_exceeds_daily_limit",seed_count:11,seed_emails:Array.from({length:11},(_,i)=>`seed${i}@example.test`)};
    const h=harness({data:large,error:null});
    expect(await (await h.app.request(url)).json()).toEqual(large);
    const confirmation={workspace,campaign_ref:reference,digest,placement_ref:reference,test_ref:"99",seed_count:11,confirm_seeds:true};
    expect((await h.app.request("/v1/email/campaign",post({operation:"placement-confirm",payload:confirmation}))).status).toBe(400);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it.each(["email_workspace_forbidden","email_placement_forbidden","email_placement_campaign_stale"])("honors SQL isolation and current campaign validation: %s",async(message)=>{
    const h=harness({data:null,error:{code:message.endsWith("stale")?"PT409":"PT403",message}});
    const response=await h.app.request(url);
    expect(response.status).toBe(message.endsWith("stale")?409:403);expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it("keeps old placement status responses unchanged even if a database result contains internal seed data",async()=>{
    const h=harness({data:seedPreview,error:null});
    const response=await h.app.request(url.replace("/preview?","?"));
    const {seed_emails:_,...oldStatus}=seedPreview;
    expect(await response.json()).toEqual(oldStatus);
    expect(h.rpc).toHaveBeenCalledWith("lifty_email_placement",expect.objectContaining({p_operation:"status"}));
  });
  it("does not retry reads or echo unknown provider/database bodies",async()=>{
    const h=harness({data:null,error:{message:"private-provider-code",code:"XX000"}});
    const response=await h.app.request(url);
    expect(response.status).toBe(502);expect(await response.text()).not.toContain("private-provider-code");expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it("documents a separate authenticated preview response",async()=>{
    const doc=await (await createApp().request("/openapi.json")).json();
    expect(doc.paths["/v1/email/campaign/placement/preview"].get.operationId).toBe("previewEmailPlacement");
    expect(JSON.stringify(doc.paths["/v1/email/campaign/placement/preview"])).toContain("seed_emails");
  });
});

describe("historical campaign policy snapshots",()=>{
  const email_policy={version:"lifty.personal-beta.v1",revision:reference,placement_required:false,habitual_only:true};
  it("preserves exact policy digest content and never reports invented placement",async()=>{
    const h=harness({data:{...preview,email_policy,content:{...preview.content,email_policy},placement_required:false,placement_performed:false,blockers:[]},error:null});
    const res=await h.app.request("/v1/email/campaign",post(request()));
    expect(res.status).toBe(200);expect(await res.json()).toMatchObject({email_policy,content:{email_policy},placement_required:false,placement_performed:false});
  });
  it.each(["email_policy_changed"])("exposes actionable blocker %s",async message=>{
    const h=harness({data:null,error:{code:"PT409",message}});const res=await h.app.request("/v1/email/campaign",post(request()));
    expect(res.status).toBe(409);expect((await res.json()).error.code).toBe(message.toUpperCase());
  });
});

describe("durable recovery and cancellation",()=>{
 const recovery={state:"blocked",reason:"send_unconfirmed",checked_at:null,cancel_allowed:true};
 const recoveryPreview={...preview,state:"active",execution_ref:reference,execution_state:"active",recovery,steps:[{step_ref:reference,position:1,state:"pending",due_at:"2026-09-15T12:00:00Z",intent_ref:reference,accepted_at:null,delivery_state:"ambiguous",delivery_status:"unconfirmed"}]};
 const canceled={...recoveryPreview,state:"canceled",execution_state:"canceled",recovery:{...recovery,state:"canceled",cancel_allowed:false},steps:recoveryPreview.steps.map(step=>({...step,state:"canceled"}))};
 it("returns recovery and actual uncertain delivery state without private receipt data",async()=>{
  const h=harness({data:{...recoveryPreview,private_receipt:"SECRET"},error:null});const res=await h.app.request("/v1/email/campaign",post(request("status")));
  expect(res.status).toBe(200);const data=await res.json();expect(data.recovery).toEqual(recovery);expect(data.steps[0].delivery_status).toBe("unconfirmed");expect(JSON.stringify(data)).not.toContain("SECRET");
 });
 it("cancel is exact, explicitly confirmed and uses authenticated narrow recovery RPC",async()=>{
  const h=harness({data:canceled,error:null});const req=request("cancel",{digest,confirm_cancel:true});
  const res=await h.app.request("/v1/email/campaign",post(req));expect(res.status).toBe(200);
  expect(h.rpc).toHaveBeenCalledWith("lifty_email_campaign_recovery",{p_server_key:secret,p_operation:"cancel",p_payload:req.payload});
  expect((await res.json()).state).toBe("canceled");
 });
 it.each(["draft", "approved"])("cancels a %s campaign without inventing an execution", async state => {
  const data = {...preview, state, approved:state === "approved", recovery:{state:"ready", reason:null, checked_at:null, cancel_allowed:true}};
  const h = harness({data,error:null});
  const status = await h.app.request("/v1/email/campaign",post(request("status")));
  expect(status.status).toBe(200); expect((await status.json()).recovery.cancel_allowed).toBe(true);
  data.state = "canceled"; data.recovery.state = "canceled"; data.recovery.cancel_allowed = false;
  const req = request("cancel",{digest,confirm_cancel:true});
  const res = await h.app.request("/v1/email/campaign",post(req));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({state:"canceled",execution_ref:null,execution_state:null,steps:[],recovery:{state:"canceled",cancel_allowed:false}});
  expect(h.rpc).toHaveBeenLastCalledWith("lifty_email_campaign_recovery",{p_server_key:secret,p_operation:"cancel",p_payload:req.payload});
  expect(h.rpc).toHaveBeenCalledTimes(2);
 });
 it.each([
  {...canceled,execution_ref:null},
  {...canceled,execution_state:null,steps:[]},
  {...canceled,execution_ref:null,execution_state:null},
  {...canceled,execution_ref:undefined,execution_state:null,steps:[]},
  {...canceled,execution_ref:"invalid",steps:[]},
 ])("rejects inconsistent canceled execution shape %#",async data=>{
  const h=harness({data,error:null});
  const res=await h.app.request("/v1/email/campaign",post(request("cancel",{digest,confirm_cancel:true})));
  expect(res.status).toBe(502);expect(h.rpc).toHaveBeenCalledTimes(1);
 });
 it.each([{digest},{confirm_cancel:true},{digest,confirm_cancel:false},{digest,confirm_cancel:true,retry_send:true}])("rejects incomplete or privileged cancellation %j",async fields=>{
  const h=harness({data:canceled,error:null});const res=await h.app.request("/v1/email/campaign",post(request("cancel",fields)));expect(res.status).toBe(400);expect(h.rpc).not.toHaveBeenCalled();
 });
 it.each([recoveryPreview,{...canceled,recovery:undefined},{...canceled,steps:recoveryPreview.steps},{...canceled,campaign_ref:workspace}])("never claims cancellation from an unconfirmed or foreign result",async data=>{
  const h=harness({data,error:null});const res=await h.app.request("/v1/email/campaign",post(request("cancel",{digest,confirm_cancel:true})));expect(res.status).toBe(502);
 });
 it("stale cancellation preserves explicit digest blocker",async()=>{
  const h=harness({data:null,error:{code:"PT409",message:"email_approval_stale"}});const res=await h.app.request("/v1/email/campaign",post(request("cancel",{digest,confirm_cancel:true})));expect(res.status).toBe(409);expect((await res.json()).error.code).toBe("EMAIL_APPROVAL_STALE");expect(h.rpc).toHaveBeenCalledTimes(1);
 });
});


describe("physical mailbox identity blocker contract",()=>{
  it.each(["placement"])("preserves safe409 for %s without exposing principal details",async operation=>{
    const privateId="private-mailbox-principal-fixture";
    const h=harness({data:null,error:{code:"PT409",message:"email_principal_unavailable",details:privateId,hint:"provider-proof-private"}});
    const req=request(operation,{digest});
    const res=await h.app.request("/v1/email/campaign",post(req));
    expect(res.status).toBe(409);
    const data=await res.json();
    expect(data.error).toEqual({code:"EMAIL_PRINCIPAL_UNAVAILABLE",message:"The sending mailbox identity could not be verified. Sending is blocked."});
    expect(JSON.stringify(data)).not.toContain(privateId);expect(JSON.stringify(data)).not.toContain("provider-proof-private");
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(operation==="placement"?"lifty_email_placement":"lifty_email_campaign",{p_server_key:secret,p_operation:operation==="placement"?"start":operation,p_payload:req.payload});
  });
  it.each([null,"send_unconfirmed","accepted_unlinked","connection_unavailable","reply_read_incomplete"])("keeps preview blocker separate from recovery reason %s",async reason=>{
    const recovery={state:reason===null?"ready":"blocked",reason,checked_at:null,cancel_allowed:true};
    const h=harness({data:{...preview,blockers:["email_principal_unavailable"],recovery,principal_id:"private-principal-fixture"},error:null});
    const res=await h.app.request("/v1/email/campaign",post(request("preview")));
    expect(res.status).toBe(200);const data=await res.json();
    expect(data.blockers).toEqual(["email_principal_unavailable"]);expect(data.recovery).toEqual(recovery);
    expect(JSON.stringify(data)).not.toContain("private-principal-fixture");
  });
  it("does not admit the identity blocker as a new recovery reason",async()=>{
    const h=harness({data:{...preview,recovery:{state:"blocked",reason:"email_principal_unavailable",checked_at:null,cancel_allowed:true}},error:null});
    expect((await h.app.request("/v1/email/campaign",post(request("status")))).status).toBe(502);
  });
  it("preserves existing sender identity mismatch behavior",async()=>{
    const h=harness({data:null,error:{code:"PT409",message:"email_sender_identity_mismatch"}});
    const res=await h.app.request("/v1/email/campaign",post(request("preview")));
    expect(res.status).toBe(409);expect((await res.json()).error).toEqual({code:"EMAIL_SENDER_IDENTITY_MISMATCH",message:"The connected account no longer matches the approved sender."});
  });
});
