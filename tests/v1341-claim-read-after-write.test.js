import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LiveChatClient } from '../src/livechat.js';

const requester='agent@example.com';
function queued(id='c1'){
  return {id,is_followed:true,routing_status:'queued',users:[{id:requester,type:'agent'}],threads:[{active:true,status:'active'}]};
}
function mine(id='c1'){
  return {id,is_followed:true,routing_status:'',users:[{id:requester,type:'agent'}],threads:[{active:true,status:'active'}]};
}

test('v1.34.1 controlled claim tolerates bounded provider read-after-write lag',async()=>{
  const lc=new LiveChatClient({accountId:'acct@example.com',pat:'pat',requesterUserId:requester,claimVerifyDelaysMs:[0,0,0]});
  let follow=0,membership=0,reads=0;
  lc.followChat=async()=>{follow++;return{ok:true};};
  lc.ensureRequesterInChat=async()=>{membership++;return{ok:true,added:true,userId:requester};};
  lc.getChat=async id=>{reads++;return reads<3?queued(id):mine(id);};
  const out=await lc.claimChat('c1',{knownChat:{id:'c1',is_followed:false,status:'active',threads:[{active:true,status:'active'}]}});
  assert.equal(follow,1);
  assert.equal(membership,1);
  assert.equal(reads,3);
  assert.equal(out.lane,'MY_CHAT');
  assert.equal(out.claimVerification.attempts,3);
  assert.deepEqual(out.claimVerification.observations.map(x=>x.lane),['QUEUED','QUEUED','MY_CHAT']);
});

test('v1.34.1 controlled claim verification is bounded when provider never confirms ownership',async()=>{
  const lc=new LiveChatClient({accountId:'acct@example.com',pat:'pat',requesterUserId:requester,claimVerifyDelaysMs:[0,0,0]});
  let reads=0;
  lc.followChat=async()=>({ok:true});
  lc.ensureRequesterInChat=async()=>({ok:true,added:true,userId:requester});
  lc.getChat=async id=>{reads++;return queued(id);};
  const out=await lc.claimChat('c2',{knownChat:{id:'c2',is_followed:false,status:'active',threads:[{active:true,status:'active'}]}});
  assert.equal(reads,3);
  assert.equal(out.lane,'QUEUED');
  assert.equal(out.claimVerification.attempts,3);
});

test('v1.34.1 ingress demotes stale local MY_CHAT and surfaces ownership verification failure',()=>{
  const src=readFileSync(new URL('../src/livechat-ingress.js',import.meta.url),'utf8');
  assert.match(src,/providerLane!==['"]MY_CHAT['"]/);
  assert.match(src,/setConversationLane\(chatId,\['QUEUED','SUPERVISED','OTHER'\]\.includes\(providerLane\)\?providerLane:'OTHER'\)/);
  assert.match(src,/LIVECHAT_CLAIM_OWNERSHIP_NOT_CONFIRMED/);
  assert.match(src,/setIntegrationHealth\('livechat_requester',\{status:'WARNING'/);
  assert.match(src,/setIntegrationHealth\('livechat_membership',\{status:'OK'/);
});

test('v1.34.1 health detail exposes ingress worker queue evidence',()=>{
  const src=readFileSync(new URL('../public/assets/js/pages/health.js',import.meta.url),'utf8');
  assert.match(src,/livechatIngress:s\.livechatIngress/);
});


test('v1.34.1 successful provider send clears stale membership warning',()=>{
  const src=readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
  assert.match(src,/setIntegrationHealth\('livechat_membership',\{status:'OK'.*lastAction:'sendMessage'/s);
});
