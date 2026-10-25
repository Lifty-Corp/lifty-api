import { createHash } from "node:crypto";
import type { EmailSetup } from "./email-connect-setup.js";
import { pendingSubmitScript, renderLiftyPage } from "./lifty-brand.js";
import type { ConnectChannel } from "./connect-state.js";

// Lifty's connect page: the person answers the account declaration here,
// before the provider sign-in. The agent never asks or relays it.
const styles = `
  form{margin-top:24px}
  .provider-buttons{display:grid;gap:10px}
  .provider-buttons button[type=submit]{margin:0}
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
  return `<fieldset><legend>How do you use this mailbox?</legend><div class="choices">${[
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

const helpScript = `document.querySelectorAll('[data-copy]').forEach(function(button){button.hidden=false;button.addEventListener('click',async function(){var source=document.getElementById(button.dataset.copy),status=button.parentElement.querySelector('[role=status]');try{await navigator.clipboard.writeText(source.value||source.textContent);status.textContent='Copied'}catch(e){if(source.select)source.select();status.textContent='Select and copy the text below'}})});var form=document.querySelector('form[data-email]');if(form){var buttons=Array.from(form.querySelectorAll('button[type=submit]'));buttons.forEach(function(button){button.dataset.label=button.textContent});addEventListener('pageshow',function(){form.removeAttribute('aria-busy');var selected=form.querySelector('input[name=provider]');if(selected)selected.remove();buttons.forEach(function(button){button.disabled=false;button.textContent=button.dataset.label})});form.addEventListener('submit',function(event){if(form.hasAttribute('aria-busy')||!event.submitter){event.preventDefault();return}var selected=document.createElement('input');selected.type='hidden';selected.name='provider';selected.value=event.submitter.value;form.append(selected);form.setAttribute('aria-busy','true');buttons.forEach(function(button){button.disabled=true});event.submitter.textContent='Opening sign-in…'})}`;
export const CONNECT_HELP_SCRIPT_HASH = `sha256-${createHash("sha256").update(helpScript).digest("base64")}`;

function setupHelp(setup: EmailSetup): string {
  const google = setup.google;
  const googleInstructions = google
    ? `Please approve Lifty Workspace Pilot for my Google Workspace account. Open ${google.url}, choose Configure new app, then OAuth App Name or Client ID. Search for ${google.clientId}, select the app and the users who need access, then choose Trusted and finish. Let me know when it is approved so I can connect my own mailbox in Lifty.`
    : "Please approve the app shown on my Google consent screen in Google Admin > Security > API controls. Ask me for its OAuth client ID so you can confirm the exact app. Let me know when I can connect my own mailbox in Lifty.";
  const microsoftInstructions = `Please approve the app shown on my Microsoft sign-in screen for my Microsoft 365 account. ${setup.outlook ? `Open ${setup.outlook.url} to review its permissions.` : "In Microsoft Entra, open Enterprise apps and review the app and its requested permissions. If your organization enables approval requests, I can request approval from the sign-in screen."} Let me know when it is approved so I can connect my own mailbox in Lifty.`;
  const copy = (id: string, label: string, text: string) => `<div><button hidden type="button" data-copy="${id}">${label}</button><span class="copy-status" role="status"></span><textarea id="${id}" aria-label="Instructions for your administrator" readonly>${escape(text)}</textarea></div>`;
  return `<details class="setup"><summary>Need your company’s approval?</summary>
<section class="provider-help" data-provider-help="google"><strong>Google Workspace</strong>
${google ? `<p>An admin approves the app once. Already approved? Continue below.</p><p><a href="${escape(google.url)}" target="_blank" rel="noopener noreferrer">Open Google Admin</a></p><ol><li>Choose <strong>Configure new app</strong> and search by client ID.</li><li>Select the app and users, choose <strong>Trusted</strong>, then finish.</li></ol><div><button hidden type="button" data-copy="google-client">Copy client ID</button><span class="copy-status" role="status"></span><code id="google-client">${escape(google.clientId)}</code></div>` : `<p>Your Workspace admin can approve the app in <a href="https://admin.google.com/ac/owl" target="_blank" rel="noopener noreferrer">Google Admin → API controls</a>. Use the exact client ID shown for your app.</p>`}
<details><summary>Not an admin?</summary><p>Send these instructions to your admin. Come back here after approval.</p>${copy("google-admin", "Copy instructions", googleInstructions)}</details></section>
<section class="provider-help" data-provider-help="outlook"><strong>Microsoft 365</strong><p>If Microsoft asks for admin approval, use <strong>Request approval</strong> when offered, or ask your admin to approve the app. Already approved? Continue below.</p><p><a href="${escape(setup.outlook?.url ?? "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AppAppsPreview")}" target="_blank" rel="noopener noreferrer">${setup.outlook ? "Open admin approval" : "Open Microsoft Entra apps"}</a></p><details><summary>Not an admin?</summary><p>Share these instructions, then return here after approval.</p>${copy("microsoft-admin", "Copy instructions", microsoftInstructions)}</details></section>
<p>Admin approval does not connect your mailbox. Continue here with your own account.</p></details>`;
}

export function renderConnectPage(channel: ConnectChannel, intent: string, senderName: string, setup: EmailSetup = {}): string {
  const email = channel === "email";
  const label = email ? "email account" : "LinkedIn account";
  return page(`Connect your ${label}`, `<h1>Connect ${escape(senderName)}'s ${label}</h1>
<p class="intro">${email ? "Choose how you use this mailbox, then sign in with your provider." : "Connect the LinkedIn account Lifty should act from."}</p>
<form method="post" action="/connect/${channel}" data-pending="Opening sign-in…"${email ? ' data-email="true"' : ''}><input type="hidden" name="intent" value="${escape(intent)}">
${email ? `${emailDeclaration()}${setupHelp(setup)}<div class="provider-buttons"><button class="primary block" type="submit" name="provider" value="google">Continue with Google</button><button class="primary block" type="submit" name="provider" value="outlook">Continue with Microsoft</button></div>` : `${linkedinDeclaration()}<button class="primary block" type="submit">Continue to sign-in</button>`}</form>
<p class="reassurance">Connecting does not start campaigns.${email ? " You may see unipile.com during sign-in; it handles the connection for Lifty." : ""}</p>`, email ? `<script>${helpScript}</script>` : pendingSubmitScript);
}

export function renderConnectMessagePage(title: string, message: string): string {
  return page(title, `<h1>${escape(title)}</h1><p class="intro">${escape(message)}</p>`);
}
