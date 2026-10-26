import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AccountConnectionProgress } from './identity-contracts.js';
import { PublicError } from './errors.js';
import { renderLiftyPage } from './lifty-brand.js';

/** Every browser connection return is registered here. Webhooks are separate. */
export const CONNECTION_FLOWS = {
  hubspot: { path:'/hubspot/callback', label:'HubSpot', entries:['/hubspot/start'] },
  slack: { path:'/slack/callback', label:'Slack', entries:['/slack/start'] },
  attio: { path:'/attio/callback', label:'Attio', entries:['/attio/start'] },
  warmup: { path:'/warmup/google/callback', label:'email warmup', entries:['/warmup/setup','/warmup/received'] },
  warmup_microsoft: { path:'/warmup/microsoft/return', label:'email warmup', entries:['/warmup/microsoft/sign-in'] },
  email: { path:'/connect/email/return', label:'email', entries:['/connect/email'], retry:'/connect/email' },
  linkedin: { path:'/connect/linkedin/return', label:'LinkedIn', entries:['/connect/linkedin'], retry:'/connect/linkedin' },
} as const;
export type ConnectionFlow = keyof typeof CONNECTION_FLOWS;
/**
 * What the page tells the person while the attempt is still pending: why the
 * provider refused the sign-in (with a retry of the same attempt where one can
 * work), or that a warmup handoff is starting. Never terminal evidence.
 */
export const ConfirmationAttention = z.enum(['released','exists','in_use','already_connected','canceled','provider','starting',
  'microsoft_sign_in','microsoft_preparing','microsoft_recovery','warmup_action','sign_in_unavailable']);
export type ConfirmationAttention = z.infer<typeof ConfirmationAttention>;
export const ConfirmationResult = z.discriminatedUnion('status', [
  z.object({status:z.literal('pending'), attention:ConfirmationAttention.optional(), progress:AccountConnectionProgress.optional(), reference:z.uuid().optional()}),
  // Warmup only: when the placement test runs and where its result goes.
  z.object({status:z.literal('connected'), account:z.string().max(254).nullable(), reference:z.uuid().optional(),
    placement:z.object({when:z.enum(['now','after_warmup']), notify:z.array(z.enum(['email','slack'])).max(2)}).optional()}),
  // Named CRM refusals (LIF-1282), the attempt's own error codes: account_in_use
  // (connected in another Lifty workspace, never named), account_mismatch,
  // permission_missing and crm_provider_conflict.
  z.object({status:z.literal('failed'), reason:z.enum(['canceled','exists','provider','verification','ended','invalid','mailbox_in_other_warmup','provider_rejected',
    'account_in_use','account_mismatch','permission_missing','crm_provider_conflict']), reference:z.uuid().optional()}),
]);
export type ConfirmationResult = z.infer<typeof ConfirmationResult>;
const Input = z.strictObject({state:z.string().min(1).max(4096),code:z.string().min(1).max(4096).optional(),
  denied:z.boolean().optional(),errorType:z.string().max(100).optional(),
  // The provider account a refusal names (api/already_exists); an untrusted hint.
  errorDetail:z.string().regex(/^acc_[A-Za-z0-9_-]{1,251}$/).optional()});
