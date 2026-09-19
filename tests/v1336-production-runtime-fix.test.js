import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {OpenAIClient,CONVERSATION_DIGEST_SCHEMA} from '../src/ai.js';
import {resolveGreetingSessionIdentity} from '../src/session-identity.js';

const root=new URL('..',import.meta.url);
const aiSource=fs.readFileSync(new URL('../src/ai.js',import.meta.url),'utf8');

function readConfigWith(extraEnv={}){
  const code=`import {config} from './src/config.js'; process.stdout.write(JSON.stringify({enabled:config.lcAutoClaimQueued,requested:config.lcAutoClaimQueuedRequested,ack:config.lcAutoClaimQueuedPolicyAck}));`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:new URL('..',import.meta.url),env:{...process.env,LIVECHAT_AUTO_CLAIM_QUEUED:'',LIVECHAT_AUTO_CLAIM_QUEUED_POLICY_ACK:'',...extraEnv},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  return JSON.parse(r.stdout);
}

test('queued auto claim is enabled by default through the bounded CLAIM_CHAT path',()=>{
  const v=readConfigWith();
  assert.equal(v.requested,true); assert.equal(v.ack,true); assert.equal(v.enabled,true);
});

test('queued auto claim can be explicitly disabled without changing send_event membership safety',()=>{
  const v=readConfigWith({LIVECHAT_AUTO_CLAIM_QUEUED:'false'});
  assert.equal(v.requested,false); assert.equal(v.enabled,false);
});

test('policy ack can independently stop automatic claiming',()=>{
  const v=readConfigWith({LIVECHAT_AUTO_CLAIM_QUEUED:'true',LIVECHAT_AUTO_CLAIM_QUEUED_POLICY_ACK:'false'});
  assert.equal(v.requested,true); assert.equal(v.ack,false); assert.equal(v.enabled,false);
});

test('explicit enabled policy remains supported',()=>{
  const v=readConfigWith({LIVECHAT_AUTO_CLAIM_QUEUED:'true',LIVECHAT_AUTO_CLAIM_QUEUED_POLICY_ACK:'true'});
  assert.equal(v.requested,true); assert.equal(v.ack,true); assert.equal(v.enabled,true);
});

test('conversation digest uses strict structured output instead of raw complete plus parse',()=>{
  const block=aiSource.slice(aiSource.indexOf('async digestConversation'),aiSource.indexOf('async decideAgent'));
  assert.match(block,/completeStructured/);
  assert.match(block,/CONVERSATION_DIGEST_SCHEMA/);
  assert.doesNotMatch(block,/this\.complete\(/);
  assert.deepEqual(CONVERSATION_DIGEST_SCHEMA.required,['summary','current_problem','known_facts','missing_info','staff_actions','member_mood','unresolved']);
});

test('invalid digest JSON is repaired through structured schema',async()=>{
  let calls=0;
  class C extends OpenAIClient{
    ready(){return true;}
    async completeStructured(){
      calls++;
      if(calls===1)return {text:'{broken',usage:{out:1}};
      return {text:JSON.stringify({summary:'kronologi',current_problem:'wd',known_facts:['id ada'],missing_info:[],staff_actions:['cek'],member_mood:'tenang',unresolved:true}),usage:{out:2}};
    }
  }
  const out=await new C().digestConversation({history:'MEMBER: wd belum masuk'});
  assert.equal(out.fallback,false); assert.equal(out.repaired,true); assert.equal(calls,2);
  assert.equal(JSON.parse(out.digest).current_problem,'wd');
});

test('unrecoverable digest output returns deterministic valid fallback and never throws AI_JSON_PARSE_FAILED',async()=>{
  class C extends OpenAIClient{ready(){return true;} async completeStructured(){return {text:'not-json'};}}
  const out=await new C().digestConversation({history:'MEMBER: wd belum masuk\nCS: sedang dicek',previousDigest:''});
  assert.equal(out.fallback,true); assert.equal(out.reason,'DIGEST_STRUCTURED_OUTPUT_FALLBACK');
  const parsed=JSON.parse(out.digest);
  assert.match(parsed.summary,/wd belum masuk/); assert.equal(parsed.unresolved,true);
});

test('structured responses reserve enough output ceiling for required JSON keys',()=>{
  assert.match(aiSource,/const structuredMax=Math\.max\(config\.openaiMaxOutput,640/);
});

test('welcome without provider thread has greeting key but no session boundary identity',()=>{
  const x=resolveGreetingSessionIdentity({eventId:'evt-1',createdAt:'2026-09-19T07:00:00Z'});
  assert.equal(x.providerThreadKey,null); assert.equal(x.boundarySource,null); assert.equal(x.greetingKey,'welcome:evt-1');
});

test('provider thread yields stable session boundary identity independent of welcome event id',()=>{
  const a=resolveGreetingSessionIdentity({threadId:'THREAD-7',eventId:'evt-1'});
  const b=resolveGreetingSessionIdentity({threadId:'THREAD-7',eventId:'evt-999'});
  assert.equal(a.providerThreadKey,'thread:THREAD-7'); assert.equal(a.boundarySource,'LIVECHAT_THREAD_ID');
  assert.equal(a.providerThreadKey,b.providerThreadKey); assert.equal(a.greetingKey,b.greetingKey);
});
