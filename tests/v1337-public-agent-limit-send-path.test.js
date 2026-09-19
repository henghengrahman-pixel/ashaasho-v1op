import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LiveChatClient } from '../src/livechat.js';

function lcError(status,message){const e=new Error(`LIVECHAT_${status}: ${message}`);e.status=status;return e;}

test('v1.33.7 send 403 requester-not-member never calls add_user_to_chat or resends',async()=>{
  const calls=[];
  const lc=new LiveChatClient({base:'http://local',accountId:'agent@example.com',requesterUserId:'agent@example.com',pat:'p'});
  lc.call=async(action,body,options)=>{
    calls.push({action,body,options});
    if(action==='send_event') throw lcError(403,'Requester is not user of the chat');
    throw new Error(`unexpected membership mutation: ${action}`);
  };
  await assert.rejects(()=>lc.sendMessage('chat-1','halo'),e=>{
    assert.equal(e.code,'LIVECHAT_MEMBERSHIP_REQUIRED');
    assert.equal(e.status,403);
    assert.equal(e.retryable,false);
    return true;
  });
  assert.deepEqual(calls.map(x=>x.action),['send_event']);
});

test('v1.33.7 explicit membership path still maps provider capacity to PUBLIC_AGENT_LIMIT',async()=>{
  const calls=[];
  const lc=new LiveChatClient({base:'http://local',accountId:'agent@example.com',requesterUserId:'agent@example.com',pat:'p'});
  lc.call=async(action)=>{calls.push(action);if(action==='add_user_to_chat')throw lcError(422,'Public agents in chat limit reached');throw new Error(`unexpected:${action}`);};
  await assert.rejects(()=>lc.ensureRequesterInChat('chat-1'),e=>e.code==='LIVECHAT_PUBLIC_AGENT_LIMIT'&&e.retryable===false);
  assert.deepEqual(calls,['add_user_to_chat']);
});

test('v1.33.7 stale automatic CLAIM_CHAT sources are explicitly separated from manual claims',()=>{
  const src=fs.readFileSync(new URL('../src/livechat-ingress.js',import.meta.url),'utf8');
  assert.match(src,/\['poll','poll_unchanged','deep_sync'\]\.includes/);
  assert.match(src,/return !isAutomaticClaimSource\(source\) \|\| Boolean\(autoClaimEnabled\)/);
});

test('v1.33.7 ingress drains old auto-claim jobs before provider claimChat',()=>{
  const src=fs.readFileSync(new URL('../src/livechat-ingress.js',import.meta.url),'utf8');
  const claim=src.slice(src.indexOf("if(type==='CLAIM_CHAT')"),src.indexOf("if(type==='SYNC_CHAT')"));
  assert.match(claim,/AUTO_CLAIM_DISABLED/);
  assert.ok(claim.indexOf('shouldRunClaimJob') < claim.indexOf('livechat.claimChat'));
});

test('v1.33.7 engine treats provider membership rejection as non-retryable and demotes to SUPERVISED',()=>{
  const src=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  assert.match(src,/function isLiveChatMembershipRequiredError/);
  assert.match(src,/publicAgentLimit \|\| membershipRequired/);
  assert.match(src,/setConversationLane\(chatId,'SUPERVISED'\)/);
  assert.match(src,/membershipMutationAttempted:false/);
  assert.match(src,/if\(err\.retryable===false\)return false/);
});

test('v1.33.7 customer event is not marked successful by fallback when membership is unavailable',()=>{
  const src=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  const marker=src.indexOf("eventType:'AI_SEND_BLOCKED_BY_PROVIDER_MEMBERSHIP'");
  assert.ok(marker>0);
  const nearby=src.slice(marker-450,marker+700);
  assert.match(nearby,/throw e/);
  assert.doesNotMatch(nearby,/safeHoldingReplyForIntent/);
});

test('v1.33.7 Telegram membership/capacity failure keeps ticket open without asking operator to spam CTA',()=>{
  const src=fs.readFileSync(new URL('../src/human-bridge.js',import.meta.url),'utf8');
  const marker=src.indexOf('TELEGRAM_ACTION_BLOCKED_BY_PROVIDER_MEMBERSHIP');
  assert.ok(marker>0);
  const nearby=src.slice(marker-900,marker+1300);
  assert.match(nearby,/setConversationLane\(request\.chat_id,'SUPERVISED'\)/);
  assert.match(nearby,/Jangan tekan CTA berulang/);
  assert.match(nearby,/HANDLE WITH AI/);
});

test('v1.33.7 normal workflow topic switch is case audit, not production error log',()=>{
  const src=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  const resolver=src.slice(src.indexOf('async function resolveContextualIntent'),src.indexOf('function normalizeBrain'));
  assert.match(resolver,/eventType:'OPERATIONAL_TOPIC_SWITCH'/);
  assert.doesNotMatch(resolver,/logError\('engine','OPERATIONAL_TOPIC_SWITCH'/);
});
