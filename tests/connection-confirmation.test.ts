import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { sealHubspotConnectIntent } from '../src/hubspot-state.js';
import { sealSlackConnectIntent } from '../src/slack-state.js';
import { sealAttioConnectIntent } from '../src/attio-state.js';

describe('connection document boundary', () => {
  it.each(['hubspot', 'slack', 'attio'] as const)('renders %s confirmation before exchanging the authorization', async provider => {
    const complete = vi.fn(async () => ({ portalId:'123', hubDomain:null, teamId:'T1', teamName:'Test' }));
    const state = { hubspot: sealHubspotConnectIntent, slack: sealSlackConnectIntent, attio: sealAttioConnectIntent }[provider]('a'.repeat(64), 'secret');
    const app = createApp({completeHubspotCallback:complete, completeSlackCallback:complete});
    const response = await app.request(`https://api.lifty.test/${provider}/callback?state=${state}&code=PRIVATE_CODE`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Checking your connection');
    expect(complete).not.toHaveBeenCalled();
  });
});

import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach } from 'vitest';
import { CONNECTION_FLOWS, CONFIRMATION_SCRIPT, createConfirmationRouter, connectionFetch, type ConnectionFlow } from '../src/connection-confirmation.js';
import { createOAuthConfirmation } from '../src/oauth-confirmation.js';
import { createWarmupSetup } from '../src/warmup-setup.js';
import { createAccountConnection } from '../src/account-connection.js';
const headers={origin:'https://api.lifty.test','content-type':'application/json','x-lifty-connection':'1'};
const flows=Object.keys(CONNECTION_FLOWS) as ConnectionFlow[];
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

