import { createHash } from "node:crypto";
import type { EmailSetup } from "./email-connect-setup.js";
import { pendingSubmitScript, renderLiftyPage } from "./lifty-brand.js";
import type { ConnectChannel } from "./connect-state.js";

// Lifty's connect page: the person answers the account declaration here,
// before the provider sign-in. The agent never asks or relays it.
const styles = `
  form{margin-top:24px}
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

  /* Email: a light, quiet surface. The approval steps are the one guided element. */
  body:has(form[data-email]){color-scheme:light;--paper:#f2f4f1;--card:#fff;--field:#fff;--ink:#17201a;--muted:#545e57;--subtle:#69736c;--line:#e3e8e4;--line-strong:#cdd5cf;--tint:#f7f9f7;--lime:#2f6a3b;--lime-hover:#255630;--selected:hsl(132 38% 30% / .05);background:radial-gradient(ellipse 70% 45% at 50% -8%,hsl(99 34% 65% / .22),transparent 70%),var(--paper);color:var(--ink)}
  body:has(form[data-email])::before{display:none}
  .panel:has(form[data-email]){max-width:600px;padding:32px 36px 28px;border:1px solid hsl(140 12% 86%);border-radius:20px;background:var(--card);box-shadow:0 1px 2px hsl(150 20% 10% / .04),0 2px 6px hsl(150 20% 10% / .03),0 32px 64px -32px hsl(150 30% 14% / .22);backdrop-filter:none;-webkit-backdrop-filter:none;font-size:14px;line-height:1.55}
  .panel:has(form[data-email]) .brand{margin:0 0 28px;font-size:23px;gap:6px}
  .panel:has(form[data-email]) .brand .mark{width:28px;height:28px}
  .panel:has(form[data-email]) h1{margin:0;font-size:26px;font-weight:650;line-height:1.2;letter-spacing:-.028em;overflow-wrap:anywhere}
  .panel:has(form[data-email]) .reassurance{display:flex;align-items:center;justify-content:center;gap:6px;margin:16px 0 0;padding:0;border:0;color:var(--subtle);font-size:13px}
  .reassurance svg{width:14px;height:14px;flex:none}
  form[data-email] fieldset{margin:0}
  form[data-email] input[type=radio],form[data-email] input[type=checkbox]{appearance:none;-webkit-appearance:none;display:grid;place-content:center;width:18px;height:18px;margin:0;border:1.5px solid #a9b4ac;background:#fff;transition:border-color 120ms,background-color 120ms,box-shadow 120ms}
  form[data-email] input[type=radio]{border-radius:50%}
  form[data-email] input[type=radio]:checked{border-color:var(--lime);background:var(--lime);box-shadow:inset 0 0 0 3.5px #fff}
  form[data-email] input[type=checkbox]{border-radius:5px}
  form[data-email] input[type=checkbox]:checked{border-color:var(--lime);background:var(--lime)}
  form[data-email] input[type=checkbox]::after{content:"";width:5px;height:9px;margin-top:-2px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg) scale(0);transition:transform 120ms}
  form[data-email] input[type=checkbox]:checked::after{transform:rotate(45deg) scale(1)}

  .providers{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .provider{display:flex;align-items:center;gap:12px;margin:0;padding:14px 16px 14px 14px;border:1px solid var(--line-strong);border-radius:14px;background:#fff;box-shadow:0 1px 2px hsl(150 20% 10% / .04);cursor:pointer;transition:border-color 160ms,box-shadow 160ms,background-color 160ms}
  .provider:hover{border-color:#a9b4ac}
  .provider:has(input:checked){border-color:var(--lime);background:#fbfdfb;box-shadow:0 0 0 3px hsl(132 38% 30% / .12)}
  .provider:has(input:focus-visible){outline:2px solid var(--lime);outline-offset:3px}
  form[data-email] .provider input[type=radio]{margin-left:auto}
  .provider input:focus-visible{outline:none}
  .provider-name{font-size:15px;font-weight:600;line-height:1.35}
  .provider small{display:block;font-size:13px;font-weight:400;color:var(--muted)}
  .provider-logo{display:grid;place-items:center;width:40px;height:40px;flex:none;border:1px solid var(--line);border-radius:10px;background:#fff}
  .provider-logo svg{width:22px;height:22px}
  .setup-placeholder{margin:14px 0 0;color:var(--subtle);font-size:13px}

  .setup{margin:20px 0 0;padding:20px 20px 18px;border:1px solid var(--line);border-radius:16px;background:var(--tint);color:var(--ink);transition:border-color 160ms}
  .setup:has(.approval input:checked){border-color:hsl(132 38% 30% / .4)}
  .setup h2{margin:0 0 18px;font-size:15px;font-weight:600;line-height:1.4;letter-spacing:-.01em;color:var(--ink)}
  .setup-steps{list-style:none;counter-reset:setup-step;margin:0;padding:0;display:grid;gap:18px}
  .setup-step{position:relative;counter-increment:setup-step;display:grid;grid-template-columns:26px minmax(0,1fr) auto;column-gap:14px;align-items:start}
  .setup-step::before{content:counter(setup-step);display:grid;place-items:center;width:26px;height:26px;border:1px solid var(--line-strong);border-radius:50%;background:#fff;color:var(--ink);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
  .setup-step:not(:last-child)::after{content:"";position:absolute;left:12.5px;top:30px;bottom:-14px;width:1px;background:var(--line-strong)}
  .step-copy{padding-top:2px}
  .step-title{display:block;font-size:14px;font-weight:600;line-height:1.45;color:var(--ink)}
  .step-detail{display:block;margin-top:1px;font-size:13.5px;line-height:1.5;color:var(--muted)}
  .step-action{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
  .setup .action-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:0 12px;border:1px solid var(--line-strong);border-radius:9px;background:#fff;box-shadow:0 1px 2px hsl(150 20% 10% / .06);color:var(--ink);font:inherit;font-size:13px;font-weight:550;line-height:1;text-decoration:none;white-space:nowrap;cursor:pointer;transition:border-color 160ms,background-color 160ms,color 160ms}
  .setup .action-button:hover{border-color:#a9b4ac;background:#fbfcfb}
  .setup .action-button[data-copied]{border-color:hsl(132 38% 30% / .35);color:var(--lime)}
  .action-button svg{width:14px;height:14px;flex:none}
  .setup textarea{width:100%;min-height:96px;margin-top:4px;padding:8px 10px;border:1px solid var(--line-strong);border-radius:8px;background:#fff;color:var(--ink);font:inherit;font-size:13px}
  .step-action:has(textarea:not([hidden])){grid-column:2/-1;align-items:stretch;margin-top:8px}
  .setup .copy-status{color:var(--muted);font-size:12px}
  .setup .admin-request{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 6px;margin:18px 0 0;padding-left:40px;color:var(--muted);font-size:13px}
  .setup .admin-request button{font-size:13px;color:var(--lime);text-decoration-color:hsl(132 38% 30% / .35)}
  .setup .admin-request button[data-copied]{text-decoration:none}
  .setup .approval{display:flex;align-items:center;gap:12px;margin:18px -20px -18px;padding:14px 20px;border-top:1px solid var(--line);border-radius:0 0 16px 16px;background:#fff;color:var(--ink);font-size:14px;font-weight:500;cursor:pointer;transition:background-color 160ms}
  .setup .approval:has(input:checked){background:hsl(132 38% 96%)}

  #mailbox-step{margin-top:28px}
  form[data-email] legend{margin-bottom:10px;font-size:15px;font-weight:600;letter-spacing:-.01em}
  form[data-email] .choices{gap:0;border:1px solid var(--line-strong);border-radius:14px;overflow:hidden;background:#fff}
  form[data-email] .choice{min-height:0;padding:14px 16px;gap:12px;flex-direction:row-reverse;border:0;border-radius:0;background:none;box-shadow:none;font-size:14px}
  form[data-email] .choice+.choice{border-top:1px solid var(--line)}
  form[data-email] .choice:hover{background:#fafbfa}
  form[data-email] .choice:has(input:checked){background:var(--selected);box-shadow:none}
  form[data-email] .choice:has(input:focus-visible){outline-offset:-2px}
  form[data-email] .choice-name{font-weight:500;color:var(--ink)}
  form[data-email] .choice-detail{margin-top:1px;color:var(--muted)}

  form[data-email] button[type=submit]{margin-top:24px;min-height:50px;border:0;border-radius:12px;background:var(--lime);color:#fff;font-size:15px;font-weight:600;box-shadow:inset 0 1px 0 hsl(0 0% 100% / .14),0 1px 2px hsl(150 30% 10% / .2),0 10px 24px -12px hsl(132 38% 25% / .6)}
  form[data-email] button[type=submit]:hover:not(:disabled){background:var(--lime-hover)}
  form[data-email] button[type=submit]:disabled{opacity:1;background:#e9ece9;color:#6f7973;box-shadow:none;cursor:not-allowed}
  form[data-email][aria-busy=true] button[type=submit]:disabled{background:var(--lime);color:#fff;opacity:.85;cursor:progress}

  @media(max-width:520px){
   .panel:has(form[data-email]){padding:26px 20px 22px;border-radius:16px}
   .panel:has(form[data-email]) .brand{margin-bottom:24px}
   .panel:has(form[data-email]) h1{font-size:23px}
   .providers{gap:10px}
   .provider{gap:10px;padding:12px}
   .provider small{display:none}
   .provider-logo{width:34px;height:34px}
   .setup{padding:18px 16px 16px}
   .setup .approval{margin:16px -16px -16px;padding:14px 16px}
   .setup-step{grid-template-columns:26px minmax(0,1fr)}
   .step-action{grid-column:2;flex-direction:row;flex-wrap:wrap;align-items:center;margin-top:10px}
   .setup .admin-request{padding-left:0}
  }
  @media(prefers-reduced-motion:reduce){.provider,.setup,.setup .approval,.setup .action-button,form[data-email] input{transition:none}}
  @media(forced-colors:active){form[data-email] input[type=radio],form[data-email] input[type=checkbox]{appearance:auto;-webkit-appearance:auto}}
`;
const page = (title: string, content: string, scripts = "") => renderLiftyPage({ title: `${title} · Lifty`, content, styles, scripts });
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const choice = (input: string, name: string, detail: string) =>
  `<label class="choice"><span class="choice-copy"><span class="choice-name">${name}</span><span class="choice-detail">${detail}</span></span>${input}</label>`;

