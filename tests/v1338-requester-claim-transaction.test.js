import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { LiveChatClient } from '../src/livechat.js';
import { inspectLiveChatRequesterUserId } from '../src/config.js';

function make(){return new LiveChatClient({base:'http://local',accountId:'acct',requesterUserId:'bot@example.com',pat:'pat'});}
function providerError(status,message){const e=new Error(`LIVECHAT_${status}: ${message}`);e.status=status;return e;}

test('v1.33.8 requester format rejects numeric license IDs but accepts agent email/opaque IDs',()=>{
  assert.deepEqual(inspectLiveChatRequesterUserId('12345678'),{configured:true,valid:false,reason:'NUMERIC_ACCOUNT_ID'});
  assert.equal(inspectLiveChatRequesterUserId('bot@example.com').valid,true);
  assert.equal(inspectLiveChatRequesterUserId('agent_abc-123').valid,true);
  assert.equal(inspectLiveChatRequesterUserId('bad id with spaces').valid,false);
});

test('v1.33.8 production boot rejects configured LiveChat without explicit requester ID',()=>{
  const env={...process.env,NODE_ENV:'production',DATABASE_URL:'postgres://unused',BRAIN_DATABASE_URL:'postgres://unused',ADMIN_PASSWORD:'test-only',SESSION_SECRET:'x'.repeat(40),LIVECHAT_ACCOUNT_ID:'12345',LIVECHAT_PAT:'pat',LIVECHAT_REQUESTER_USER_ID:''};
  const script="import('./src/config.js').then(m=>{try{m.assertBootConfig();process.exit(0)}catch(e){console.error(e.message);process.exit(7)}})";
  const out=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env,encoding:'utf8'});
  assert.equal(out.status,7);
  assert.match(out.stderr,/LIVECHAT_REQUESTER_USER_ID wajib diisi/);
});

test('v1.33.8 membership failure rolls back only a follow introduced by this claim',async()=>{
  const lc=make();const calls=[];
  lc.call=async(action)=>{calls.push(action);if(action==='follow_chat'||action==='unfollow_chat')return{};if(action==='add_user_to_chat')throw providerError(422,'`user_id` not found');throw new Error(`unexpected:${action}`);};
  await assert.rejects(()=>lc.claimChat('c1',{knownChat:{id:'c1',is_followed:false,last_thread_summary:{active:true}}}),e=>{
    assert.equal(e.code,'LIVECHAT_REQUESTER_USER_ID_INVALID');
    assert.deepEqual(e.claimCleanup,{attempted:true,ok:true,reason:'MEMBERSHIP_FAILED'});
    return true;
  });
  assert.deepEqual(calls,['follow_chat','add_user_to_chat','unfollow_chat']);
});

test('v1.33.8 pre-existing follow is never removed when membership fails',async()=>{
  const lc=make();const calls=[];
  lc.call=async(action)=>{calls.push(action);if(action==='add_user_to_chat')throw providerError(422,'Public agents in chat limit reached');throw new Error(`unexpected:${action}`);};
  await assert.rejects(()=>lc.claimChat('c2',{knownChat:{id:'c2',is_followed:true,last_thread_summary:{active:true}}}),e=>{
    assert.equal(e.code,'LIVECHAT_PUBLIC_AGENT_LIMIT');
    assert.equal(e.claimCleanup.attempted,false);
    assert.equal(e.claimCleanup.skipped,'PREEXISTING_FOLLOW');
    return true;
  });
  assert.deepEqual(calls,['add_user_to_chat']);
});

test('v1.33.8 rollback failure is attached to original membership error instead of swallowed',async()=>{
  const lc=make();const calls=[];
  lc.call=async(action)=>{calls.push(action);if(action==='follow_chat')return{};if(action==='add_user_to_chat')throw providerError(422,'`user_id` not found');if(action==='unfollow_chat')throw providerError(503,'cleanup unavailable');throw new Error(`unexpected:${action}`);};
  await assert.rejects(()=>lc.claimChat('c3',{knownChat:{id:'c3',is_followed:false,last_thread_summary:{active:true}}}),e=>{
    assert.equal(e.code,'LIVECHAT_REQUESTER_USER_ID_INVALID');
    assert.equal(e.claimCleanup.attempted,true);
    assert.equal(e.claimCleanup.ok,false);
    assert.match(e.claimCleanup.error,/cleanup unavailable/);
    return true;
  });
  assert.deepEqual(calls,['follow_chat','add_user_to_chat','unfollow_chat']);
});

test('v1.33.8 status/health exposes requester verification and avoids config-only OpenAI healthy',()=>{
  const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const ui=fs.readFileSync(new URL('../public/assets/js/pages/health.js',import.meta.url),'utf8');
  assert.match(server,/requesterRuntimeStatus/);
  assert.match(server,/requesterRuntimeVerified/);
  assert.match(server,/requesterFormatValid/);
  assert.match(server,/livechatHealth/);
  assert.match(ui,/s\.livechatHealth\?\.status/);
  assert.match(ui,/integ\('openai',s\.openaiConfigured\)/);
  assert.doesNotMatch(ui,/s\.openaiConfigured\?'HEALTHY'/);
});

test('v1.33.8 dashboard/ingress ownership cleanup delegates to state-aware rollback helper',()=>{
  const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const ingress=fs.readFileSync(new URL('../src/livechat-ingress.js',import.meta.url),'utf8');
  assert.match(server,/rollbackClaimFollow\(id,claimed/);
  assert.match(ingress,/rollbackClaimFollow\(chatId,claimed/);
  assert.doesNotMatch(server,/lc\.unfollowChat\?\.\(id\)\.catch\(\(\)=>\{\}\)/);
  assert.doesNotMatch(ingress,/livechat\.unfollowChat\?\.\(chatId\)\.catch\(\(\)=>\{\}\)/);
});

test('v1.33.8 provider-inactive close cannot report local success when archive persistence fails',()=>{
  const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const start=server.indexOf('async function closeConversationFromInactiveProvider');
  const end=server.indexOf('const learningWorker=',start);
  const block=server.slice(start,end);
  assert.match(block,/await markConversationEnded\(chatId,\{reason\}\)/);
  assert.match(block,/LIVECHAT_INACTIVE_CLOSE_PERSIST_FAILED/);
  assert.doesNotMatch(block,/markConversationEnded\(chatId,\{reason\}\)\.catch\(\(\)=>\{\}\)/);
});

test('v1.33.8 Telegram ENV sync does not swallow deleteWebhook failure',()=>{
  const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const start=server.indexOf('async function syncTelegramFromEnv');
  const end=server.indexOf('const __dirname',start);
  const block=server.slice(start,end);
  assert.match(block,/await tg\.deleteWebhook\(\);/);
  assert.doesNotMatch(block,/deleteWebhook\(\)\.catch\(\(\)=>\{\}\)/);
});

test('v1.33.8 package, lock, README and runtime health source share release version',()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const lock=JSON.parse(fs.readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
  const readme=fs.readFileSync(new URL('../README.md',import.meta.url),'utf8');
  const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  assert.equal(pkg.version,'1.33.8');
  assert.equal(lock.version,pkg.version);
  assert.equal(lock.packages[''].version,pkg.version);
  assert.match(readme,new RegExp(`Current release: v${pkg.version.replaceAll('.','\\.')}`));
  assert.match(server,/version:appVersion/);
});