it.each(flows)('%s uses a fast shell and contains transient status failures',async flow=>{
  const status=vi.fn().mockRejectedValueOnce(new Error('PRIVATE_UPSTREAM_BODY')).mockResolvedValueOnce({status:'pending'}).mockResolvedValueOnce({status:'connected',account:'verified@example.test'});
  const process=vi.fn(async()=>({status:'pending' as const}));
  const router=createConfirmationRouter(flow,{validate:()=>{},status,process});
  const path=CONNECTION_FLOWS[flow].path,key=['email','linkedin'].includes(flow)?'intent':'state';
  const res=await router.request(`https://api.lifty.test${path}?${key}=capability&code=PRIVATE_CODE`);
  expect(res.status).toBe(200);expect(process).not.toHaveBeenCalled();expect(status).not.toHaveBeenCalled();
  const html=await res.text();expect(html).not.toContain('PRIVATE_CODE');
  const script=html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  expect(res.headers.get('content-security-policy')).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`);
  for(const expected of [{status:'pending'},{status:'pending'},{status:'connected',account:'verified@example.test'}]){
    const check=await router.request(`https://api.lifty.test${path}/status`,{method:'POST',headers,body:JSON.stringify({state:'capability'})});
    expect(await check.json()).toEqual(expected);
  }
});
it('bounds stalled dependency work and preserves a pending result',async()=>{
  vi.useFakeTimers();
  vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
  const rawFetch=vi.fn((_input:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
    init!.signal!.addEventListener('abort',()=>reject(new Error('PRIVATE_CONNECTION_ERROR')),{once:true});
  }));
  const fetchImpl=connectionFetch(rawFetch as typeof fetch),logs:unknown[]=[];
  const router=createConfirmationRouter('email',{validate:()=>{},status:async()=>{await fetchImpl('https://api.unipile.test/account');return {status:'connected',account:null};}},{log:e=>logs.push(e)});
  const request=router.request('https://api.lifty.test/connect/email/return/status',{method:'POST',headers,body:'{"state":"capability"}'});
  await vi.advanceTimersByTimeAsync(8000);
  const response=await request;expect(response.status).toBe(202);expect(await response.json()).toEqual({status:'pending'});
  expect(logs).toMatchObject([{upstream_outcome:'timeout',outcome:'pending',elapsed_ms:8000}]);
  expect(JSON.stringify(logs)).not.toContain('PRIVATE');
});
it('logs the provider error code from a failed return, never its free text',async()=>{
  const logs:{provider_error?:string}[]=[];
  const router=createConfirmationRouter('email',{validate:()=>{},status:async()=>({status:'failed',reason:'provider'})},{log:e=>logs.push(e)});
  for(const errorType of ['api/account_restricted','PRIVATE detail from provider'])
    await router.request('https://api.lifty.test/connect/email/return/status',{method:'POST',headers,body:JSON.stringify({state:'capability',errorType})});
  expect(logs.map(x=>x.provider_error)).toEqual(['api/account_restricted',undefined]);
  expect(JSON.stringify(logs)).not.toContain('PRIVATE');
});
it('rejects cross-origin requests, extra fields, oversized input and secrets on status',async()=>{
  const work=vi.fn(async()=>({status:'pending' as const}));
  const router=createConfirmationRouter('slack',{validate:()=>{},status:work,process:work});
  for(const [supplied,body] of [[{...headers,origin:'https://evil.test'},'{"state":"capability"}'],[headers,'{"state":"capability","account_id":"forged"}'],[headers,JSON.stringify({state:'capability',code:'private'})],[headers,'x'.repeat(13000)]] as const){
    const response=await router.request('https://api.lifty.test/slack/callback/status',{method:'POST',headers:supplied,body});
    expect(await response.json()).toEqual({status:'failed',reason:'invalid'});
  }
  expect(work).not.toHaveBeenCalled();
});
it('registers every browser callback/return in the shared inventory, excluding provider webhooks',()=>{
  const setup=createWarmupSetup({publicBaseUrl:'https://api.lifty.test',serverKey:'s'.repeat(32),supabaseUrl:'https://db.test',publishableKey:'public',googleClientId:'client',googleClientSecret:'secret',mailivery:{apiKey:'key'}});
  const accounts=createAccountConnection({publicBaseUrl:'https://api.lifty.test',supabaseUrl:'https://db.test',publishableKey:'public',
    serverKeys:{email:'e'.repeat(32),linkedin:'l'.repeat(32)},provider:{v2:{accessToken:'token',applicationId:'app_1',hostedAuthOrigins:['https://connect.lifty.test']}}});
  const app=createApp({warmupSetup:setup,accounts:{connection:accounts,origin:'https://api.lifty.test',hostedOrigins:['https://connect.lifty.test']}});
  const browserRoutes=app.routes.filter(r=>r.method==='GET'&&/\/(callback|return)$/.test(r.path)).map(r=>r.path).sort();
  expect(browserRoutes).toEqual(Object.values(CONNECTION_FLOWS).map(x=>x.path).sort());
  const entries=app.routes.filter(r=>r.method==='GET'&&/^\/(hubspot|slack|attio|connect|warmup)\//.test(r.path)&&!browserRoutes.includes(r.path)).map(r=>r.path).sort();
  expect(entries).toEqual(Object.values(CONNECTION_FLOWS).flatMap(x=>[...x.entries]).sort());
  for(const path of browserRoutes)for(const stage of ['status','process'])expect(app.routes.some(r=>r.method==='POST'&&r.path===path+'/'+stage)).toBe(true);
});

it('keeps malformed dependency receipts pending instead of inventing an invalid account',async()=>{
  const adapter=createOAuthConfirmation({provider:'hubspot',origin:'https://api.lifty.test',supabaseUrl:'https://db.test',publishableKey:'public',
    open:()=> 'a'.repeat(64),complete:vi.fn(),fetchImpl:vi.fn(async()=>Response.json({unexpected:true})) as typeof fetch});
  const response=await createConfirmationRouter('hubspot',adapter).request('https://api.lifty.test/hubspot/callback/status',{
    method:'POST',headers,body:'{"state":"capability"}'});
  expect(response.status).toBe(202);expect(await response.json()).toEqual({status:'pending'});
});

function browser(href:string,fetchImpl:typeof fetch){
  const elements:Record<string,{textContent:string;hidden:boolean;href:string;target?:string;rel?:string;dataset:Record<string,string>;addEventListener:ReturnType<typeof vi.fn>}>=Object.fromEntries(['confirmation','confirmation-title','confirmation-detail','confirmation-spinner','confirmation-actions','confirmation-retry','confirmation-check','confirmation-reference'].map(k=>[k,{textContent:'',hidden:k==='confirmation-actions',href:'',dataset:{},addEventListener:vi.fn()}]));
  const warmup=href.includes('/warmup/');
  elements.confirmation!.dataset={prepare:String(new URL(href).searchParams.get('prepare')==='1'),label:warmup?'email warmup':'email',warmup:String(warmup),microsoft:String(href.includes('/warmup/microsoft/')),stateKey:href.includes('/connect/')?'intent':'state',
    ...(href.includes('/connect/email/')?{retry:'/connect/email'}:{})};
  const location={href};
  const history={replaceState:vi.fn((_state:unknown,_title:string,path:string)=>{location.href=new URL(path,location.href).href;})};
  const context={URL,AbortController,JSON,Date,Promise,setTimeout,clearTimeout,location,history,fetch:fetchImpl,document:{getElementById:(id:string)=>elements[id]}};
  return {elements,location,history,run:()=>runInNewContext(CONFIRMATION_SCRIPT,context) as Promise<void>};
}
it('keeps the Microsoft status page open during consent and shows verified warmup plus initial placement',async()=>{
  vi.useFakeTimers();let finished=false;const requests:string[]=[];
  const fetchImpl=vi.fn(async(input:unknown)=>{
    const stage=String(input).split('/').at(-1)!;requests.push(stage);
    return Response.json(finished?{status:'connected',account:'founder@example.test',placement:{when:'now',notify:['email']}}
      :{status:'pending',attention:'microsoft_sign_in'});
  }) as typeof fetch;
  const page=browser('https://api.lifty.test/warmup/microsoft/return?state=attempt&prepare=1',fetchImpl);
  const work=page.run();await vi.advanceTimersByTimeAsync(1500);
  expect(page.elements['confirmation-retry']).toMatchObject({textContent:'Continue with Microsoft',href:'/warmup/microsoft/sign-in?state=attempt',target:'_blank',rel:'noopener noreferrer'});
  expect(page.elements['confirmation-actions']!.hidden).toBe(false);
  expect(page.elements['confirmation-detail']!.textContent).toContain('Keep this page open');
  finished=true;await vi.runAllTimersAsync();await work;
  expect(requests.filter(x=>x==='process')).toHaveLength(1);
  expect(page.elements['confirmation-title']!.textContent).toBe('Warmup is running');
  expect(page.elements['confirmation-detail']!.textContent).toContain('one test email');
  expect(page.elements['confirmation-actions']!.hidden).toBe(true);
});
it.each(['microsoft_recovery','warmup_action'])('ends bounded checking with actionable %s, no false success or failure',async attention=>{
  vi.useFakeTimers();
  const page=browser('https://api.lifty.test/warmup/microsoft/return?state=attempt',vi.fn(async()=>Response.json({status:'pending',attention})) as typeof fetch);
  const work=page.run();await vi.runAllTimersAsync();await work;
  expect(page.elements['confirmation-check']!.hidden).toBe(false);
  expect(page.elements['confirmation-spinner']!.hidden).toBe(true);
  expect(page.elements['confirmation-actions']!.hidden).toBe(true);
  expect(page.elements['confirmation-title']!.textContent).not.toMatch(/running|connected|failed/);
});
it('submits a code once, survives a lost response, displays late success, and reload only reads status',async()=>{
  vi.useFakeTimers();const requests:{stage:string;body:Record<string,string>}[]=[];let checks=0;
  const fetchImpl=vi.fn(async(input:unknown,init?:RequestInit)=>{
    const stage=String(input).split('/').at(-1)!;requests.push({stage,body:JSON.parse(String(init!.body))});
    if(stage==='process')throw new Error('response lost after accepted');
    return Response.json(++checks<2?{status:'pending'}:{status:'connected',account:'<img onerror=alert(1)>@example.test'});
  }) as typeof fetch;
  const page=browser('https://api.lifty.test/hubspot/callback?state=capability&code=PRIVATE_CODE',fetchImpl);
  const work=page.run();await vi.runAllTimersAsync();await work;
  expect(page.history.replaceState).toHaveBeenCalled();expect(page.location.href).not.toContain('PRIVATE_CODE');
  expect(requests.filter(r=>r.stage==='process')).toEqual([{stage:'process',body:{state:'capability',code:'PRIVATE_CODE'}}]);
  expect(requests.filter(r=>r.stage==='status').every(r=>!('code' in r.body))).toBe(true);
  expect(page.elements['confirmation-title']!.textContent).toBe('email is connected');
  expect(page.elements['confirmation-detail']!.textContent).toContain('<img onerror=alert(1)>@example.test');
  const reload=browser(page.location.href,fetchImpl);const again=reload.run();await vi.runAllTimersAsync();await again;
  expect(requests.filter(r=>r.stage==='process')).toHaveLength(1);
});
it.each([
  [{when:'now',notify:['email','slack']},'You will get the result on Slack and by email, usually within 20 minutes.'],
  [{when:'now',notify:[]},'The result is usually ready in Lifty within 20 minutes.'],
  [{when:'after_warmup',notify:['email']},'When warmup ends, Lifty sends one test email from this mailbox to about 20 to 40 test inboxes and sends you the result by email.'],
])('warmup confirmation promises the placement test from the receipt (%j)',async(placement,promise)=>{
  vi.useFakeTimers();
  const receipt={status:'connected',account:'founder@example.test',placement};
  // The shared schema keeps the field the page needs.
  const router=createConfirmationRouter('warmup',{validate:()=>{},status:async()=>receipt as never});
  const check=await router.request(`https://api.lifty.test${CONNECTION_FLOWS.warmup.path}/status`,{method:'POST',headers,body:JSON.stringify({state:'capability'})});
  expect(await check.json()).toEqual(receipt);
  const page=browser('https://api.lifty.test/warmup/google/callback?state=capability',vi.fn(async()=>Response.json(receipt)) as typeof fetch);
  page.elements.confirmation!.dataset.warmup='true';
  const work=page.run();await vi.runAllTimersAsync();await work;
  expect(page.elements['confirmation-title']!.textContent).toBe('Warmup is running');
  expect(page.elements['confirmation-detail']!.textContent).toContain('Lifty verified founder@example.test.');
  expect(page.elements['confirmation-detail']!.textContent).toContain(promise);
});
// LIF-1282/LIF-1584: a known CRM refusal names its cause and next step, never "could not be verified".
it.each([
  ['account_in_use','This HubSpot account is connected in another Lifty workspace. Disconnect it there first'],
  ['account_mismatch','This is a different HubSpot account from the one connected to this workspace, so nothing changed. Try again and sign in to the same account.'],
  ['permission_missing','HubSpot did not grant every permission Lifty needs, so nothing changed. Try again and approve all requested permissions'],
  ['crm_provider_conflict','Another CRM is connected to this workspace. Disconnect it in Lifty before connecting HubSpot.'],
] as const)('names the %s refusal on the CRM page',async(reason,text)=>{
  vi.useFakeTimers();
  const page=browser('https://api.lifty.test/hubspot/callback?state=capability',vi.fn(async()=>Response.json({status:'failed',reason})) as typeof fetch);
  page.elements.confirmation!.dataset.label='HubSpot';
  const work=page.run();await vi.runAllTimersAsync();await work;
  expect(page.elements['confirmation-title']!.textContent).toBe('Connection needs attention');
  expect(page.elements['confirmation-detail']!.textContent).toContain(text);
  expect(page.elements['confirmation-detail']!.textContent).not.toContain('could not be verified');
});
it('a failed status transport never navigates away or spins forever',async()=>{
  vi.useFakeTimers();
  const fetchImpl=vi.fn(async()=>new Response('Bad gateway',{status:502})) as typeof fetch;
  const page=browser('https://api.lifty.test/connect/email/return?intent=capability&state=forged',fetchImpl);
  const work=page.run();await vi.runAllTimersAsync();await work;
  expect(page.elements['confirmation-title']!.textContent).toBe('Still checking');expect(page.elements['confirmation-spinner']!.hidden).toBe(true);
  expect(page.location.href).toBe('https://api.lifty.test/connect/email/return?intent=capability');
  expect(vi.mocked(fetchImpl).mock.calls.length).toBeLessThan(20);
});
it('explains a refusal with a retry of the same attempt, keeps listening and shows a late success',async()=>{
  vi.useFakeTimers();const bodies:Record<string,string>[]=[];let connected=false;
  const fetchImpl=vi.fn(async(_input:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init!.body)));
    return Response.json(connected?{status:'connected',account:null}:{status:'pending',attention:'released'});}) as typeof fetch;
  const page=browser('https://api.lifty.test/connect/email/return?intent=capability&error_type=api/already_exists&error_detail=acc_old&error_title=PRIVATE',fetchImpl);
  const work=page.run();await vi.advanceTimersByTimeAsync(1);
  expect(bodies[0]).toEqual({state:'capability',errorType:'api/already_exists',errorDetail:'acc_old'});
  expect(page.elements['confirmation-title']!.textContent).toBe('Try connecting again');
  expect(page.elements['confirmation-detail']!.textContent).toContain('Lifty removed that old link');
  expect(page.elements['confirmation-actions']!.hidden).toBe(false);expect(page.elements['confirmation-spinner']!.hidden).toBe(true);
  expect(page.elements['confirmation-retry']!.href).toBe('/connect/email?intent=capability');
  // Only the state and the safe refusal hints survive, so a reload explains the same refusal.
  expect(page.location.href).toBe('https://api.lifty.test/connect/email/return?intent=capability&error_type=api%2Falready_exists&error_detail=acc_old');
  connected=true;await vi.runAllTimersAsync();await work;
  expect(page.elements['confirmation-title']!.textContent).toBe('email is connected');expect(page.elements['confirmation-actions']!.hidden).toBe(true);
});
it('never forwards a refusal detail that is not an account id, and offers no retry without an entry',async()=>{
  vi.useFakeTimers();const bodies:Record<string,string>[]=[];
  const fetchImpl=vi.fn(async(_input:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init!.body)));return Response.json({status:'pending',attention:'provider'});}) as typeof fetch;
  const page=browser('https://api.lifty.test/connect/linkedin/return?intent=capability&error_type=api/already_exists&error_detail=PRIVATE%20text',fetchImpl);
  const work=page.run();await vi.runAllTimersAsync();await work;
  expect(bodies.every(body=>!('errorDetail' in body))).toBe(true);expect(page.location.href).not.toContain('PRIVATE');
  expect(page.elements['confirmation-title']!.textContent).toBe('The sign-in did not finish');expect(page.elements['confirmation-actions']!.hidden).toBe(true);
});
it('waits for a warmup handoff that is starting instead of timing out, and shows when warmup runs',async()=>{
  vi.useFakeTimers();const started=Date.now();
  const fetchImpl=vi.fn(async(input:unknown)=>Response.json(String(input).endsWith('/process')||Date.now()-started<12*60000
    ?{status:'pending',attention:'starting'}:{status:'connected',account:'founder@example.test'})) as typeof fetch;
  const page=browser('https://api.lifty.test/warmup/google/callback?state=capability&code=PRIVATE_CODE',fetchImpl);
  const work=page.run();await vi.advanceTimersByTimeAsync(5*60000);
  expect(page.elements['confirmation-title']!.textContent).toBe('Starting warmup');expect(page.elements['confirmation-spinner']!.hidden).toBe(false);
  expect(page.elements['confirmation-actions']!.hidden).toBe(true);
  await vi.runAllTimersAsync();await work;
  expect(page.elements['confirmation-title']!.textContent).toBe('Warmup is running');
  expect(vi.mocked(fetchImpl).mock.calls.length).toBeLessThan(40);
});
it('stops waiting for a starting warmup after 25 minutes without inventing a result',async()=>{
  vi.useFakeTimers();
  const fetchImpl=vi.fn(async()=>Response.json({status:'pending',attention:'starting'})) as typeof fetch;
  const page=browser('https://api.lifty.test/warmup/google/callback?state=capability',fetchImpl);
  const work=page.run();await vi.runAllTimersAsync();await work;
  expect(page.elements['confirmation-title']!.textContent).toBe('Still checking');expect(page.elements['confirmation-spinner']!.hidden).toBe(true);
  expect(vi.mocked(fetchImpl).mock.calls.length).toBeLessThan(70);
});
it.each(['hubspot','slack','attio'] as const)('%s never repeats an exchanged code and reads durable success after a lost response',async provider=>{
  let claimed=false,connected=false;const complete=vi.fn(async()=>{connected=true;throw new Error('lost store response');});
  const fetchImpl=vi.fn(async(_url:unknown,init?:RequestInit)=>{
    const args=JSON.parse(String(init!.body));expect(args.p_intent_token).toBe('a'.repeat(64));
    const result=connected?{status:'connected',account:null}:{status:'pending'};
    const claim=args.p_operation==='claim'&&!claimed;if(claim)claimed=true;
    return Response.json({result,claimed:claim});
  }) as typeof fetch;
  const adapter=createOAuthConfirmation({provider,origin:'https://api.lifty.test',supabaseUrl:'https://db.test',publishableKey:'public',open:()=> 'a'.repeat(64),complete,fetchImpl});
  const router=createConfirmationRouter(provider,adapter);
  for(let i=0;i<2;i++){
    const response=await router.request(`https://api.lifty.test/${provider}/callback/process`,{method:'POST',headers,body:'{"state":"capability","code":"private"}'});
    expect(await response.json()).toEqual({status:'connected',account:null});
  }
  expect(complete).toHaveBeenCalledTimes(1);
});

