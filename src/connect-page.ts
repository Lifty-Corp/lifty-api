import { pendingSubmitScript, renderLiftyPage } from "./lifty-brand.js";
import type { ConnectChannel } from "./connect-state.js";

// Lifty's connect page: the person answers the account declaration here,
// before the provider sign-in. The agent never asks or relays it.
const styles = `
  form{margin-top:28px}
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
      "A mailbox I already use every day", "This person's everyday mailbox on the company's usual domain. Lifty tests where its email lands as soon as you finish setup."),
    choice(`<input type="radio" name="mailbox_use" value="dedicated" aria-label="A dedicated sending mailbox" required>`,
      "A dedicated sending mailbox", "A new or separate address for outreach, including one on a second or lookalike domain. It needs 21 active days of warmup before campaigns send."),
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

export function renderConnectPage(channel: ConnectChannel, intent: string, senderName: string): string {
  const label = channel === "email" ? "email account" : "LinkedIn account";
  return page(`Connect your ${label}`, `<h1>Connect ${escape(senderName)}'s ${label}</h1>
<p class="intro">${channel === "email" ? "Connect the mailbox Lifty should send from." : "Connect the LinkedIn account Lifty should act from."}</p>
<form method="post" action="/connect/${channel}" data-pending="Opening sign-in…"><input type="hidden" name="intent" value="${escape(intent)}">
${channel === "email" ? emailDeclaration() : linkedinDeclaration()}
<button class="primary block" type="submit">Continue to sign-in</button></form>
<p class="reassurance">Connecting does not start outreach. You review and approve your outreach before anything is sent.</p>`, pendingSubmitScript);
}

export function renderConnectMessagePage(title: string, message: string): string {
  return page(title, `<h1>${escape(title)}</h1><p class="intro">${escape(message)}</p>`);
}