// The person must choose: neither use is preselected (LIF-1603). An everyday
// mailbox is tested right after setup (LIF-1223); a dedicated sending mailbox
// needs verified warmup before campaigns send. Senders can change it later.
function emailDeclaration(): string {
  return `<fieldset><legend>How do you use this mailbox?</legend><div class="choices">${[
    choice(`<input type="radio" name="mailbox_use" value="habitual" aria-label="A mailbox I already use every day" required>`,
      "My everyday mailbox", "Your regular work email."),
    choice(`<input type="radio" name="mailbox_use" value="dedicated" aria-label="A dedicated sending mailbox" required>`,
      "A dedicated outreach mailbox", "Needs 21 active days of warmup before sending."),
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

// Copying writes through a temporary selection first: it runs synchronously in
// the click, so it still works when the same click opens the admin console in
// a new tab and the page loses focus before an async clipboard write settles.
// Company approval and mailbox use are always the person's own clicks: the
// browser must not restore them on reload or when returning with Back.
const helpScript = `
function write(text){
 var active=document.activeElement,area=document.createElement('textarea'),copied=false;
 area.value=text;area.readOnly=true;area.style.cssText='position:fixed;top:0;left:0;opacity:0';
 document.body.append(area);area.select();
 try{copied=document.execCommand('copy')}catch(e){}
 area.remove();if(active&&active.focus)active.focus();
 if(copied)return Promise.resolve();
 try{return navigator.clipboard.writeText(text)}catch(e){return Promise.reject(e)}
}
function copy(button){
 var source=document.getElementById(button.dataset.copy),status=button.parentElement.querySelector('[role=status]'),label=button.querySelector('span');
 button.dataset.label=button.dataset.label||label.textContent;
 write(source.value).then(function(){
  label.textContent='Copied';button.setAttribute('data-copied','');status.textContent='Copied';
  clearTimeout(button.timer);
  button.timer=setTimeout(function(){label.textContent=button.dataset.label;button.removeAttribute('data-copied');status.textContent=''},2500);
 },function(){
  source.hidden=false;source.select();status.classList.remove('visually-hidden');status.textContent='Select the text and copy it.';
 });
}
document.querySelectorAll('[data-copy]').forEach(function(button){
 button.hidden=false;
 button.addEventListener('click',function(){copy(button)});
});
document.querySelectorAll('[data-copy-on-open]').forEach(function(link){
 link.addEventListener('click',function(){
  var button=document.querySelector('[data-copy="'+link.dataset.copyOnOpen+'"]');
  if(button)copy(button);
 });
});
var form=document.querySelector('form[data-email]');
if(form){
 var submit=form.querySelector('button[type=submit]'),panels=Array.from(form.querySelectorAll('[data-provider-help]'));
 var placeholder=document.getElementById('approval-placeholder'),mailbox=document.getElementById('mailbox-step');
 function clearAnswers(){
  form.querySelectorAll('[name=admin_approval],[name=mailbox_use]').forEach(function(input){input.checked=false});
 }
 function update(reset){
  var selected=form.querySelector('input[name=provider]:checked'),provider=selected&&selected.value;
  panels.forEach(function(panel){
   var active=panel.dataset.providerHelp===provider,approval=panel.querySelector('[name=admin_approval]');
   panel.hidden=!active;approval.disabled=!active;
   if(reset){approval.checked=false}
  });
  placeholder.hidden=!!provider;mailbox.hidden=!provider;
  submit.textContent=provider?'Connect with '+(provider==='google'?'Google':'Microsoft'):'Choose your provider';
  submit.disabled=!provider||!form.querySelector('[name=admin_approval]:enabled:checked');
 }
 form.querySelectorAll('[name=provider]').forEach(function(input){input.addEventListener('change',function(){update(true)})});
 form.querySelectorAll('[name=admin_approval]').forEach(function(input){input.addEventListener('change',function(){update(false)})});
 addEventListener('pageshow',function(event){form.removeAttribute('aria-busy');if(event.persisted)clearAnswers();update(false)});
 form.addEventListener('submit',function(event){
  if(form.hasAttribute('aria-busy')||submit.disabled){event.preventDefault();return}
  var spinner=document.createElement('span');spinner.className='spinner';spinner.setAttribute('aria-hidden','true');
  form.setAttribute('aria-busy','true');submit.disabled=true;submit.replaceChildren(spinner,'Opening sign-in…');
 });
 clearAnswers();update(false);
}`;
export const CONNECT_HELP_SCRIPT_HASH = `sha256-${createHash("sha256").update(helpScript).digest("base64")}`;

interface SetupStep { title: string; detail: string; action?: string }

const externalIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>';
const copyIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';
const shieldIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.75 2.75 3.75v4c0 3.1 2.2 5.4 5.25 6.5 3.05-1.1 5.25-3.4 5.25-6.5v-4L8 1.75Z"/></svg>';

// Company approval comes before the provider sign-in. Admins get a guided
// path with direct actions; anyone else copies a request for their admin.
// Neither action marks approval: only the person's own acknowledgement does.
function setupHelp(setup: EmailSetup): string {
  const google = setup.google;
  const googleUrl = google?.url ?? "https://admin.google.com/ac/owl/list?tab=configuredApps";
  const microsoftUrl = setup.outlook?.url ?? "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AppAppsPreview";
  const copyControl = (id: string, label: string, text: string, className: string, icon = "") =>
    `<button class="${className}" hidden type="button" data-copy="${id}">${icon}<span>${label}</span></button><span class="copy-status visually-hidden" role="status"></span><textarea id="${id}" aria-label="${label}" readonly hidden>${escape(text)}</textarea>`;
  const adminLink = (url: string, copies?: string) =>
    `<a class="action-button" href="${escape(url)}" target="_blank" rel="noopener noreferrer"${copies ? ` data-copy-on-open="${copies}"` : ""}>Open admin${externalIcon}</a>`;
  const steps = (items: SetupStep[]) => `<ol class="setup-steps">${items.map(step =>
    `<li class="setup-step"><div class="step-copy"><span class="step-title">${escape(step.title)}</span><span class="step-detail">${escape(step.detail)}</span></div>${step.action ? `<div class="step-action">${step.action}</div>` : ""}</li>`).join("")}</ol>`;
  const request = (id: string, text: string) =>
    `<div class="admin-request"><span>Not an admin?</span>${copyControl(id, "Copy a request for your admin", text, "link")}</div>`;
  const approval = (provider: string, label: string) =>
    `<label class="approval"><input type="checkbox" name="admin_approval" value="${provider}" required disabled><span>${label}</span></label>`;

  const googleSteps: SetupStep[] = google ? [
    { title: "Open Google Admin", detail: "Opens app access settings and copies Lifty’s app ID.", action: adminLink(googleUrl, "google-client") },
    { title: "Add Lifty Workspace Pilot", detail: "Choose Configure new app, paste the app ID, then select the app.",
      action: copyControl("google-client", "Copy app ID", google.clientId, "action-button", copyIcon) },
    { title: "Mark it Trusted", detail: "Choose who it applies to, select Trusted, then Finish. Google can take a few minutes to apply it." },
  ] : [
    { title: "Open Google Admin", detail: "Opens app access settings.", action: adminLink(googleUrl) },
    { title: "Find the app", detail: "Choose Configure new app and search for the app shown when you sign in." },
    { title: "Mark it Trusted", detail: "Choose who it applies to, select Trusted, then Finish. Google can take a few minutes to apply it." },
  ];
  const googleRequest = google
    ? `Could you approve Lifty for my Google Workspace account?\n\n1. Open app access in Google Admin: ${googleUrl}\n2. Choose Configure new app, search for this app ID and select Lifty Workspace Pilot:\n${google.clientId}\n3. Choose who it applies to, select Trusted, then Finish.\n\nLet me know when it’s done so I can connect my mailbox in Lifty.`
    : `Could you approve Lifty for my Google Workspace account?\n\n1. Open app access in Google Admin: ${googleUrl}\n2. Choose Configure new app and select the app I see when I sign in to Lifty. I can send you its client ID.\n3. Choose who it applies to, select Trusted, then Finish.\n\nLet me know when it’s done so I can connect my mailbox in Lifty.`;
  const microsoftSteps: SetupStep[] = [
    { title: "Open Microsoft Entra", detail: "In Enterprise apps, open the app shown when you sign in.", action: adminLink(microsoftUrl) },
    { title: "Grant admin consent", detail: "Under Permissions, grant consent for your organization." },
  ];
  const microsoftRequest = `Could you approve Lifty for my Microsoft 365 account?\n\n1. Open Enterprise apps in Microsoft Entra: ${microsoftUrl}\n2. Open the app shown on my Microsoft sign-in screen.\n3. Under Permissions, grant admin consent for our organization.\n\nIf our organization uses approval requests, I can also request it from the sign-in screen. Let me know when it’s done so I can connect my mailbox in Lifty.`;

  return `<p id="approval-placeholder" class="setup-placeholder">Choose a provider to see how to approve Lifty.</p>
<section class="setup provider-help" data-provider-help="google" hidden aria-labelledby="google-approval-title"><h2 id="google-approval-title">Approve Lifty in Google Workspace</h2>
${steps(googleSteps)}${request("google-admin", googleRequest)}
${approval("google", "Lifty is approved for my Google account.")}</section>
<section class="setup provider-help" data-provider-help="outlook" hidden aria-labelledby="microsoft-approval-title"><h2 id="microsoft-approval-title">Approve Lifty in Microsoft 365</h2>
${steps(microsoftSteps)}${request("microsoft-admin", microsoftRequest)}
${approval("outlook", "My organization allows Lifty for this account.")}</section>`;
}

const googleLogo = `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59A14.41 14.41 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.87 23.87 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
const microsoftLogo = `<svg viewBox="0 0 23 23" aria-hidden="true" focusable="false"><path fill="#f25022" d="M0 0h11v11H0z"/><path fill="#7fba00" d="M12 0h11v11H12z"/><path fill="#00a4ef" d="M0 12h11v11H0z"/><path fill="#ffb900" d="M12 12h11v11H12z"/></svg>`;
function providerChoice(): string {
  return `<fieldset><legend class="visually-hidden">Email provider</legend><div class="providers">${([
    ["google", "Google", "Google Workspace", googleLogo], ["outlook", "Microsoft", "Microsoft 365", microsoftLogo],
  ] as const).map(([value, label, detail, logo]) => `<label class="provider"><span class="provider-logo">${logo}</span><span><span class="provider-name">${label}</span><small>${detail}</small></span><input type="radio" name="provider" value="${value}" aria-label="${label}" required></label>`).join("")}</div></fieldset>`;
}

export function renderConnectPage(channel: ConnectChannel, intent: string, senderName: string, setup: EmailSetup = {}): string {
  const email = channel === "email";
  const label = email ? "email account" : "LinkedIn account";
  return page(`Connect your ${label}`, `<h1>Connect ${escape(senderName)}'s ${email ? "email" : label}</h1>
${email ? "" : '<p class="intro">Connect the LinkedIn account Lifty should act from.</p>'}
<form method="post" action="/connect/${channel}" data-pending="Opening sign-in…"${email ? ' data-email="true" autocomplete="off"' : ''}><input type="hidden" name="intent" value="${escape(intent)}">
${email ? `${providerChoice()}${setupHelp(setup)}<div id="mailbox-step" hidden>${emailDeclaration()}</div><button class="primary block connect-submit" type="submit" disabled>Choose your provider</button><noscript>Enable JavaScript to choose a provider, review company approval and connect.</noscript>` : `${linkedinDeclaration()}<button class="primary block" type="submit">Continue to sign-in</button>`}</form>
<p class="reassurance">${email ? shieldIcon : ""}Connecting does not start campaigns.</p>`, email ? `<script>${helpScript}</script>` : pendingSubmitScript);
}

export function renderConnectMessagePage(title: string, message: string): string {
  return page(title, `<h1>${escape(title)}</h1><p class="intro">${escape(message)}</p>`);
}