it('prepares a sending-account link once after the shell, then offers a same-attempt sign-in action',async()=>{
  vi.useFakeTimers();const requests:string[]=[];
  const fetchImpl=vi.fn(async(input:unknown)=>{
    requests.push(String(input));
    return Response.json({status:'pending',progress:{stage:'sign_in_required'},reference:'11111111-1111-4111-8111-111111111111'});
  }) as typeof fetch;
  const page=browser('https://api.lifty.test/connect/email/return?intent=capability&prepare=1',fetchImpl);
  const work=page.run();await vi.runAllTimersAsync();await work;
  expect(requests.filter(path=>path.endsWith('/process'))).toHaveLength(1);
  expect(page.elements['confirmation-title']!.textContent).toBe('Ready to sign in');
  expect(page.elements['confirmation-retry']!.textContent).toBe('Continue to sign in');
  expect(page.elements['confirmation-retry']!.href).toBe('/connect/email?intent=capability');
  expect(page.elements['confirmation-actions']!.hidden).toBe(false);
  expect(page.elements['confirmation-reference']!.textContent).toContain('11111111-1111-4111-8111-111111111111');
  expect(page.elements['confirmation-check']!.hidden).toBe(false);
});
it.each(['email','linkedin'])('waits for delayed %s authorization after return without reopening the used sign-in',async channel=>{
  vi.useFakeTimers();let connected=false;
  const requests:{path:string;body:unknown}[]=[];
  const fetchImpl=vi.fn(async(input:unknown,init?:RequestInit)=>{
    requests.push({path:String(input),body:JSON.parse(String(init!.body))});
    return Response.json(connected?{status:'connected',account:null}
      :{status:'pending',progress:{stage:'sign_in_required'},reference:'11111111-1111-4111-8111-111111111111'});
  }) as typeof fetch;
  const returned=(href:string)=>{
    const page=browser(href,fetchImpl);
    page.elements.confirmation!.dataset.retry=`/connect/${channel}`;
    page.elements.confirmation!.dataset.label=channel==='email'?'email':'LinkedIn';
    return page;
  };
  const page=returned(`https://api.lifty.test/connect/${channel}/return?intent=capability&account_id=acc_private`);
  const work=page.run();await vi.advanceTimersByTimeAsync(1);
  expect(page.elements['confirmation-title']!.textContent).toBe('Checking your connection');
  expect(page.elements['confirmation-actions']!.hidden).toBe(true);
  expect(page.elements['confirmation-spinner']!.hidden).toBe(false);
  await vi.runAllTimersAsync();await work;
  expect(page.elements['confirmation-title']!.textContent).toBe('Still checking');
  expect(page.elements['confirmation-check']!.hidden).toBe(false);
  expect(page.elements['confirmation-actions']!.hidden).toBe(true);
  expect(page.location.href).not.toContain('acc_private');

  const reload=returned(page.location.href),again=reload.run();await vi.advanceTimersByTimeAsync(1);
  expect(reload.elements['confirmation-title']!.textContent).toBe('Checking your connection');
  expect(reload.elements['confirmation-actions']!.hidden).toBe(true);
  connected=true;await vi.runAllTimersAsync();await again;
  expect(reload.elements['confirmation-title']!.textContent).toBe(channel==='email'?'email is connected':'LinkedIn is connected');
  expect(reload.elements['confirmation-actions']!.hidden).toBe(true);
  expect(requests.every(request=>request.path.endsWith('/status'))).toBe(true);
  expect(requests.every(request=>Object.keys(request.body as object).join() === 'state')).toBe(true);
  expect(requests.length).toBeLessThan(40);
});
it('waits for one preparation and keeps checking until a sign-in that could not open opens',async()=>{
  vi.useFakeTimers();let open=false;const requests:string[]=[];let processDone=false,statusDuringProcess=false;
  const unavailable={status:'pending',progress:{stage:'preparing'},reference:'11111111-1111-4111-8111-111111111111'};
  const fetchImpl=vi.fn(async(input:unknown)=>{
    const path=String(input);requests.push(path);
    if(path.endsWith('/process')){await new Promise(resolve=>setTimeout(resolve,3000));processDone=true;return Response.json(unavailable);}
    if(!processDone)statusDuringProcess=true;
    return Response.json(open?{status:'pending',progress:{stage:'sign_in_required'},reference:'11111111-1111-4111-8111-111111111111'}:unavailable);
  }) as typeof fetch;
  const page=browser('https://api.lifty.test/connect/email/return?intent=capability&prepare=1',fetchImpl);
  const work=page.run();await vi.advanceTimersByTimeAsync(3000);
  expect(page.elements['confirmation-title']!.textContent).toBe('Preparing sign-in');
  expect(page.elements['confirmation-reference']!.textContent).toContain('11111111-1111-4111-8111-111111111111');
  open=true;await vi.runAllTimersAsync();await work;
  expect(page.elements['confirmation-title']!.textContent).toBe('Ready to sign in');
  expect(page.elements['confirmation-retry']!.textContent).toBe('Continue to sign in');
  expect(requests.filter(path=>path.endsWith('/process'))).toHaveLength(1);
  expect(statusDuringProcess).toBe(false);
});
it('preserves a provider refusal instead of preparing again or redirecting into a loop',async()=>{
  vi.useFakeTimers();
  const requests:string[]=[];
  const refused=browser('https://api.lifty.test/connect/email/return?intent=capability&prepare=1&error_type=api/already_exists',vi.fn(async(input:unknown)=>{
    requests.push(String(input));return Response.json({status:'pending',progress:{stage:'sign_in_required'},attention:'exists'});
  }) as typeof fetch);
  const refusal=refused.run();await vi.runAllTimersAsync();await refusal;
  expect(refused.elements['confirmation-title']!.textContent).toBe('This account is already linked');
  expect(requests.every(path=>path.endsWith('/status'))).toBe(true);
  expect(refused.location.href).toContain('/return?');
});
it.each(['prepare=2','prepare=1&prepare=1'])('rejects invalid preparation markers before work: %s',async marker=>{
  const work=vi.fn(async()=>({status:'pending' as const}));
  const router=createConfirmationRouter('email',{validate:()=>{},status:work,process:work});
  const response=await router.request('https://api.lifty.test/connect/email/return?intent=capability&'+marker);
  expect(await response.text()).not.toContain('<script>');expect(work).not.toHaveBeenCalled();
});

