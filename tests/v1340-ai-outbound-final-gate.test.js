import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateAiOutboundState } from '../src/outbound-gate.js';

const engine=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');

test('v1.34.0 AI outbound state gate allows only active MY_CHAT under AI control',()=>{
  assert.deepEqual(evaluateAiOutboundState({status:'active',lc_active:true,lc_lane:'MY_CHAT',handling_mode:'AI',handling_state:'BOT_ACTIVE'}),{allowed:true,reason:null,lane:'MY_CHAT'});
  assert.equal(evaluateAiOutboundState({status:'active',lc_active:true,lc_lane:'SUPERVISED',handling_mode:'AI'}).allowed,false);
  assert.equal(evaluateAiOutboundState({status:'active',lc_active:true,lc_lane:'QUEUED',handling_mode:'AI'}).reason,'CHAT_NOT_IN_AI_LANE');
  assert.equal(evaluateAiOutboundState({status:'closed',lc_active:false,lc_lane:'MY_CHAT',handling_mode:'AI'}).reason,'CHAT_INACTIVE');
  assert.equal(evaluateAiOutboundState({status:'active',lc_active:true,lc_lane:'MY_CHAT',handling_mode:'HUMAN'}).reason,'HUMAN_TAKEOVER_ACTIVE');
});

test('v1.34.0 sendAndStore re-checks lane/takeover immediately before provider send',()=>{
  const start=engine.indexOf('async function sendAndStore');
  const end=engine.indexOf('async function buildSources',start);
  const block=engine.slice(start,end);
  const gatePos=block.indexOf('const finalGate=await finalAiOutboundGate(chatId,senderType)');
  const sendPos=block.indexOf('sent=await livechat.sendMessage(chatId,text');
  assert.ok(gatePos>=0,'final outbound gate is missing');
  assert.ok(sendPos>gatePos,'provider send must occur after the final gate');
  assert.match(block,/AI_OUTBOUND_SUPPRESSED_STATE_CHANGE/);
  assert.match(block,/if\(!finalGate\.allowed\)[\s\S]*?return \{suppressed:true/);
});

test('v1.34.0 human bridge policy remains unchanged by AI-only final gate',()=>{
  assert.match(engine,/if\(senderType!=='ai'\) return \{allowed:true,reason:null,lane:null\}/);
});
