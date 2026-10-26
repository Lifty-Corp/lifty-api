#!/usr/bin/env node
// Opt-in fresh-model evaluation. Only an isolated fixture API is reachable by
// Lifty: dummy credentials, GET-only transport, no production state or providers.
// Usage: node scripts/evaluate-workspace-resumption.mjs /absolute/cli/repo [scenario]
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "../dist/app.js";
import { PublicError } from "../dist/errors.js";

if (!process.argv[2]) throw Error("Supply the absolute CLI source checkout");
const cliRoot = path.resolve(process.argv[2]);
const scenario = process.argv[3] ?? "saved";
if (!["saved", "confirmed", "retry"].includes(scenario)) throw Error("Unknown scenario");
const root = await realpath(await mkdtemp(path.join(tmpdir(), "lifty-fresh-session-")));
const project = path.join(root, "project"), authHome = path.join(root, "auth");
await mkdir(project); await mkdir(authHome); await mkdir(path.join(authHome, ".lifty"), { mode: 0o700 });
const id = "22222222-2222-4222-8222-222222222222", ref = "33333333-3333-4333-8333-333333333333", version = `sha256:${"a".repeat(64)}`;
const workspace = { state: "ready_for_connections", workspace: { workspace_ref: id, name: "lifty-gtm" }, next_action: null };
const profile = {version:1,updated_at:"2026-10-01T18:00:00Z",name:"lifty-gtm",website_url:{text:"https://liftygtm.com/",provenance:scenario === "confirmed" ? "confirmed" : "inferred",...(scenario === "confirmed" ? {} : {source:"public_research"})},one_liner:null,description:null,value_proposition:{text:"Less manual research",provenance:"confirmed"},offerings:[{text:"Prospect research",provenance:"confirmed"}],problems_solved:[{text:"Manual research takes time",provenance:"confirmed"}],confirmation:{complete:true,missing:[]}};
const lane = {id:ref,name:"Founders",personas:[{id:ref,name:"Founder",titles:["Founder"],persona_type:null}],seniorities:null,person_locations:null,company:{locations:null,industries:null,industry_codes:null,excluded_industry_codes:null,domains:null,employees:{min:1,max:200},keywords:null}};
const businessReads = {
  "business.get":{workspace:{workspace_ref:id,name:profile.name,state:workspace.state},profile},
  "targeting.get":{workspace_ref:id,targeting:{version:1,updated_at:profile.updated_at,lanes:[lane]}},
  "research-criteria.get":{workspace_ref:id,criteria:{version:1,updated_at:profile.updated_at,text:"Evidence-based criteria. ".repeat(20),input_contract:null,qualification_policy:"person_first",hand_tuned:false,source_versions:{profile_version:1,base_version:"fixture-base"}}},
  "commercial-voice.get":{workspace_ref:id,voice:{version:0,updated_at:profile.updated_at,tone:null,rules:[]}},
  "setup.status":{workspace_ref:id,state:"none"},
};
const campaign = { workspace_ref: id, state: "paused", outreach_enabled: false, version_ref: ref, digest: "a".repeat(64),
  configuration: { name: "Lifty founder-led outbound — email", audience: { policy: "qualified_ab_v1", lead_ids: null, includes_future_leads: true }, linkedin: null,
    email: { connection_ref: ref, sender: "juan@liftleadershipgroup.com", steps: ["Prospecting", "Who owns prospecting?", "Check fit", "Keep control", "Leave it here?"].map(subject => ({ subject, text: "Hi {{first_name}}, this is saved approved copy for {{company_name}}. Juan" })), delays_days: [0,3,4,4,4] },
    email_entry: "direct", not_before: null, personalization_fields: ["first_name", "company_name"], stop_on_reply: true, graph: {} },
  continuing_versions: [], blocked_leads: [], eligible_count: 18, progress: { enrolled: 0, blocked: 18, completed: 0 }, previews: [], blockers: [],
};
let emailReads = 0;
const app = createApp({ authenticate: async req => req.headers.get("authorization") === "Bearer fixture-session" ? { ok: true, session: { userId: "fixture", client: {} } } : { ok: false, reason: "invalid_session" },
  getWorkspace: async () => workspace,
  listMemberWorkspaces:async()=>({workspaces:[{workspace_ref:id,slug:"lifty-gtm",name:profile.name,active:true,founder_default:true,self_service:true}]}),
  businessOperation:async(_session,key,selected)=>{if(!key.endsWith(".get")&&key!=="setup.status")throw Error("fixture forbids writes");if(selected!==id)throw Error("fixture requires workspace scope");return businessReads[key];},
  getRunStatus:async()=>({state:"none"}),
  getHubspotConnection:async()=>({provider:"hubspot",status:"not_connected"}),
  getCrmSyncStatus:async()=>({state:"none"}),
  getEmailConnection: async () => {
    if (scenario === "retry" && emailReads++ === 0) throw new PublicError({ status: 502, code: "EMAIL_UNAVAILABLE", message: "Fixture transient failure" });
    return { provider: "unipile", channel: "email", workspace_ref: id, status: "connected", email: "juan@liftleadershipgroup.com", mailbox_use: "personal", daily_limit: 10, warmup_required: false, sending_enabled: false, connection_ref: ref, intent_ref: null, failure_code: null };
  },
  getLinkedinConnection: async () => ({ provider: "unipile", channel: "linkedin", workspace_ref: id, status: "not_connected" }),
  workspaceCampaign: async (_session, input) => { if (!["status", "preview"].includes(input.operation)) throw Error("fixture forbids writes"); return campaign; }, log: () => {},
});
const calls = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture.test");
  calls.push({ method: req.method, path: url.pathname, query: url.search });
  await writeFile(path.join(root, "requests.json"), JSON.stringify(calls, null, 2));
  if (req.method !== "GET") { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "FIXTURE_WRITE_FORBIDDEN", message: "Read-only evaluation." } })); return; }
  if (url.pathname === "/auth/v1/user") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: ref, email: "juan@liftleadershipgroup.com" })); return; }
  try {
    const result = await app.request(url.pathname + url.search, { headers: req.headers });
    res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text());
  } catch { res.writeHead(500); res.end("Fixture request failed"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await writeFile(path.join(authHome, ".lifty/credentials.json"), JSON.stringify({ schema_version: 1, supabase_url: origin, user_email: "juan@liftleadershipgroup.com", access_token: "fixture-session", refresh_token: "unused-fixture", expires_at: 9999999999 }), { mode: 0o600 });
const packageRoot = cliRoot;
const { createLifty } = await import(pathToFileURL(path.join(packageRoot, "src/core.mjs")));
const installer = createLifty({ bundleDir: path.join(packageRoot, "bundle"), packageVersion: JSON.parse(await readFile(path.join(packageRoot, "package.json"))).version,
  recoveryRunnerSource: await readFile(path.join(packageRoot, "dist/cli.js"), "utf8"), output: () => {},
  facts: { nodeVersion: process.versions.node, platform: process.platform, cwd: project, homeDir: authHome, env: {}, isTTY: false, pathEnv: "" } });
await installer.run(["init", "--agent", "codex", "--project-dir", project]);
await writeFile(path.join(project, "AGENTS.md"), "Use the installed Lifty onboarding skill at .agents/skills/lifty-onboarding/SKILL.md for Lifty work. This is a fresh founder session: do not use other project files, developer repositories, stored conversation history, or external tools. Use the installed launcher for workspace reads. The founder has not authorized any mutation.\n");
const prompt = scenario === "saved" ? "How should we continue with outreach? I think we should include our company website."
  : scenario === "confirmed" ? "What sender, website and campaign do we have configured?"
  : "Do I need to connect email to continue with outreach?";
const env = { ...process.env, LIFTY_AUTH_HOME: authHome, LIFTY_API_URL: origin, LIFTY_SUPABASE_URL: origin, LIFTY_SUPABASE_PUBLISHABLE_KEY: "fixture-publishable-key-not-secret", LIFTY_NO_BROWSER: "1" };
console.log(JSON.stringify({ scenario, root, project }));
try {
  const child = spawn("codex", ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-c", 'web_search="disabled"', "-C", project, "--json", "-o", path.join(root, "answer.md"), prompt], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let transcript = "", errors = "";
  child.stdout.on("data", chunk => { transcript += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
  const code = await new Promise(resolve => child.on("exit", resolve)); clearTimeout(timer);
  await writeFile(path.join(root, "transcript.jsonl"), transcript); await writeFile(path.join(root, "stderr.log"), errors);
  if (code !== 0) throw Error(`Fresh-session process failed (${code}); inspect ${root}`);
  const answer = await readFile(path.join(root, "answer.md"), "utf8");
  const pass = calls.some(c => c.path === "/v1/workspace/summary") && calls.every(c => c.method === "GET")
    && (scenario !== "saved" || calls.some(c => c.path === "/v1/workspace/business"))
    && (scenario !== "retry" || emailReads > 1);
  console.log(JSON.stringify({ scenario, pass, requests: calls, answer, root }, null, 2));
  if (!pass) process.exitCode = 1;
} finally { server.closeAllConnections(); server.close(); }
