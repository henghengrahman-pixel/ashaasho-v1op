import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {sendHumanBridgeWithControlledClaim} from '../src/human-bridge-delivery.js';

function membershipError(){
  const e=new Error('LIVECHAT_MEMBERSHIP_REQUIRED: requester is not a user of this chat');
  e.code='LIVECHAT_MEMBERSHIP_REQUIRED'; e.status=403; e.retryable=false;
  return e;
}
function publicLimit(){
  const e=new Error('LIVECHAT_PUBLIC_AGENT_LIMIT: Public agents in chat limit reached');
  e.code='LIVECHAT_PUBLIC_AGENT_LIMIT'; e.status=422; e.retryable=false;
  return e;
}

test('Human Bridge controlled recovery claims once then retries delivery once',async()=>{
  const calls=[]; let sends=0; let claimedHook=0;
  const livechat={
    claimChat:async(id,opt)=>{calls.push(['claimChat',id,opt]);return{ok:true,lane:'MY_CHAT',claimMutation:{followChangedByClaim:true}};},
    rollbackClaimFollow:async()=>{calls.push(['rollback']);}
  };
  const out=await sendHumanBridgeWithControlledClaim({
    livechat,chatId:'c1',
    send:async()=>{sends++;calls.push(['send',sends]);if(sends===1)throw membershipError();return{event_id:'evt-1'};},
    onClaimed:async claim=>{claimedHook++;assert.equal(claim.lane,'MY_CHAT');}
  });
  assert.equal(out.recovered,true);
  assert.equal(out.sent.event_id,'evt-1');
  assert.equal(sends,2);
  assert.equal(claimedHook,1);
  assert.equal(calls.filter(x=>x[0]==='claimChat').length,1);
  assert.equal(calls.filter(x=>x[0]==='rollback').length,0);
});

test('Human Bridge does not claim when first send already succeeds',async()=>{
  let claims=0;
  const livechat={claimChat:async()=>{claims++;return{lane:'MY_CHAT'};}};
  const out=await sendHumanBridgeWithControlledClaim({livechat,chatId:'c2',send:async()=>({event_id:'evt-ok'})});
  assert.equal(out.recovered,false);assert.equal(claims,0);assert.equal(out.sent.event_id,'evt-ok');
});

test('Human Bridge never retries send when controlled claim hits PUBLIC_AGENT_LIMIT',async()=>{
  let sends=0,claims=0;
  const livechat={claimChat:async()=>{claims++;throw publicLimit();}};
  await assert.rejects(()=>sendHumanBridgeWithControlledClaim({livechat,chatId:'c3',send:async()=>{sends++;throw membershipError();}}),e=>e.code==='LIVECHAT_PUBLIC_AGENT_LIMIT');
  assert.equal(sends,1);assert.equal(claims,1);
});

test('Human Bridge rolls back claim follow when provider ownership is still not MY_CHAT',async()=>{
  let sends=0,rollbacks=0;
  const claim={lane:'SUPERVISED',claimMutation:{followChangedByClaim:true}};
  const livechat={
    claimChat:async()=>claim,
    rollbackClaimFollow:async(id,result,opt)=>{rollbacks++;assert.equal(id,'c4');assert.equal(result,claim);assert.equal(opt.reason,'HUMAN_BRIDGE_OWNERSHIP_NOT_CONFIRMED');return{attempted:true,ok:true};}
  };
  await assert.rejects(()=>sendHumanBridgeWithControlledClaim({livechat,chatId:'c4',send:async()=>{sends++;throw membershipError();}}),e=>e.code==='LIVECHAT_CLAIM_OWNERSHIP_NOT_CONFIRMED');
  assert.equal(sends,1);assert.equal(rollbacks,1);
});

test('Human Bridge recovery never loops if retry is still membership-required',async()=>{
  let sends=0,claims=0;
  const livechat={claimChat:async()=>{claims++;return{lane:'MY_CHAT'};}};
  await assert.rejects(()=>sendHumanBridgeWithControlledClaim({livechat,chatId:'c5',send:async()=>{sends++;throw membershipError();}}),e=>e.code==='LIVECHAT_MEMBERSHIP_REQUIRED');
  assert.equal(sends,2);assert.equal(claims,1);
});

test('production wiring uses controlled claim for engine human_bridge and configured Telegram CTA only',()=>{
  const engine=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  const bridge=fs.readFileSync(new URL('../src/human-bridge.js',import.meta.url),'utf8');
  const livechat=fs.readFileSync(new URL('../src/livechat.js',import.meta.url),'utf8');
  assert.match(engine,/senderType==='human_bridge'[\s\S]*sendHumanBridgeWithControlledClaim/);
  assert.match(bridge,/CFG_[\s\S]*sendHumanBridgeWithControlledClaim/);
  const sendBlock=livechat.slice(livechat.indexOf('async sendEvent'),livechat.indexOf('sendMessage',livechat.indexOf('async sendEvent')));
  assert.doesNotMatch(sendBlock,/this\.call\('add_user_to_chat'/);
});
