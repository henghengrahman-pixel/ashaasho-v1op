import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
const ingress=fs.readFileSync(new URL('../src/livechat-ingress.js',import.meta.url),'utf8');
const config=fs.readFileSync(new URL('../src/config.js',import.meta.url),'utf8');

test('backlog recovery cancels one remaining stale SYNC_CHAT for already closed/inactive conversations',()=>{
  const start=db.indexOf('export async function recoverLiveChatIngressBacklog');
  const end=db.indexOf('export async function claimLiveChatIngressJobs',start);
  const body=db.slice(start,end);
  assert.match(body,/RECOVERY_STALE_CLOSED_SYNC/);
  assert.match(body,/r\.conversation_status='closed' OR r\.lc_active=false/);
});

test('ingress metrics distinguish retry attempts, retried jobs, runnable and delayed pending',()=>{
  const start=db.indexOf('export async function liveChatIngressStats');
  const end=db.indexOf('export async function runtimeOperationalStats',start);
  const body=db.slice(start,end);
  assert.match(body,/AS retried_jobs/);
  assert.match(body,/AS retry_attempts_total/);
  assert.match(body,/AS runnable_pending/);
  assert.match(body,/AS delayed_pending/);
  assert.match(body,/AS oldest_runnable_age_ms/);
  assert.doesNotMatch(body,/AS retry,/);
});

test('queue health is based on runnable lag and configurable thresholds',()=>{
  assert.match(config,/LIVECHAT_QUEUE_DEGRADED_MS/);
  assert.match(config,/LIVECHAT_QUEUE_CRITICAL_MS/);
  assert.match(ingress,/queueHealth=queueLag>=config\.lcQueueCriticalMs\?'CRITICAL'/);
  assert.match(ingress,/oldest_runnable_age_ms/);
});