export type ConfirmationInput = z.infer<typeof Input>;
export interface ConfirmationAdapter {
  origin?:string;
  // Local signature/shape checks only. Remote authority is checked by process/status.
  validate(input:ConfirmationInput, context:Context):void;
  process?(input:ConfirmationInput, context:Context):Promise<ConfirmationResult>;
  status(input:ConfirmationInput, context:Context):Promise<ConfirmationResult>;
}
export type ConfirmationAdapters = Partial<Record<ConnectionFlow, ConfirmationAdapter>>;
type Execution = {signal:AbortSignal;upstream_status?:number;upstream_outcome?:string;provider_error?:string};
const deadline = new AsyncLocalStorage<Execution>();
const providerErrorCode = /^[a-z0-9_]{1,40}(\/[a-z0-9_]{1,40})?$/;
/** Record a provider's error code (e.g. api/invalid_parameters) for this request's log. Codes only, never free text. */
export function noteProviderError(code:string) {
  const parent = deadline.getStore();
  if (parent && providerErrorCode.test(code)) parent.provider_error ??= code;
}
/** Entry/declaration requests use the same bounded I/O contract as callbacks. */
export function withConnectionDeadline<T>(milliseconds:number, work:()=>Promise<T>):Promise<T> {
  return deadline.run({signal:AbortSignal.timeout(milliseconds)}, work);
}
/** All dependency I/O in a confirmation request shares one deadline, including body reads. */
export function connectionFetch(fetchImpl:typeof fetch):typeof fetch {
  return async (input, init) => {
    const parent = deadline.getStore();
    const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    try {
      const response=await fetchImpl(input, {...init, ...(parent ? {signal:inherited ? AbortSignal.any([parent.signal,inherited]) : parent.signal} : {})});
      if(parent&&(!parent.upstream_outcome||parent.upstream_outcome==='response')){parent.upstream_status=response.status;parent.upstream_outcome=response.ok?'response':'http_error';}
      return response;
    }catch(error){if(parent){parent.upstream_outcome=parent.signal.aborted||inherited?.aborted?'timeout':'transport';delete parent.upstream_status;}throw error;}
  };
}
export const pendingConfirmation = ():ConfirmationResult => ({status:'pending'});
export const invalidConfirmation = ():ConfirmationResult => ({status:'failed',reason:'invalid'});

