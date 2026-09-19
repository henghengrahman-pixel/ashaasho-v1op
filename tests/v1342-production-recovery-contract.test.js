import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LiveChatClient} from '../src/livechat.js';
import {classifyCustomerEventError} from '../src/event-retry.js';
import {OpenAIClient} from '../src/ai.js';

function makeLiveChat(){return new LiveChatClient({base:'http://local',accountId:'acct',requesterUserId:'bot@example.com',pat:'pat',claimVerifyDelaysMs:[0]});}
function providerError(status,message){const e=new Error(`LIVECHAT_${status}: ${message}`);e.status=status;e.data={error:{message}};return e;}

test('provider 422 id-required is attributed to follow_chat and retries only with provider-requested id contract',async()=>{
  const lc=makeLiveChat(); const calls=[];
  lc.call=async(action,body)=>{
    calls.push({action,body});
    if(action==='follow_chat' && body.chat_id) throw providerError(422,'`id` is required');
    if(action==='follow_chat' && body.id==='c1') return {ok:true};
    throw new Error(`unexpected:${action}`);
  };
  await lc.followChat('c1');
  assert.deepEqual(calls,[
    {action:'follow_chat',body:{chat_id:'c1'}},
    {action:'follow_chat',body:{id:'c1'}}
  ]);
});

test('provider 422 id-required membership action retries with id while preserving requester fields',async()=>{
  const lc=makeLiveChat(); const calls=[];
  lc.call=async(action,body)=>{
    calls.push({action,body});
    if(action==='add_user_to_chat' && body.chat_id) throw providerError(422,'id is required');
    if(action==='add_user_to_chat' && body.id==='c2') return {ok:true};
    throw new Error(`unexpected:${action}`);
  };
  const out=await lc.ensureRequesterInChat('c2');
  assert.equal(out.added,true);
  assert.equal(calls.length,2);
  assert.deepEqual(Object.keys(calls[1].body).sort(),['id','ignore_requester_presence','user_id','user_type','visibility'].sort());
  assert.equal(calls[1].body.user_id,'bot@example.com');
});

test('unrelated 422 is never rewritten into id fallback',async()=>{
  const lc=makeLiveChat(); const calls=[];
  lc.call=async(action,body)=>{calls.push({action,body});throw providerError(422,'`user_id` not found');};
  await assert.rejects(()=>lc.ensureRequesterInChat('c3'),e=>e.code==='LIVECHAT_REQUESTER_USER_ID_INVALID');
  assert.equal(calls.length,1);
  assert.ok('chat_id' in calls[0].body);
  assert.ok(!('id' in calls[0].body));
});

test('claim becomes MY_CHAT only after read-after-write proves requester membership',async()=>{
  const lc=makeLiveChat(); const calls=[];
  lc.call=async(action,body)=>{
    calls.push({action,body});
    if(action==='follow_chat'||action==='add_user_to_chat') return {};
    if(action==='get_chat') return {chat:{id:'c4',is_followed:true,users:[{id:'bot@example.com',type:'agent'}],threads:[{id:'t4',active:true,events:[]}]}};
    throw new Error(`unexpected:${action}`);
  };
  const out=await lc.claimChat('c4',{knownChat:{id:'c4',is_followed:false,last_thread_summary:{active:true}}});
  assert.equal(out.lane,'MY_CHAT');
  assert.equal(out.membershipVerified,true);
  assert.equal(out.claimVerification.observations.at(-1).requesterPresent,true);
});

test('followed state without provider membership evidence is never promoted to MY_CHAT',async()=>{
  const lc=makeLiveChat();
  lc.call=async(action)=>{
    if(action==='add_user_to_chat') return {};
    if(action==='get_chat') return {chat:{id:'c5',is_followed:true,threads:[{id:'t5',active:true,events:[]}]}};
    throw new Error(`unexpected:${action}`);
  };
  const out=await lc.claimChat('c5',{knownChat:{id:'c5',is_followed:true,last_thread_summary:{active:true}}});
  assert.equal(out.membershipVerified,false);
  assert.equal(out.lane,'OTHER');
});

