import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {classifyCustomerEventError} from '../src/event-retry.js';

const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
const ingress=fs.readFileSync(new URL('../src/livechat-ingress.js',import.meta.url),'utf8');

test('PUBLIC_AGENT_LIMIT is ownership-blocked, not generic FAILED hot retry',()=>{
  const x=classifyCustomerEventError(new Error('LIVECHAT_PUBLIC_AGENT_LIMIT: Public agents in chat limit reached'),1);
  assert.equal(x.errorClass,'OWNERSHIP'); assert.equal(x.blockedReason,'PUBLIC_AGENT_LIMIT'); assert.equal(x.retryable,true);
});

test('No active chat thread is permanent and cannot retry-loop',()=>{
  const x=classifyCustomerEventError(new Error('LIVECHAT_422: No active chat thread'),1);
  assert.equal(x.errorClass,'PERMANENT'); assert.equal(x.retryable,false); assert.equal(x.terminal,true);
});

test('runnable customer events have a durable recovery producer through SYNC_CHAT',()=>{
  assert.match(db,/export async function scheduleRunnableCustomerEventRecovery/);
  assert.match(db,/source:'customer_event_recovery'/);
  assert.match(db,/priority:98/);
  assert.match(ingress,/scheduleRunnableCustomerEventRecovery/);
});

test('obsolete-session runnable events are terminalized before recovery',()=>{
  assert.match(db,/EVENT_SESSION_OBSOLETE/);
  assert.match(db,/e\.session_id<>c\.session_id/);
  assert.match(db,/c\.status='closed' OR c\.lc_active=false/);
});


test('recovery snapshot that cannot rediscover an old event becomes terminal instead of CRITICAL forever',()=>{
  const x=classifyCustomerEventError(new Error('EVENT_NOT_IN_PROVIDER_SNAPSHOT'),2);
  assert.equal(x.errorClass,'PERMANENT'); assert.equal(x.terminal,true);
  assert.match(ingress,/EVENT_NOT_IN_PROVIDER_SNAPSHOT/);
  assert.match(ingress,/CHAT_NOT_IN_AI_LANE/);
});