// No credentials are rendered into HTML or persisted in browser storage. The
// existing callback URL is read once, scrubbed before I/O, then the code is POSTed
// once. Reloads and lost responses only read the same durable attempt.
export const CONFIRMATION_SCRIPT = String.raw`(async function(){
var url=new URL(location.href),q=url.searchParams,root=document.getElementById('confirmation'),key=root.dataset.stateKey,body={state:q.get(key)||''};
var code=q.get('code'),denied=q.has('error'),errorType=q.get('error_type')||(q.has('error_title')?'provider_rejected':'');
var errorDetail=errorType==='api/already_exists'&&/^acc_[A-Za-z0-9_-]{1,251}$/.test(q.get('error_detail')||'')?q.get('error_detail'):'';
var title=document.getElementById('confirmation-title'),detail=document.getElementById('confirmation-detail'),spinner=document.getElementById('confirmation-spinner');
var actions=document.getElementById('confirmation-actions'),retry=document.getElementById('confirmation-retry'),check=document.getElementById('confirmation-check'),reference=document.getElementById('confirmation-reference');
var prepare=root.dataset.prepare==='true',lastProgress='',polling=false;
// A provider return can precede its signed authorization. Only preparation may reopen sign-in.
var returnedSignIn=!!root.dataset.retry&&!prepare&&!errorType&&!denied&&!code;
var label=root.dataset.label,warmup=root.dataset.warmup==='true',finished=false,shown='',until=Date.now()+90000,delay=1000,cap=8000;
url.search='';url.searchParams.set(key,body.state);if(errorType)url.searchParams.set('error_type',errorType);if(errorDetail)url.searchParams.set('error_detail',errorDetail);if(prepare)url.searchParams.set('prepare','1');history.replaceState(null,'',url.pathname+url.search);
var notes={
 released:['Try connecting again','This '+label+' account was still linked to an earlier Lifty connection, which stopped the sign-in. Lifty removed that old link. Try again and choose the same account.',1],
 exists:['This account is already linked','This '+label+' account is already linked to Lifty, so it could not be added again. Try again, or return to Lifty if it keeps happening.',1],
 in_use:['Connected in another workspace','This '+label+' account is connected in another Lifty workspace. Disconnect it there first, or try again with a different account.',1],
 already_connected:['Already connected','This '+label+' account is already connected to this workspace. Return to Lifty to continue.',0],
 canceled:['Sign-in not finished','The sign-in was canceled before it finished. Try again when you are ready.',1],
 provider:['The sign-in did not finish','The sign-in stopped before Lifty received the account. Try again. If it fails again, return to Lifty for help.',1],
 starting:['Starting warmup','Mailbox access is confirmed. Lifty is starting warmup now, usually within a few minutes, and this page updates when it does. You can also close it and return to Lifty.',0],
 microsoft_sign_in:['Continue with Microsoft','Sign in to the mailbox shown on the setup page and approve Mailivery. Microsoft opens in a new tab. Keep this page open: it confirms when warmup is running.',0],
 microsoft_preparing:['Preparing Microsoft sign-in','Lifty is preparing secure Microsoft authorization. This page will show the sign-in button when it is ready.',0],
 microsoft_recovery:['Sign-in preparation needs checking','Lifty could not confirm the sign-in link. Check this same attempt, or return to Lifty for help. Warmup has not been confirmed.',0],
 warmup_action:['Warmup needs attention','Mailbox authorization was received, but warmup could not start. Return to Lifty to see the required mailbox or DNS fix, then check this same attempt.',0],
 sign_in_unavailable:['Sign-in could not open','Lifty could not open the '+label+' sign-in page. Nothing was connected. Return to Lifty with the connection reference for help.',0]
};
function attend(attention){
 var note=notes[attention];if(!note||shown===attention)return;shown=attention;
 title.textContent=note[0];detail.textContent=note[1];spinner.hidden=attention!=='starting';
 retry.textContent='Try again';
 if(note[2]&&root.dataset.retry){retry.href=root.dataset.retry+'?'+key+'='+encodeURIComponent(body.state);actions.hidden=false;}else actions.hidden=true;
 if(attention==='microsoft_sign_in'&&root.dataset.microsoft==='true'){
  retry.textContent='Continue with Microsoft';retry.href='/warmup/microsoft/sign-in?state='+encodeURIComponent(body.state);
  retry.target='_blank';retry.rel='noopener noreferrer';actions.hidden=false;
 }
 if(attention==='microsoft_preparing')spinner.hidden=false;
 if(attention==='starting'||attention==='microsoft_sign_in'){until=Math.max(until,Date.now()+1500000);cap=30000;}
}
function progress(p,ref){
 if(!p||typeof p.stage!=='string')return;
 var waitingForAuthorization=returnedSignIn&&p.stage==='sign_in_required';
 lastProgress=waitingForAuthorization?'verifying':p.stage;
 if(typeof ref==='string'&&/^[a-f0-9-]{36}$/i.test(ref)){reference.textContent='Connection reference: '+ref;reference.hidden=false;}
 if(shown===p.stage+(p.reason||''))return;shown=p.stage+(p.reason||'');
 actions.hidden=true;spinner.hidden=true;
 var path=root.dataset.retry;
 function resume(text){if(path){retry.textContent=text;retry.href=path+'?'+key+'='+encodeURIComponent(body.state);actions.hidden=false;}}
 if(p.stage==='declaration_required'){title.textContent='A confirmation is needed';detail.textContent='Continue to the connection page and confirm how you use this account.';resume('Continue');}
 else if(p.stage==='preparing'){title.textContent='Preparing sign-in';detail.textContent='Lifty is preparing the secure sign-in page. Sign-in has not finished yet.';spinner.hidden=false;}
 else if(p.stage==='sign_in_required'){
  if(waitingForAuthorization){title.textContent='Checking your connection';detail.textContent='Lifty is checking the result of your sign-in. This page will update when the account is verified.';spinner.hidden=false;}
  else{title.textContent='Ready to sign in';detail.textContent='Continue to sign in to your '+label+' account. Lifty will verify it after you finish.';resume('Continue to sign in');}
 }
 else if(p.stage==='verifying'){title.textContent='Checking your connection';detail.textContent='Lifty received the authorization and is verifying the account.';spinner.hidden=false;}
}
function placement(p){
 if(!p||(p.when!=='now'&&p.when!=='after_warmup'))return '';
 var n=Array.isArray(p.notify)?p.notify:[],slack=n.indexOf('slack')>=0,email=n.indexOf('email')>=0;
 var where=slack&&email?'on Slack and by email':slack?'on Slack':email?'by email':'';
 if(p.when==='now')return ' Lifty is now sending one test email from this mailbox to about 20 to 40 test inboxes to see where your email lands. '+(where?'You will get the result '+where+', usually within 20 minutes.':'The result is usually ready in Lifty within 20 minutes.');
 return ' When warmup ends, Lifty sends one test email from this mailbox to about 20 to 40 test inboxes'+(where?' and sends you the result '+where+'.':' and shows you the result in Lifty.');
}
function show(result){
 if(finished||!result||!['pending','connected','failed'].includes(result.status))return;
 if(result.status==='pending'){if(prepare&&!denied&&!code&&!errorType&&!result.attention&&result.progress&&result.progress.stage==='sign_in_required'&&root.dataset.retry){finished=true;location.replace(root.dataset.retry+'?'+key+'='+encodeURIComponent(body.state));return;}if(result.progress)progress(result.progress,result.reference);if(result.attention)attend(result.attention);return;}
 finished=true;spinner.hidden=true;actions.hidden=true;check.hidden=true;
 if(result.status==='connected'){title.textContent=warmup?'Warmup is running':label+' is connected';detail.textContent='Lifty verified '+(result.account||'the connection')+'.'+(warmup?placement(result.placement):'')+' Return to Lifty to continue. Connecting does not start outreach.';if(label==='Slack')detail.textContent+=' Invite @Lifty to the channel where you want notifications, then tell Lifty which channel you chose.';}
 else{title.textContent='Connection needs attention';detail.textContent=result.reason==='account_in_use'?'This '+label+' account is connected in another Lifty workspace. Disconnect it there first, or try again with a different account.':result.reason==='account_mismatch'?'This is a different '+label+' account from the one connected to this workspace, so nothing changed. Try again and sign in to the same account. To switch accounts, disconnect '+label+' in Lifty first.':result.reason==='permission_missing'?label+' did not grant every permission Lifty needs, so nothing changed. Try again and approve all requested permissions, or ask a '+label+' admin to connect.':result.reason==='crm_provider_conflict'?'Another CRM is connected to this workspace. Disconnect it in Lifty before connecting '+label+'.':result.reason==='mailbox_in_other_warmup'?'This mailbox is already registered with another warmup service. Remove it there, then start warmup again in Lifty.':result.reason==='provider_rejected'?'The warmup service refused this setup. Our team has been alerted. Once the issue is fixed, start warmup again in Lifty.':result.reason==='canceled'?'Authorization was not completed. Return to Lifty to check this attempt.':result.reason==='verification'?'The selected account could not be verified. Return to Lifty for help.':'Return to Lifty to check this attempt and the next step before requesting another link.';if(label==='HubSpot'&&result.reason==='canceled')detail.textContent+=' If permissions were blocked, ask a HubSpot super admin to approve Lifty in Settings > Integrations > Connected Apps > Approved apps.';}
}
async function request(stage,payload,ms){
 var controller=new AbortController(),timer=setTimeout(function(){controller.abort()},ms);
 try{var response=await fetch(url.pathname+'/'+stage,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-lifty-connection':'1'},body:JSON.stringify(payload),signal:controller.signal});if(response.ok)show(await response.json());}catch(e){}finally{clearTimeout(timer);}
}
// Status checks also prepare a missing sign-in; wait for this one first so one page asks once.
if(prepare&&!code&&!denied&&!errorType)await request('process',body,50000);
if(code||denied){var submission=Object.assign({},body,code?{code:code}:{denied:true});code=null;request('process',submission,50000);}
if(errorType)body.errorType=errorType;
if(errorDetail)body.errorDetail=errorDetail;
async function poll(){
 if(polling)return;polling=true;shown='';check.hidden=true;
 while(!finished&&Date.now()<until){await request('status',body,10000);if(finished)break;await new Promise(function(resolve){setTimeout(resolve,delay)});delay=Math.min(delay*2,cap);}
 if(!finished){
  spinner.hidden=true;check.hidden=false;
  if(!shown||shown==='starting'||lastProgress==='preparing'||lastProgress==='verifying'){
   actions.hidden=true;
   if(lastProgress==='preparing'){title.textContent='Sign-in has not opened yet';detail.textContent='Lifty could not open the sign-in page yet. Check status to try again, or return to Lifty with the connection reference for help.';}
   else{title.textContent='Still checking';detail.textContent='The result is not confirmed yet. Check the status of this same attempt, or return to Lifty with the connection reference for help.';}
  }
 }
 polling=false;
}
check.addEventListener('click',function(){if(finished||polling)return;until=Date.now()+90000;delay=1000;poll();});
await poll();
})();`;
const scriptHash = createHash('sha256').update(CONFIRMATION_SCRIPT).digest('base64');
const actionStyles = '.actions{margin:24px 0 0}.actions a,.check-status{display:inline-flex;align-items:center;min-height:50px;padding:12px 26px;border:1px solid hsl(99 34% 65% / .75);border-radius:9px;background:var(--lime);color:var(--paper);font-weight:600;text-decoration:none}.actions a:hover,.check-status:hover{background:var(--lime-hover)}';
export function renderConfirmationPage(flow:ConnectionFlow, valid=true, prepare=false, returnUrl?: string) {
  const definition:{label:string;retry?:string}=CONNECTION_FLOWS[flow], {label}=definition;
  const back = returnUrl ? `<p class="reassurance"><a href="${new URL(returnUrl).origin.replaceAll('"', '&quot;')}">Return to Lifty</a></p>` : "";
  const title=valid?(prepare?'Preparing sign-in':'Checking your connection'):'Connection needs attention';
  return renderLiftyPage({title,styles:actionStyles,content:
    `<section id="confirmation" data-label="${label}" data-prepare="${prepare}" data-warmup="${flow==='warmup'||flow==='warmup_microsoft'}" data-microsoft="${flow==='warmup_microsoft'}" data-state-key="${['email','linkedin'].includes(flow)?'intent':'state'}"${definition.retry?` data-retry="${definition.retry}"`:''} aria-live="polite"><div id="confirmation-spinner" class="symbol" aria-hidden="true"${valid?'':' hidden'}><span class="spinner"></span></div><h1 id="confirmation-title">${title}</h1><p id="confirmation-detail" class="intro">${valid?(prepare?'Lifty is preparing the secure sign-in page. Sign-in has not finished yet.':'Lifty is reading the status of this connection. This page will update automatically.'):'Return to Lifty to check this attempt and get the next step.'}</p><p id="confirmation-actions" class="actions" hidden><a id="confirmation-retry" href="">Try again</a></p><p><button id="confirmation-check" class="check-status" type="button" hidden>Check status</button></p><p id="confirmation-reference" class="reassurance" hidden></p><p class="reassurance">Connecting does not start outreach.</p></section>${back}<noscript>JavaScript is needed to finish this connection here. Return to Lifty to check the attempt before requesting another link.</noscript>${valid?`<script>${CONFIRMATION_SCRIPT}</script>`:''}`});
}
export type ConfirmationLog = {flow:ConnectionFlow;stage:string;outcome:string;elapsed_ms:number;status:number;correlation:string;upstream_status?:number;upstream_outcome?:string;provider_error?:string;reference?:string;progress_stage?:string};
export function createConfirmationRouter(flow:ConnectionFlow, adapter:ConfirmationAdapter, options:{prefix?:string;origin?:string;returnUrl?:string;log?:(event:ConfirmationLog)=>void}={}) {
  const app=new Hono();
  const path=CONNECTION_FLOWS[flow].path.slice((options.prefix??'').length);
  const headers=(c:Context)=>{
    c.header('cache-control','no-store, no-transform');c.header('referrer-policy','no-referrer');c.header('x-content-type-options','nosniff');
    c.header('content-security-policy',`default-src 'none'; script-src 'sha256-${scriptHash}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  };
  app.get(path,c=>{
    headers(c);
    const q=new URL(c.req.url).searchParams;
    const key=['email','linkedin'].includes(flow)?'intent':'state';
    const parsed=Input.safeParse({state:q.get(key)??'',...(q.has('code')?{code:q.get('code')}:{}),...(q.has('error')?{denied:true}:{})});
    const prepare=q.get('prepare')==='1'&&['email','linkedin','warmup_microsoft'].includes(flow);
    let valid=parsed.success && [key,'code','error','prepare'].every(key=>q.getAll(key).length<=1)
      && (!q.has('prepare')||prepare);
    if(valid&&parsed.success){try{adapter.validate(parsed.data,c);}catch{valid=false;}}
    return c.html(renderConfirmationPage(flow,valid,prepare,options.returnUrl),200);
  });
  for(const stage of ['process','status'] as const)app.post(path+'/'+stage,async c=>{
    headers(c);
    const origin=options.origin??new URL(c.req.url).origin;
    const supplied=c.req.header('origin');
    if(c.req.header('x-lifty-connection')!=='1'||!c.req.header('content-type')?.startsWith('application/json')
      ||c.req.header('sec-fetch-site')==='cross-site'||(supplied!==origin&&!(supplied==='null'&&c.req.header('sec-fetch-site')==='same-origin')))
      return c.json(invalidConfirmation(),403);
    const started=Date.now();const execution:Execution={signal:AbortSignal.timeout(stage==='process'?45000:8000)};let correlation='invalid',validated=false,providerError:string|undefined;let result:ConfirmationResult=pendingConfirmation(), status=200;
    try {
      const reader=c.req.raw.body?.getReader();if(!reader)return c.json(invalidConfirmation(),400);
      const cancel=()=>{void reader.cancel().catch(()=>{});};execution.signal.addEventListener('abort',cancel,{once:true});
      const chunks:Uint8Array[]=[];let size=0;
      try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
        if(size>12288){await reader.cancel();return c.json(invalidConfirmation(),413);}chunks.push(next.value);}}
      finally{execution.signal.removeEventListener('abort',cancel);reader.releaseLock();}
      execution.signal.throwIfAborted();
      const input=Input.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      correlation=createHash('sha256').update(flow+'\0'+input.state).digest('hex').slice(0,24);
      if(stage==='status'&&(input.code||input.denied))return c.json(invalidConfirmation(),400);
      adapter.validate(input,c);
      validated=true;
      // A provider's error code (e.g. api/already_exists) is an untrusted hint but
      // the only record of why an attempt failed. Log codes only, never free text.
      if(input.errorType&&providerErrorCode.test(input.errorType))providerError=input.errorType;
      const handler=stage==='process'?adapter.process:adapter.status;
      if(!handler)return c.json(invalidConfirmation(),400);
      // The handler remains awaited; request cancellation never launches an
      // untracked task. All real provider/DB fetches inherit this deadline.
      result=ConfirmationResult.parse(await deadline.run(execution,()=>handler(input,c)));
    }catch(error){
      if(!validated&&(error instanceof z.ZodError||error instanceof SyntaxError))result=invalidConfirmation();
      else if(error instanceof PublicError&&error.status>=400&&error.status<500&&error.code!=='WARMUP_SETUP_UNAVAILABLE')result=invalidConfirmation();
      else status=202;
    }
    if(result.reference)correlation=createHash('sha256').update(flow+'\0'+result.reference).digest('hex').slice(0,24);
    const reportedError=execution.provider_error??providerError;
    options.log?.({flow,stage,...(result.reference?{reference:result.reference}:{}),...(result.status==='pending'&&result.progress?{progress_stage:result.progress.stage}:{}),outcome:result.status,elapsed_ms:Date.now()-started,status,correlation,...(execution.upstream_status===undefined?{}:{upstream_status:execution.upstream_status}),...(execution.upstream_outcome?{upstream_outcome:execution.upstream_outcome}:{}),...(reportedError?{provider_error:reportedError}:{})});
    return c.json(result,status===202?202:200);
  });
  return app;
}
