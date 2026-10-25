import { createHash } from "node:crypto";
import type { EmailSetup } from "./email-connect-setup.js";
import { pendingSubmitScript, renderLiftyPage } from "./lifty-brand.js";
import type { ConnectChannel } from "./connect-state.js";

// Lifty's connect page: the person answers the account declaration here,
// before the provider sign-in. The agent never asks or relays it.
const styles = `
  form{margin-top:24px}
  .panel:has(form[data-email]){max-width:600px}
  .providers{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .provider{display:flex;align-items:center;gap:12px;margin:0;padding:16px 12px;border:1px solid var(--line);border-radius:12px;cursor:pointer}
  .provider:has(input:checked){border-color:var(--lime);box-shadow:inset 0 0 0 1px var(--lime);background:hsl(99 34% 65% / .08)}
  .provider:has(input:focus-visible){outline:2px solid var(--lime);outline-offset:3px}
  .provider input{margin-left:auto}
  .provider small{display:block;font-size:12px;font-weight:400;color:var(--muted)}
  .provider-logo{display:grid;place-items:center;width:40px;height:40px;flex:none;background:white;border-radius:9px}
  .provider-logo svg{width:24px;height:24px}
  .setup h2{font-size:18px;line-height:1.3;margin:0;color:var(--ink)}
  .setup{padding:18px;border:1px solid var(--lime);border-radius:12px;background:hsl(99 34% 65% / .04)}
  .setup details{margin:12px 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px}
  .setup .approval{display:flex;align-items:flex-start;gap:10px;margin:16px 0 0;color:var(--ink)}
  .approval input{margin-top:3px}
  .setup .approval-note{font-size:12px;margin-bottom:0}
  .setup-placeholder{margin:0 0 24px;padding:16px;border:1px dashed var(--line);border-radius:12px;color:var(--muted);font-size:14px}
  .setup-placeholder strong{display:block}
  .connect-submit:disabled{cursor:not-allowed}
  @media(max-width:400px){.providers{grid-template-columns:1fr}}
  .setup{margin:16px 0;font-size:13px;color:var(--muted)}
  .setup summary{cursor:pointer;color:var(--ink)}
  .setup p,.setup ol{margin:10px 0}
  .setup ol{padding-left:20px}
  .setup button{font-size:13px;padding:7px 10px}
  .setup textarea{display:block;width:100%;min-height:125px;margin-top:10px;color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit}
  .setup code{overflow-wrap:anywhere}
  .setup .copy-status{display:block;min-height:1.5em}
  .provider-help{margin:12px 0}
  fieldset{border:0;margin:0 0 26px;padding:0;min-width:0}
  legend{padding:0;margin-bottom:12px;font-size:14px;font-weight:600}
  .choices{display:grid;gap:10px}
  .choice{display:flex;align-items:center;gap:14px;min-height:76px;margin:0;font-size:16px;font-weight:400;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:hsl(160 12% 6% / .6);cursor:pointer;transition:background-color 160ms,border-color 160ms}
  .choice:hover{border-color:hsl(140 16% 96% / .28)}
  .choice:has(input:checked){border-color:hsl(99 34% 65% / .75);background:hsl(99 34% 65% / .08);box-shadow:inset 0 0 0 1px hsl(99 34% 65% / .75)}
  .choice:has(input:focus-visible){outline:2px solid var(--lime);outline-offset:3px}
  .choice input:focus-visible{outline:none}
  .choice-copy{flex:1;min-width:0}
  .choice-name{display:block;font-weight:600;line-height:1.4}
  .choice-detail{display:block;font-size:13px;font-weight:400;color:var(--muted);margin-top:2px}
  button[type=submit]{margin-top:26px}
  form[aria-busy=true] fieldset{opacity:.55;pointer-events:none}
  @media(max-width:560px){.choice{padding:13px 12px;gap:12px}}
  @media(prefers-reduced-motion:reduce){.choice{transition:none}}
  @media(forced-colors:active){.choice:has(input:checked){outline:2px solid Highlight;outline-offset:-2px}}
`;
const page = (title: string, content: string, scripts = "") => renderLiftyPage({ title: `${title} · Lifty`, content, styles, scripts });
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const choice = (input: string, name: string, detail: string) =>
  `<label class="choice"><span class="choice-copy"><span class="choice-name">${name}</span><span class="choice-detail">${detail}</span></span>${input}</label>`;

