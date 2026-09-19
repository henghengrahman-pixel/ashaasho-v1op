import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const poller=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
const ingress=fs.readFileSync(new URL('../src/livechat-ingress.js',import.meta.url),'utf8');
const livechat=fs.readFileSync(new URL('../src/livechat.js',import.meta.url),'utf8');

function extractClaimKeyParts(source){
  const bucketMatch=source.match(/export function claimDedupeBucket\([\s\S]*?\n\}/);
  const keyMatch=source.match(/export function claimDedupeKey\([\s\S]*?\n\}/);
  return {bucket:bucketMatch?.[0]||'',key:keyMatch?.[0]||''};
}

test('queued claims use renewable dedupe aligned to configured durable cooldown',()=>{
  const parts=extractClaimKeyParts(poller);
  assert.match(parts.bucket,/Math\.max\(30,Math\.min\(3600/);
  assert.match(parts.bucket,/cooldownSeconds/);
  assert.match(parts.key,/claimDedupeBucket\(now\)/);
  assert.equal((poller.match(/dedupeKey:claimDedupeKey\(chatId,fp\)/g)||[]).length,3);
  assert.doesNotMatch(poller,/dedupeKey:`claim:\$\{chatId\}:\$\{fp\}`/);
});

test('auto claim remains bounded by batch and per-chat cooldown',()=>{
  assert.match(poller,/autoClaimQueued<config\.lcAutoClaimQueuedBatch/);
  assert.match(ingress,/isLiveChatClaimBlocked\(chatId\)/);
  assert.match(ingress,/blocked:'CLAIM_COOLDOWN'/);
  assert.match(ingress,/recordLiveChatClaimFailure\(chatId,\{code:'LIVECHAT_PUBLIC_AGENT_LIMIT'/);
});

test('PUBLIC_AGENT_LIMIT send path still cannot mutate membership',()=>{
  const sendBlock=livechat.slice(livechat.indexOf('async sendMessage'),livechat.indexOf('async sendRichMessage'));
  assert.doesNotMatch(sendBlock,/add_user_to_chat/);
  assert.match(livechat,/explicit Handle with AI \/ claim is required before sending/);
});
