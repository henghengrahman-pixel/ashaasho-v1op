import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {LiveChatClient} from '../src/livechat.js';

function err(status,msg){const e=new Error(`LIVECHAT_${status}: ${msg}`);e.status=status;return e;}

test('v1.32.2 explicit membership claim never guesses numeric LIVECHAT_ACCOUNT_ID as add_user_to_chat user_id',async()=>{
  const lc=new LiveChatClient({base:'http://local',accountId:'12345678',pat:'p'});
  lc.call=async()=>{ throw new Error('provider call must not happen without requester id'); };
  await assert.rejects(()=>lc.ensureRequesterInChat('c1'),e=>{
    assert.equal(e.status,422);
    assert.match(e.message,/LIVECHAT_REQUESTER_USER_ID_REQUIRED/);
    assert.match(e.message,/LIVECHAT_REQUESTER_USER_ID/);
    return true;
  });
});

test('v1.32.2 explicit membership claim can safely infer requester id when account id is clearly an email',async()=>{
  const calls=[];
  const lc=new LiveChatClient({base:'http://local',accountId:'agent@example.com',pat:'p'});
  lc.call=async(action,body)=>{calls.push({action,body});return {};};
  const out=await lc.ensureRequesterInChat('c1');
  assert.equal(out.ok,true);
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.user_id,'agent@example.com');
});

test('v1.32.2 explicit membership claim rewrites LiveChat 422 user_id not found into actionable requester identity error',async()=>{
  const lc=new LiveChatClient({base:'http://local',accountId:'123',requesterUserId:'wrong-id',pat:'p'});
  lc.call=async()=>{throw err(422,'`user_id` not found');};
  await assert.rejects(()=>lc.ensureRequesterInChat('c1'),e=>{
    assert.equal(e.status,422);
    assert.match(e.message,/LIVECHAT_REQUESTER_USER_ID_INVALID/);
    assert.match(e.message,/wrong-id/);
    return true;
  });
});

test('v1.32.2 config no longer falls back requester id to LIVECHAT_ACCOUNT_ID',()=>{
  const src=fs.readFileSync(new URL('../src/config.js',import.meta.url),'utf8');
  assert.match(src,/lcRequesterUserId:\s*process\.env\.LIVECHAT_REQUESTER_USER_ID \|\| ''/);
  assert.doesNotMatch(src,/lcRequesterUserId:[^\n]*LIVECHAT_ACCOUNT_ID/);
});