// The person must choose: neither use is preselected (LIF-1603). An everyday
// mailbox is tested right after setup (LIF-1223); a dedicated sending mailbox
// needs verified warmup before campaigns send. Senders can change it later.
function emailDeclaration(): string {
  return `<fieldset><legend>3. How do you use this mailbox?</legend><div class="choices">${[
    choice(`<input type="radio" name="mailbox_use" value="habitual" aria-label="A mailbox I already use every day" required>`,
      "My everyday mailbox", "An address you already use on your company’s usual domain."),
    choice(`<input type="radio" name="mailbox_use" value="dedicated" aria-label="A dedicated sending mailbox" required>`,
      "A dedicated outreach mailbox", "A new or separate address for outreach. Needs 21 active days of warmup before sending."),
  ].join("")}</div></fieldset>`;
}
// Both confirmations are required before the sign-in.
function linkedinDeclaration(): string {
  return `<fieldset><legend>Confirm this LinkedIn account</legend><div class="choices">${[
    choice(`<input type="checkbox" name="habitual_personal_account" value="yes" aria-label="This is my own LinkedIn account that I use regularly" required>`,
      "This is my own LinkedIn account that I use regularly", "Lifty acts as you, from your habitual personal account."),
    choice(`<input type="checkbox" name="no_other_automation" value="yes" aria-label="No other automation tool uses this account" required>`,
      "No other automation tool uses this account", "Running two tools on one account puts it at risk."),
  ].join("")}</div></fieldset>`;
}

const helpScript = `
document.querySelectorAll('[data-copy]').forEach(function(button){
 button.hidden=false;
 button.addEventListener('click',async function(){
  var source=document.getElementById(button.dataset.copy),status=button.parentElement.querySelector('[role=status]');
  try{await navigator.clipboard.writeText(source.value||source.textContent);status.textContent='Copied'}
  catch(e){if(source.select)source.select();status.textContent='Select and copy the text below'}
 });
});
var form=document.querySelector('form[data-email]');
if(form){
 var submit=form.querySelector('button[type=submit]'),panels=Array.from(form.querySelectorAll('[data-provider-help]'));
 var placeholder=document.getElementById('approval-placeholder'),mailbox=document.getElementById('mailbox-step');
 function update(reset){
  var selected=form.querySelector('input[name=provider]:checked'),provider=selected&&selected.value;
  panels.forEach(function(panel){
   var active=panel.dataset.providerHelp===provider,approval=panel.querySelector('[name=admin_approval]');
   panel.hidden=!active;approval.disabled=!active;
   if(reset){approval.checked=false;panel.querySelectorAll('details').forEach(function(detail){detail.open=false})}
  });
  placeholder.hidden=!!provider;mailbox.hidden=!provider;
  submit.textContent=provider?'Connect with '+(provider==='google'?'Google':'Microsoft'):'Choose your provider';
  submit.disabled=!provider||!form.querySelector('[name=admin_approval]:enabled:checked');
 }
 form.querySelectorAll('[name=provider]').forEach(function(input){input.addEventListener('change',function(){update(true)})});
 form.querySelectorAll('[name=admin_approval]').forEach(function(input){input.addEventListener('change',function(){update(false)})});
 addEventListener('pageshow',function(){form.removeAttribute('aria-busy');update(false)});
 form.addEventListener('submit',function(event){
  if(form.hasAttribute('aria-busy')||submit.disabled){event.preventDefault();return}
  form.setAttribute('aria-busy','true');submit.disabled=true;submit.textContent='Opening sign-in…';
 });
 update(false);
}`;
export const CONNECT_HELP_SCRIPT_HASH = `sha256-${createHash("sha256").update(helpScript).digest("base64")}`;