test('customer-event errors are classified and bounded rather than hot-looped',()=>{
  const ownership=classifyCustomerEventError(new Error('LIVECHAT_MEMBERSHIP_REQUIRED'),1);
  assert.equal(ownership.errorClass,'OWNERSHIP');assert.ok(ownership.delayMs>=120000);
  const stale=classifyCustomerEventError(new Error('LIVECHAT_CHAT_INACTIVE'),1);
  assert.equal(stale.terminal,true);assert.equal(stale.retryable,false);
  const parseFirst=classifyCustomerEventError(new Error('AI_JSON_PARSE_FAILED'),1);
  const parseSecond=classifyCustomerEventError(new Error('AI_JSON_PARSE_FAILED'),2);
  assert.equal(parseFirst.retryable,true);assert.equal(parseSecond.terminal,true);
  const transient=classifyCustomerEventError(new Error('HTTP 503 temporary provider unavailable'),3);
  assert.equal(transient.errorClass,'TRANSIENT');assert.ok(transient.delayMs>1000);
});

test('queue source contains transactional latest-state-wins sync coalescing and safe backlog recovery',()=>{
  const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
  assert.match(db,/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(db,/SUPERSEDED_BY_NEWER_SYNC/);
  assert.match(db,/RECOVERY_SUPERSEDED_SYNC/);
  assert.match(db,/RECOVERY_STALE_CLOSED_CLAIM/);
  const start=db.indexOf('export async function recoverLiveChatIngressBacklog');
  const end=db.indexOf('export async function claimLiveChatIngressJobs',start);
  const block=db.slice(start,end);
  assert.doesNotMatch(block,/customer_event_processing/);
  assert.doesNotMatch(block,/DELETE FROM livechat_ingress_jobs/);
  const ingress=fs.readFileSync(new URL('../src/livechat-ingress.js',import.meta.url),'utf8');
  const claimStart=ingress.indexOf("if(type==='CLAIM_CHAT')");
  const claimEnd=ingress.indexOf("if(type==='SYNC_CHAT')",claimStart);
  const claimBlock=ingress.slice(claimStart,claimEnd);
  assert.match(claimBlock,/withChatLock\(chatId/);
});

test('vision compatibility fallback is two-stage and final decision still uses strict schema',()=>{
  const ai=fs.readFileSync(new URL('../src/ai.js',import.meta.url),'utf8');
  const start=ai.indexOf('async completeVisionStructured');
  const end=ai.indexOf('async repairAgentStructured',start);
  const block=ai.slice(start,end);
  assert.match(block,/CONTROLLED IMAGE OBSERVATION/);
  assert.match(block,/this\.completeStructured\(system/);
  assert.match(block,/Production instances use this class implementation and therefore take JSON Schema/);
  const compatCatch=block.slice(block.indexOf('}catch(e){'));
  assert.doesNotMatch(compatCatch,/return this\.completeVision\(system,text,attachments\)/);
});

test('unrecoverable agent structured output returns safe escalation and never throws AI_JSON_PARSE_FAILED',async()=>{
  const c=new OpenAIClient();
  c.completeVisionStructured=async()=>({text:'not-json',usage:{output_tokens:5},raw:{status:'completed'}});
  c.completeStructured=async()=>({text:'still-not-json',usage:{output_tokens:5},raw:{status:'completed'}});
  const out=await c.decideAgent({input:{state:'BOT_ACTIVE',currentIntent:'GENERAL',rawMessages:['halo'],normalizedMessages:['halo'],attachments:[]}});
  assert.equal(out.action,'ESCALATE_HUMAN');
  assert.equal(out.reason,'STRUCTURED_OUTPUT_UNRECOVERABLE_SAFE_FALLBACK');
});
