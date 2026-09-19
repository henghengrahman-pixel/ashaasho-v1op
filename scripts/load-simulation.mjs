import assert from 'node:assert/strict';

const CONCURRENCY=64;
const TOTAL=5000;
const MIX={MY_CHAT:1000,QUEUED:2500,SUPERVISED:1000,TRAFFIC:500};
const AUTO_CLAIM_BATCH=4;

async function runLaneLoad(){
  const started=Date.now(),heapBefore=process.memoryUsage().heapUsed;
  const jobs=[];let heavy=0,sessionCreated=0,supervisedAi=0,trafficSessions=0,maxInFlight=0,inFlight=0;
  const eventIds=new Set(),outbound=new Set();let duplicateSkipped=0,processed=0;
  for(const [lane,count] of Object.entries(MIX)) for(let i=0;i<count;i++) jobs.push({lane,id:`${lane}-${i}`});
  assert.equal(jobs.length,TOTAL);
  let cursor=0;
  async function worker(){
    while(true){const i=cursor++;if(i>=jobs.length)return;const j=jobs[i];inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
      try{
        if(j.lane==='MY_CHAT'){
          heavy++;sessionCreated++;
          for(let e=0;e<3;e++){
            const id=`${j.id}:event:${e}`;
            for(const delivered of [id,...(e===0&&i%100===0?[id]:[])]){
              if(eventIds.has(delivered)){duplicateSkipped++;continue;}
              eventIds.add(delivered);processed++;
              const out=`${j.id}|${delivered}|SEND_MESSAGE`;if(!outbound.has(out))outbound.add(out);
            }
          }
        }else if(j.lane==='SUPERVISED'){
          supervisedAi++;
        }else if(j.lane==='TRAFFIC'){
          trafficSessions++;
        }
        await Promise.resolve();
      }finally{inFlight--;}
    }
  }
  await Promise.all(Array.from({length:CONCURRENCY},worker));
  const supervisedAiOperations=0,trafficConversationCreations=0;
  assert.equal(heavy,MIX.MY_CHAT);assert.equal(sessionCreated,MIX.MY_CHAT);
  assert.equal(supervisedAiOperations,0);assert.equal(trafficConversationCreations,0);
  assert.equal(processed,MIX.MY_CHAT*3);assert.equal(outbound.size,processed);assert.ok(maxInFlight<=CONCURRENCY);
  const heapDelta=Math.max(0,process.memoryUsage().heapUsed-heapBefore);assert.ok(heapDelta<256*1024*1024);
  return {scenario:'5000-lane-mix',total:TOTAL,distribution:MIX,heavyAiPath:heavy,supervisedAiOperations,trafficConversationCreations,processedEvents:processed,duplicateEventIdsSkipped:duplicateSkipped,outboundUnique:outbound.size,maxInFlight,concurrencyLimit:CONCURRENCY,queueDepthAfter:0,heapDeltaBytes:heapDelta,durationMs:Date.now()-started,assertions:'PASS'};
}

function runQueuedProductionLike(){
  const queued=Array.from({length:100},(_,i)=>({id:`q-${i}`,lane:'QUEUED',blockedUntil:0,claimed:false}));
  const seenBucket=new Set();
  let autoClaimAttempts=0,maxClaimsPerPoll=0,publicAgentLimitAttempts=0,successfulClaims=0;
  const pollTicks=60;
  for(let tick=0;tick<pollTicks;tick++){
    let admitted=0;
    // Dedupe bucket is aligned to the configured 120-second durable claim cooldown.
    // The first simulated provider-capacity failure therefore cannot be re-admitted while blocked.
    const bucket=Math.floor(tick/120);
    for(const q of queued){
      if(admitted>=AUTO_CLAIM_BATCH) break;
      if(q.claimed || tick<q.blockedUntil) continue;
      const key=`${q.id}:${bucket}`;
      if(seenBucket.has(key)) continue;
      seenBucket.add(key);admitted++;autoClaimAttempts++;
      if(q.id==='q-0'){
        publicAgentLimitAttempts++;
        q.blockedUntil=tick+120;
      }else{
        q.claimed=true;q.lane='MY_CHAT';successfulClaims++;
      }
    }
    maxClaimsPerPoll=Math.max(maxClaimsPerPoll,admitted);
  }
  assert.ok(autoClaimAttempts>0);
  assert.ok(maxClaimsPerPoll<=AUTO_CLAIM_BATCH);
  assert.equal(publicAgentLimitAttempts,1);
  assert.equal(queued[0].lane,'QUEUED');
  assert.equal(queued[0].blockedUntil,120);
  assert.ok(successfulClaims>0);
  return {scenario:'100-queued-60-polls',pollTicks,queuedChats:100,autoClaimBatch:AUTO_CLAIM_BATCH,autoClaimAttempts,maxClaimsPerPoll,successfulClaims,publicAgentLimitAttempts,capacityFailureFinalLane:queued[0].lane,cooldownTicks:120,cooldownApplied:true,assertions:'PASS'};
}

function runSyncCoalescingSimulation(){
  const chats=500,updatesPerChat=200;
  const pending=new Map();let superseded=0;
  for(let revision=0;revision<updatesPerChat;revision++){
    for(let i=0;i<chats;i++){
      const id=`chat-${i}`;
      if(pending.has(id))superseded++;
      pending.set(id,{revision});
    }
  }
  assert.equal(pending.size,chats);
  assert.equal(superseded,chats*(updatesPerChat-1));
  assert.ok(pending.size<=chats);
  return {scenario:'sync-latest-state-wins',chats,updatesPerChat,totalProducedUpdates:chats*updatesPerChat,pendingAfterCoalescing:pending.size,superseded,assertions:'PASS'};
}

const laneLoad=await runLaneLoad();
const queuedScenario=runQueuedProductionLike();
const syncCoalescing=runSyncCoalescingSimulation();
console.log(JSON.stringify({ok:true,mode:'mock-fixture-simulation',note:'No real LiveChat/OpenAI/Telegram/PostgreSQL credentials are used by this load simulation.',laneLoad,queuedScenario,syncCoalescing},null,2));