function setupHelp(setup: EmailSetup): string {
  const google = setup.google;
  const googleInstructions = google
    ? `Please approve Lifty Workspace Pilot for my Google Workspace account. Open ${google.url}, choose Configure new app, then OAuth App Name or Client ID. Search for ${google.clientId}, select the app and the users who need access, then choose Trusted and finish. Let me know when it is approved so I can connect my own mailbox in Lifty.`
    : "Please approve the app shown on my Google consent screen in Google Admin > Security > API controls. Ask me for its OAuth client ID so you can confirm the exact app. Let me know when I can connect my own mailbox in Lifty.";
  const microsoftInstructions = `Please approve the app shown on my Microsoft sign-in screen for my Microsoft 365 account. ${setup.outlook ? `Open ${setup.outlook.url} to review its permissions.` : "In Microsoft Entra, open Enterprise apps and review the app and its requested permissions. If your organization enables approval requests, I can request approval from the sign-in screen."} Let me know when it is approved so I can connect my own mailbox in Lifty.`;
  const copy = (id: string, label: string, text: string) => `<div><button hidden type="button" data-copy="${id}">${label}</button><span class="copy-status" role="status"></span><textarea id="${id}" aria-label="Instructions for your administrator" readonly>${escape(text)}</textarea></div>`;
  const approval = (provider: string, label: string) => `<label class="approval"><input type="checkbox" name="admin_approval" value="${provider}" required disabled><span>${label}</span></label><p class="approval-note">This is your confirmation. Lifty cannot check your organization’s approval here.</p>`;
  return `<p id="approval-placeholder" class="setup-placeholder"><strong>2. Company approval comes first</strong>Choose your provider to see how your admin can approve Lifty.</p>
<section class="setup provider-help" data-provider-help="google" hidden aria-labelledby="google-approval-title"><h2 id="google-approval-title">2. Approve Lifty in Google Workspace</h2>
<p>${google ? 'Before connecting, your admin must add <strong>Lifty Workspace Pilot</strong> as a <strong>Trusted</strong> app for your account.' : 'Before connecting, confirm that your organization allows Lifty to access this mailbox.'} Already approved? Confirm below.</p>
<details><summary>I’m an admin — approve the app</summary>
<p><a href="${escape(google?.url ?? "https://admin.google.com/ac/owl")}" target="_blank" rel="noopener noreferrer">Open Google Admin ↗</a></p>
${google ? `<ol><li>Choose <strong>Configure new app</strong> and search by this client ID.</li><li>Select the app and users, choose <strong>Trusted</strong>, then finish.</li></ol><div><button hidden type="button" data-copy="google-client">Copy client ID</button><span class="copy-status" role="status"></span><code id="google-client">${escape(google.clientId)}</code></div>` : '<p>In API controls, approve the exact app and client ID shown for your connection.</p>'}
<p>Return here after saving. Google may take a few minutes to apply the change.</p></details>
<details><summary>I’m not an admin — request approval</summary><p>Copy these instructions and send them to your Google Workspace admin. Return after they approve access.</p>${copy("google-admin", "Copy request for my admin", googleInstructions)}</details>
${approval("google", "My administrator has approved Lifty for this Google account.")}</section>
<section class="setup provider-help" data-provider-help="outlook" hidden aria-labelledby="microsoft-approval-title"><h2 id="microsoft-approval-title">2. Confirm company approval</h2>
<p>Your organization must allow Lifty to connect this Microsoft account. If approval is already covered by your company’s policy, confirm below.</p>
<details><summary>I’m an admin — review access</summary><p><a href="${escape(setup.outlook?.url ?? "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AppAppsPreview")}" target="_blank" rel="noopener noreferrer">${setup.outlook ? "Open admin approval" : "Open Microsoft Entra apps"} ↗</a></p><p>Review the app and requested permissions. Microsoft may ask for admin consent during sign-in.</p></details>
<details><summary>I’m not an admin — request approval</summary><p>Send this request to your Microsoft 365 admin. If Microsoft offers <strong>Request approval</strong> during sign-in, you can use it there.</p>${copy("microsoft-admin", "Copy request for my admin", microsoftInstructions)}</details>
${approval("outlook", "My organization allows Lifty to connect this Microsoft account.")}</section>`;

}

const googleLogo = `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59A14.41 14.41 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.87 23.87 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
const microsoftLogo = `<svg viewBox="0 0 23 23" aria-hidden="true" focusable="false"><path fill="#f25022" d="M0 0h11v11H0z"/><path fill="#7fba00" d="M12 0h11v11H12z"/><path fill="#00a4ef" d="M0 12h11v11H0z"/><path fill="#ffb900" d="M12 12h11v11H12z"/></svg>`;
function providerChoice(): string {
  return `<fieldset><legend>1. Choose your email provider</legend><div class="providers">${([
    ["google", "Google", "Google Workspace", googleLogo], ["outlook", "Microsoft", "Microsoft 365", microsoftLogo],
  ] as const).map(([value, label, detail, logo]) => `<label class="provider"><span class="provider-logo">${logo}</span><span>${label}<small>${detail}</small></span><input type="radio" name="provider" value="${value}" aria-label="${label}" required></label>`).join("")}</div></fieldset>`;
}

export function renderConnectPage(channel: ConnectChannel, intent: string, senderName: string, setup: EmailSetup = {}): string {
  const email = channel === "email";
  const label = email ? "email account" : "LinkedIn account";
  return page(`Connect your ${label}`, `<h1>Connect ${escape(senderName)}'s ${label}</h1>
<p class="intro">${email ? "Approve Lifty for your company, then connect your mailbox." : "Connect the LinkedIn account Lifty should act from."}</p>
<form method="post" action="/connect/${channel}" data-pending="Opening sign-in…"${email ? ' data-email="true"' : ''}><input type="hidden" name="intent" value="${escape(intent)}">
${email ? `${providerChoice()}${setupHelp(setup)}<div id="mailbox-step" hidden>${emailDeclaration()}</div><button class="primary block connect-submit" type="submit" disabled>Choose your provider</button><noscript>Enable JavaScript to choose a provider, review company approval and connect.</noscript>` : `${linkedinDeclaration()}<button class="primary block" type="submit">Continue to sign-in</button>`}</form>
<p class="reassurance">Connecting does not start campaigns.${email ? " You may see unipile.com during sign-in; it handles the connection for Lifty." : ""}</p>`, email ? `<script>${helpScript}</script>` : pendingSubmitScript);
}

export function renderConnectMessagePage(title: string, message: string): string {
  return page(title, `<h1>${escape(title)}</h1><p class="intro">${escape(message)}</p>`);
}