it('rechecking the same preparing state restores the live view and ignores overlapping clicks',async()=>{
  vi.useFakeTimers();let requests=0;
  const page=browser('https://api.lifty.test/connect/email/return?intent=capability',vi.fn(async()=>{
    requests++;return Response.json({status:'pending',progress:{stage:'preparing'}});
  }) as typeof fetch);
  const work=page.run();await vi.runAllTimersAsync();await work;
  expect(page.elements['confirmation-title']!.textContent).toBe('Sign-in has not opened yet');
  const click=page.elements['confirmation-check']!.addEventListener.mock.calls[0]![1] as ()=>void;
  const before=requests;click();click();await vi.advanceTimersByTimeAsync(1);
  expect(requests-before).toBe(1);
  expect(page.elements['confirmation-title']!.textContent).toBe('Preparing sign-in');
  expect(page.elements['confirmation-spinner']!.hidden).toBe(false);
  await vi.runAllTimersAsync();
});
it('correlates regenerated browser links to the same non-secret attempt and logs its stage',async()=>{
  const logs:unknown[]=[],reference='11111111-1111-4111-8111-111111111111';
  let connected=false;
  const router=createConfirmationRouter('email',{validate:()=>{},status:async()=>connected?{status:'connected',account:null,reference}:{status:'pending',reference,
    progress:{stage:'preparing'}}},{log:event=>logs.push(event)});
  for(const state of ['secret-link-one','secret-link-two'])await router.request('https://api.lifty.test/connect/email/return/status',
    {method:'POST',headers,body:JSON.stringify({state})});
  const expected={correlation:createHash('sha256').update('email\0'+reference).digest('hex').slice(0,24),reference,
    progress_stage:'preparing'};
  connected=true;
  await router.request('https://api.lifty.test/connect/email/return/status',{method:'POST',headers,body:JSON.stringify({state:'secret-link-three'})});
  expect(logs).toMatchObject([expected,expected,{correlation:expected.correlation,reference,outcome:'connected'}]);
  expect(JSON.stringify(logs)).not.toContain('secret-link');
});

it.each(['google/callback','microsoft/return'])('renders a warmup refusal and next step on the %s page',async path=>{
  vi.useFakeTimers();
  const page=browser(`https://api.lifty.test/warmup/${path}?state=capability`,async()=>Response.json({status:'failed',reason:'mailbox_in_other_warmup'}));
  await page.run();await vi.runAllTimersAsync();
  expect(page.elements['confirmation-detail']!.textContent).toBe('This mailbox is already registered with another warmup service. Remove it there, then start warmup again in Lifty.');
  expect(page.elements['confirmation-detail']!.textContent).not.toMatch(/Mailivery/);
  expect(page.elements['confirmation-spinner']!.hidden).toBe(true);
});
