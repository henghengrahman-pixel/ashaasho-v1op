import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('welcome event may dedupe greeting but cannot be a session boundary without provider thread',()=>{
  const src=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  const sessionIdentity=fs.readFileSync(new URL('../src/session-identity.js',import.meta.url),'utf8');
  assert.match(sessionIdentity,/providerThreadKey=rawThreadKey \? `thread:\$\{rawThreadKey\}` : null/);
  assert.match(sessionIdentity,/greetingKey:providerThreadKey \|\| `welcome:\$\{bannerEventKey\}`/);
  assert.match(sessionIdentity,/boundarySource:providerThreadKey\?'LIVECHAT_THREAD_ID':null/);
  assert.doesNotMatch(src,/AUTHORITATIVE_SYSTEM_WELCOME/);
  assert.doesNotMatch(src,/VALIDATED_FALLBACK/);
});

test('poller retries a fresh welcome banner even when message was already inserted',()=>{
  const src=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
  assert.match(src,/async function ensureFreshWelcomeGreeting/);
  assert.match(src,/processGreetingTrigger\(\{/);
  assert.match(src,/await ensureFreshWelcomeGreeting\(chatId,events,livechat\)/);
});

test('welcome retry remains idempotent through processGreetingTrigger claim',()=>{
  const engine=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  assert.match(engine,/claimGreetingForThread\(chatId,greetingKey\)/);
  assert.match(engine,/greeting_already_sent_for_session/);
});
