import { config, inspectLiveChatRequesterUserId } from './config.js';


function pickLatestThread(chat={}) {
  const direct=chat?.last_thread_summary || chat?.last_thread || chat?.thread;
  if(direct && typeof direct==='object') return direct;
  const threads=Array.isArray(chat?.threads)?chat.threads.filter(x=>x&&typeof x==='object'):[];
  if(!threads.length) return {};
  let best=threads[0],bestTs=Date.parse(best?.created_at||'');
  for(const th of threads.slice(1)){
    const ts=Date.parse(th?.created_at||'');
    if(Number.isFinite(ts) && (!Number.isFinite(bestTs) || ts>bestTs)){best=th;bestTs=ts;}
  }
  return best||{};
}


function collectChatUsers(chat={}) {
  const thread=pickLatestThread(chat);
  const out=[];
  for(const list of [chat?.users, thread?.users, chat?.last_thread_summary?.users, chat?.last_thread?.users]){
    if(!Array.isArray(list)) continue;
    for(const u of list) if(u && typeof u==='object') out.push(u);
  }
  return out;
}

function normalizeIdentity(v){ return String(v||'').trim().toLowerCase(); }

function userMatchesRequester(user, requesterId=''){
  const target=normalizeIdentity(requesterId);
  if(!target || !user || typeof user!=='object') return false;
  const candidates=[user.id,user.user_id,user.email,user.login,user.username].map(normalizeIdentity).filter(Boolean);
  return candidates.includes(target);
}

export class LiveChatClient {
  constructor(overrides={}) {
    this.base = overrides.base || config.lcApiBase;
    this.accountId = overrides.accountId || config.lcAccountId;
    this.requesterUserId = overrides.requesterUserId || config.lcRequesterUserId || '';
    // A PAT account/login may sometimes already be the agent email. Only infer in that
    // unambiguous case; never treat a numeric license/account id as Agent Chat user_id.
    this.inferredRequesterUserId = this.requesterUserId || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(this.accountId||'')) ? String(this.accountId) : '');
    this.pat = overrides.pat || config.lcPat;
    this.timeoutMs = overrides.timeoutMs || 15000;
    this.inboxMode = overrides.inboxMode || config.lcInboxMode;
    // Provider routing/membership can be eventually consistent immediately after add_user_to_chat.
    // Keep verification bounded so controlled claims do not create an unbounded request storm.
    this.claimVerifyDelaysMs = Array.isArray(overrides.claimVerifyDelaysMs)
      ? overrides.claimVerifyDelaysMs.map(v=>Math.max(0,Number(v)||0)).slice(0,5)
      : [0,300,900];
  }
  ready() { return Boolean(this.accountId && this.pat && this.base); }
  requesterIdentityStatus() {
    const explicit=inspectLiveChatRequesterUserId(this.requesterUserId);
    const effective=inspectLiveChatRequesterUserId(this.inferredRequesterUserId);
    return {
      explicitConfigured:explicit.configured,
      available:effective.configured,
      formatValid:effective.valid,
      source:explicit.configured?'env_or_override':(effective.configured?'account_email_inference':'missing'),
      reason:effective.valid?null:effective.reason
    };
  }
  authHeader() {
    return 'Basic ' + Buffer.from(`${this.accountId}:${this.pat}`).toString('base64');
  }
  async call(action, body={}, options={}) {
    if (!this.ready()) throw new Error('LIVECHAT_CREDENTIALS_MISSING');
    const retryableAction=new Set(['list_chats','list_threads','get_chat','list_archives','deactivate_chat','follow_chat','unfollow_chat']);
    const configured=Math.max(0,Number(options.retries ?? config.lcHttpRetries ?? 0));
    const maxRetries=retryableAction.has(String(action)) ? configured : 0;
    let attempt=0;
    while(true){
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const r = await fetch(`${this.base}/${action}`, {
          method:'POST',
          headers:{ 'Authorization': this.authHeader(), 'Content-Type':'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal
        });
        const txt = await r.text();
        let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw:txt }; }
        if (!r.ok) {
          const err = new Error(`LIVECHAT_${r.status}: ${data?.error?.message || data?.message || txt.slice(0,300)}`);
          err.status = r.status; err.data = data;
          const retryAfter=Number(r.headers.get('retry-after'));
          err.retryAfterMs=Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:null;
          throw err;
        }
        return data;
      } catch(err) {
        const transient=err?.name==='AbortError' || [408,425,429,500,502,503,504].includes(Number(err?.status));
        if(!transient || attempt>=maxRetries) throw err;
        const base=Math.max(100,Number(config.lcHttpRetryBaseMs||500));
        const backoff=err?.retryAfterMs || Math.min(15000,base*(2**attempt)+Math.floor(Math.random()*base));
        attempt++;
        await new Promise(r=>setTimeout(r,backoff));
      } finally { clearTimeout(timer); }
    }
  }

  // LiveChat Agent Chat API list_chats may expose the list as chats_summary.
  // Keep compatibility with alternate/older shapes as well.
  normalizeChatList(data) {
    if (Array.isArray(data?.chats_summary)) return { items:data.chats_summary, source:'chats_summary' };
    if (Array.isArray(data?.chats)) return { items:data.chats, source:'chats' };
    if (Array.isArray(data?.items)) return { items:data.items, source:'items' };
    return { items:[], source:'none' };
  }


  chatState(summary) {
    const th = pickLatestThread(summary);
    const followed = summary?.is_followed;
    const status = String(summary?.status || th?.status || '').toLowerCase();
    const routingStatus = String(summary?.routing_status || th?.routing_status || '').toLowerCase();
    const explicitlyClosed = ['closed','archived','inactive'].includes(status) || ['closed','archived','inactive'].includes(routingStatus);
    const active = typeof th?.active === 'boolean' ? th.active
      : (typeof summary?.active === 'boolean' ? summary.active
      : (explicitlyClosed ? false : (status === 'active' ? true : null)));
    return { followed, active, routingStatus };
  }

  classifyChatLane(summary={}) {
    const st=this.chatState(summary);
    if(st.active===false) return 'CLOSED';

    const thread=pickLatestThread(summary);
    const routing=String(st.routingStatus||'').toLowerCase();
    const status=String(summary?.status||thread?.status||'').toLowerCase();
    const state=String(summary?.state||thread?.state||'').toLowerCase();
    const explicitLane=String(summary?.lane||summary?.inbox_lane||thread?.lane||thread?.inbox_lane||'').toLowerCase();

    const queuedSignal =
      ['queued','queue','waiting','waiting_for_agent'].includes(routing) ||
      ['queued','queue','waiting','waiting_for_agent'].includes(status) ||
      ['queued','queue','waiting','waiting_for_agent'].includes(state) ||
      explicitLane.includes('queue') ||
      Number.isFinite(Number(summary?.queue_position ?? thread?.queue_position)) ||
      Boolean(summary?.queued_at || thread?.queued_at);

    const supervisedSignal =
      summary?.is_supervised===true || thread?.is_supervised===true ||
      summary?.supervised===true || thread?.supervised===true ||
      explicitLane.includes('supervis') || routing.includes('supervis') || status.includes('supervis');

    const requester=this.inferredRequesterUserId;
    const users=collectChatUsers(summary);
    const hasUserList=users.length>0;
    const requesterIsMember=Boolean(requester && users.some(u=>userMatchesRequester(u,requester)));
    if(queuedSignal) return 'QUEUED';
    if(supervisedSignal) return 'SUPERVISED';
    if(requesterIsMember) return 'MY_CHAT';

    // In LiveChat a followed chat that does not contain the current requester in the
    // provider user list behaves like a supervised chat. Only apply this distinction
    // when the response actually exposes users; otherwise keep the legacy followed=>mine
    // behaviour so response-shape differences cannot silently drop chats.
    if(st.followed===true){
      if(requester && hasUserList && !requesterIsMember) return 'SUPERVISED';
      if(requester && !hasUserList) return 'OTHER';
      return 'MY_CHAT';
    }
    if(st.followed===false) return 'QUEUED';

    // If membership is explicit and the requester is absent, keep it out of the AI lane.
    if(requester && hasUserList && !requesterIsMember) return 'QUEUED';

    // Strict lane isolation: when the provider omits ownership/routing signals, never
    // guess MY_CHAT. The poller resolves OTHER with get_chat before allowing AI.
    return 'OTHER';
  }

  isMyActiveChat(summary) {
    return this.classifyChatLane(summary)==='MY_CHAT';
  }

  filterInbox(items) {
    if (this.inboxMode === 'all') return items;
    if (this.inboxMode === 'all_active') return items.filter(x=>this.chatState(x).active!==false);
    return items.filter(x => this.isMyActiveChat(x));
  }

  async listChats({pageId=null,activeOnly=true,limit=config.lcListLimit}={}) {
    // Agent Chat API v3.6 pagination contract: the first request carries filters/limit/sort_order;
    // every subsequent request carries page_id only. `filters.active`, not legacy `include_active`,
    // is the authoritative active-chat filter.
    const body=pageId
      ? {page_id:String(pageId)}
      : {filters:{active:activeOnly?true:null,include_chats_without_threads:true},sort_order:'desc',limit:Math.min(100,Math.max(1,Number(limit)||100))};
    const data=await this.call('list_chats',body);
    const normalized=this.normalizeChatList(data);
    return {...data,_normalizedChats:normalized.items,_listSource:normalized.source,_requestBody:body};
  }

  async listAllActiveChats(){
    const items=[]; const seenChats=new Set(); const seenPages=new Set();
    let pageId=null,pages=0,foundChats=null;
    do{
      if(pageId && seenPages.has(String(pageId))) throw new Error('LIVECHAT_PAGINATION_LOOP');
      if(pageId) seenPages.add(String(pageId));
      const data=await this.listChats({pageId,activeOnly:true,limit:100});
      pages++;
      if(foundChats==null && Number.isFinite(Number(data?.found_chats))) foundChats=Number(data.found_chats);
      for(const chat of data?._normalizedChats||[]){
        const id=String(chat?.id||'').trim();
        if(!id || seenChats.has(id)) continue;
        seenChats.add(id); items.push(chat);
      }
      pageId=data?.next_page_id ? String(data.next_page_id) : null;
    }while(pageId);
    return {items,pages,foundChats,complete:true};
  }
  normalizeChatDetail(data, fallback={}) {
    let chat = null;
    let source = 'none';
    if (data && typeof data === 'object' && data.chat && typeof data.chat === 'object') {
      chat = data.chat; source = 'chat';
    } else if (data && typeof data === 'object' && (data.id || Array.isArray(data.threads))) {
      chat = data; source = 'direct';
    } else if (Array.isArray(data?.chats) && data.chats[0]) {
      chat = data.chats[0]; source = 'chats[0]';
    } else if (Array.isArray(data?.items) && data.items[0]) {
      chat = data.items[0]; source = 'items[0]';
    }
    if (!chat) chat = { ...fallback };
    else {
      const detail=chat;
      chat = { ...fallback, ...detail };
      // A list_chats summary is only a fallback. When get_chat returns real thread data,
      // never let a stale fallback last_thread_summary override the provider detail.
      if(Array.isArray(detail?.threads)){
        if(!Object.prototype.hasOwnProperty.call(detail,'last_thread_summary')) delete chat.last_thread_summary;
        if(!Object.prototype.hasOwnProperty.call(detail,'last_thread')) delete chat.last_thread;
        if(!Object.prototype.hasOwnProperty.call(detail,'thread')) delete chat.thread;
      }
    }
    if (!chat.id && fallback?.id) chat.id = fallback.id;
    Object.defineProperty(chat, '_detailSource', { value: source, enumerable: false, configurable: true });
    return chat;
  }

  async getChat(chatId, fallback={}) {
    const id=String(chatId||'').trim();
    if(!id){const er=new Error('LIVECHAT_CHAT_ID_REQUIRED');er.status=400;throw er;}
    const threadId=pickLatestThread(fallback)?.id ?? fallback?.thread_id ?? null;
    const candidates=[{chat_id:id}];
    if(threadId!==null && threadId!==undefined && String(threadId)!=='') candidates.push({chat_id:id,thread_id:String(threadId)});
    let lastErr=null,best=null,bestCount=-1;
    for(let i=0;i<candidates.length;i++){
      const body=candidates[i];
      try{
        const data=await this.call('get_chat',body);
        const chat=this.normalizeChatDetail(data,fallback);
        Object.defineProperty(chat,'_getChatRequest',{value:body,enumerable:false,configurable:true});
        const count=extractChatEvents(chat).length;
        if(count>bestCount){best=chat;bestCount=count;}
        // v3.6 get_chat without thread_id already returns the latest thread. If it has
        // readable events, querying that same thread again by ID only doubles API load.
        if(i===0 && count>0) return chat;
      }catch(e){lastErr=e;if(![400,404,422].includes(Number(e?.status))) throw e;}
    }
    if(best){
      if(bestCount<=0){
        const threads=Array.isArray(best?.threads)?best.threads:[];
        console.info(JSON.stringify({event:'livechat_get_chat_no_readable_events',chatId:id,providerHttpStatus:200,requestVariant:best?._getChatRequest||null,topLevelKeys:Object.keys(best||{}).slice(0,30),threadsCount:threads.length,threadIds:threads.map(t=>String(t?.id||t?.thread_id||'')).filter(Boolean).slice(0,20),eventCounts:threads.map(t=>Array.isArray(t?.events)?t.events.length:0).slice(0,20),eventTypes:[...new Set(threads.flatMap(t=>(Array.isArray(t?.events)?t.events:[]).map(e=>String(e?.type||'unknown'))))].slice(0,30),eventObjectKeys:[...new Set(threads.flatMap(t=>(Array.isArray(t?.events)?t.events:[]).flatMap(e=>Object.keys(e||{}))))].slice(0,40)}));
      }
      return best;
    }
    if(lastErr) throw lastErr;
    return this.normalizeChatDetail({},fallback);
  }

  chatDiagnostics(chat) {
    const threads = Array.isArray(chat?.threads) ? chat.threads : [];
    const topEvents = Array.isArray(chat?.events) ? chat.events.length : 0;
    const threadEvents = threads.reduce((n,t)=>n + (Array.isArray(t?.events)?t.events.length:0), 0);
    const messages = extractChatEvents(chat).length;
    return {
      detailSource: chat?._detailSource || 'unknown',
      threadCount: threads.length,
      eventCount: topEvents + threadEvents,
      messageCount: messages,
      requestedThreadId: chat?._getChatRequest?.thread_id ?? null,
      requestUsed: chat?._getChatRequest || null,
      keys: chat && typeof chat==='object' ? Object.keys(chat).slice(0,30) : []
    };
  }
  isChatInactiveError(err) {
    const status=Number(err?.status||0);
    const msg=String(err?.message||err||'');
    return [404,409,410,422].includes(status) && /chat\s+(?:is\s+)?(?:not\s+active|inactive)|no\s+active\s+thread/i.test(msg);
  }

  inactiveChatError(err) {
    const er=new Error('LIVECHAT_CHAT_INACTIVE');
    er.status=410; er.code='LIVECHAT_CHAT_INACTIVE'; er.cause=err;
    return er;
  }

  isProviderIdRequiredError(err){
    const message=String(err?.data?.error?.message||err?.data?.message||err?.message||err||'');
    return Number(err?.status)===422 && /(?:^|[^a-z_])(?:`|\")?id(?:`|\")?\s+is\s+required/i.test(message) && !/user_id/i.test(message);
  }

  claimTelemetry({action,chatId,payload={},status=null,error=null,laneBefore=null,laneAfter=null,contractVariant='primary'}={}){
    const providerCode=error?.data?.error?.type||error?.data?.error?.code||error?.data?.code||error?.code||null;
    const providerMessage=error?String(error?.data?.error?.message||error?.data?.message||error?.message||error).slice(0,300):null;
    const entry={event:'livechat_claim_action',action:String(action||''),chatId:String(chatId||''),requesterIdPresent:Boolean(this.inferredRequesterUserId),payloadKeys:Object.keys(payload||{}).sort(),httpStatus:status??(error?.status||null),providerCode,providerMessage,laneBefore,laneAfter,contractVariant};
    if(error) console.warn(JSON.stringify(entry)); else console.info(JSON.stringify(entry));
  }

  async callClaimAction(action,chatId,body,{laneBefore=null,retries=0}={}){
    try{
      const out=await this.call(action,body,{retries});
      this.claimTelemetry({action,chatId,payload:body,status:200,laneBefore,contractVariant:'primary'});
      return out;
    }catch(primaryError){
      this.claimTelemetry({action,chatId,payload:body,error:primaryError,laneBefore,contractVariant:'primary'});
      // Contract-guided compatibility recovery only after the provider explicitly says the
      // request is missing the top-level `id` field. The failed validation request is
      // side-effect free; all other 4xx errors are propagated unchanged.
      if(!this.isProviderIdRequiredError(primaryError) || Object.prototype.hasOwnProperty.call(body||{},'id')) throw primaryError;
      const alternate={...(body||{}),id:String(chatId)}; delete alternate.chat_id;
      try{
        const out=await this.call(action,alternate,{retries:0});
        this.claimTelemetry({action,chatId,payload:alternate,status:200,laneBefore,contractVariant:'provider_required_id'});
        return out;
      }catch(secondaryError){
        this.claimTelemetry({action,chatId,payload:alternate,error:secondaryError,laneBefore,contractVariant:'provider_required_id'});
        secondaryError.providerContractFallback={action,primaryPayloadKeys:Object.keys(body||{}),fallbackPayloadKeys:Object.keys(alternate),trigger:'HTTP_422_ID_REQUIRED'};
        throw secondaryError;
      }
    }
  }

  async unfollowChat(chatId) {
    const id=String(chatId||'').trim();
    if(!id){const er=new Error('LIVECHAT_CHAT_ID_REQUIRED');er.status=400;throw er;}
    try{return await this.callClaimAction('unfollow_chat',id,{chat_id:id});}
    catch(err){if(this.isChatInactiveError(err)) throw this.inactiveChatError(err);throw err;}
  }

  async followChat(chatId) {
    const id=String(chatId||'').trim();
    if(!id){const er=new Error('LIVECHAT_CHAT_ID_REQUIRED');er.status=400;throw er;}
    try{return await this.callClaimAction('follow_chat',id,{chat_id:id});}
    catch(err){if(this.isChatInactiveError(err)) throw this.inactiveChatError(err);throw err;}
  }

  async rollbackClaimFollow(chatId,claimResult,{reason='CLAIM_ROLLBACK'}={}) {
    const id=String(chatId||'').trim();
    const changed=Boolean(claimResult?.claimMutation?.followChangedByClaim);
    if(!changed) return {attempted:false,ok:true,skipped:'FOLLOW_NOT_CHANGED_BY_THIS_CLAIM'};
    try{
      await this.unfollowChat(id);
      return {attempted:true,ok:true,reason};
    }catch(error){
      const er=new Error(`LIVECHAT_CLAIM_ROLLBACK_FAILED: ${String(error?.message||error)}`);
      er.code='LIVECHAT_CLAIM_ROLLBACK_FAILED'; er.status=Number(error?.status)||502; er.cause=error;
      er.claimCleanup={attempted:true,ok:false,reason,error:String(error?.message||error)};
      throw er;
    }
  }

  async claimChat(chatId,{ensureMembership=true,knownChat=null}={}) {
    const id=String(chatId||'').trim();
    if(!id){const er=new Error('LIVECHAT_CHAT_ID_REQUIRED');er.status=400;throw er;}

    // Establish provider follow state before mutating it. A caller may pass a fresh get_chat
    // snapshot; otherwise fetch one here. We only claim ownership of rollback when the
    // provider explicitly told us is_followed=false before this transaction.
    let before=(knownChat && typeof knownChat==='object')?knownChat:null;
    let followedBefore=typeof before?.is_followed==='boolean'?before.is_followed:null;
    if(followedBefore===null){
      before=await this.getChat(id,before?.id?before:{id});
      followedBefore=typeof before?.is_followed==='boolean'?before.is_followed:null;
    }
    if(this.chatState(before||{}).active===false) throw this.inactiveChatError(new Error('Chat is not active'));

    let followChangedByClaim=false;
    if(followedBefore!==true){
      await this.followChat(id);
      followChangedByClaim=followedBefore===false;
    }
    const claimMutation={followStateBefore:followedBefore,followChangedByClaim};
    let membership=null;
    if(ensureMembership){
      try{membership=await this.ensureRequesterInChat(id);}
      catch(err){
        // Compensate every membership failure only when this exact transaction introduced
        // the follow. Never blind-unfollow an already-followed or state-unknown chat.
        if(followChangedByClaim){
          try{
            const cleanup=await this.rollbackClaimFollow(id,{claimMutation},{reason:'MEMBERSHIP_FAILED'});
            err.claimCleanup=cleanup;
          }catch(cleanupErr){
            err.claimCleanup=cleanupErr.claimCleanup||{attempted:true,ok:false,error:String(cleanupErr?.message||cleanupErr)};
          }
        }else{
          err.claimCleanup={attempted:false,ok:true,skipped:followedBefore===true?'PREEXISTING_FOLLOW':'FOLLOW_STATE_UNKNOWN'};
        }
        throw err;
      }
    }
    // add_user_to_chat can succeed before list/get_chat immediately reflects the new
    // routing and user membership. Verify ownership with a small bounded read-after-write
    // window instead of rolling back a valid claim on the first stale provider snapshot.
    const verification=[];
    let chat=null,lane='OTHER';
    const delays=this.claimVerifyDelaysMs.length?this.claimVerifyDelaysMs:[0];
    for(let i=0;i<delays.length;i++){
      const delay=Number(delays[i]||0);
      if(delay>0) await new Promise(resolve=>setTimeout(resolve,delay));
      chat=await this.getChat(id,{id});
      lane=this.classifyChatLane(chat);
      const users=collectChatUsers(chat); const requesterPresent=Boolean(this.inferredRequesterUserId && users.some(u=>userMatchesRequester(u,this.inferredRequesterUserId)));
      verification.push({attempt:i+1,lane,requesterPresent,userListObserved:users.length>0});
      this.claimTelemetry({action:'verify_membership',chatId:id,payload:{chat_id:id},status:200,laneBefore:this.classifyChatLane(before||{}),laneAfter:lane,contractVariant:'provider_read_after_write'});
      if(lane==='MY_CHAT' && requesterPresent) break;
    }
    const finalUsers=collectChatUsers(chat||{}); const membershipVerified=Boolean(this.inferredRequesterUserId && finalUsers.some(u=>userMatchesRequester(u,this.inferredRequesterUserId)));
    if(lane==='MY_CHAT' && !membershipVerified) lane='OTHER';
    return {ok:true,chat,lane,membership,membershipVerified,claimMutation,claimVerification:{attempts:verification.length,observations:verification}};
  }

  isRequesterMembershipError(err) {
    return Number(err?.status)===403 && /requester\s+is\s+not\s+(?:a\s+)?user\s+of\s+the\s+chat/i.test(String(err?.message||err||''));
  }

  requesterMembershipRequiredError(err) {
    const er=new Error('LIVECHAT_MEMBERSHIP_REQUIRED: requester is not a user of this chat; explicit Handle with AI / claim is required before sending');
    er.status=403;
    er.code='LIVECHAT_MEMBERSHIP_REQUIRED';
    er.retryable=false;
    er.cause=err;
    return er;
  }

  isAlreadyChatUserError(err) {
    const msg=String(err?.message||err||'').toLowerCase();
    return [400,409,422].includes(Number(err?.status)) && /(already|exists|present).*(user|chat)|(user|agent).*(already|exists|present)/i.test(msg);
  }

  isPublicAgentLimitError(err) {
    return Number(err?.status)===422 && /public\s+agents?\s+in\s+chat\s+limit\s+reached/i.test(String(err?.message||err||''));
  }

  async ensureRequesterInChat(chatId) {
    const id=String(chatId||'').trim();
    if(!id){ const er=new Error('LIVECHAT_CHAT_ID_REQUIRED'); er.status=400; throw er; }
    const userId=String(this.inferredRequesterUserId||'').trim();
    const identity=inspectLiveChatRequesterUserId(userId);
    if(!identity.configured){
      const er=new Error('LIVECHAT_REQUESTER_USER_ID_REQUIRED: set LIVECHAT_REQUESTER_USER_ID to the exact LiveChat agent email/user id that owns LIVECHAT_PAT');
      // This is a deterministic configuration error, not a transient provider failure.
      // 422 keeps the durable ingress worker from retrying the same impossible job.
      er.status=422; er.code='LIVECHAT_REQUESTER_USER_ID_REQUIRED'; er.retryable=false; throw er;
    }
    if(!identity.valid){
      const er=new Error(`LIVECHAT_REQUESTER_USER_ID_INVALID_FORMAT: requester identity format is invalid (${identity.reason}); use exact agent email/user id, not numeric license/account id`);
      er.status=422; er.code='LIVECHAT_REQUESTER_USER_ID_INVALID_FORMAT'; er.retryable=false; throw er;
    }
    try{
      await this.callClaimAction('add_user_to_chat',id,{
        chat_id:id,
        user_id:userId,
        user_type:'agent',
        visibility:'all',
        ignore_requester_presence:true
      },{retries:0});
      return {ok:true,added:true,userId};
    }catch(err){
      if(this.isChatInactiveError(err)) throw this.inactiveChatError(err);
      // A concurrent dashboard/worker action may have added the requester after send_event
      // received 403. Treat only a clear "already present" response as idempotent success.
      if(this.isAlreadyChatUserError(err)) return {ok:true,added:false,alreadyPresent:true,userId};
      if(Number(err?.status)===422 && /user_id.*not found|user.*not found/i.test(String(err?.message||err||''))){
        const er=new Error(`LIVECHAT_REQUESTER_USER_ID_INVALID: '${userId}' is not a valid LiveChat agent user_id for this license; set LIVECHAT_REQUESTER_USER_ID to the exact agent email/user id that owns LIVECHAT_PAT`);
        er.status=422; er.code='LIVECHAT_REQUESTER_USER_ID_INVALID'; er.retryable=false; er.cause=err; throw er;
      }
      if(this.isPublicAgentLimitError(err)){
        const er=new Error('LIVECHAT_PUBLIC_AGENT_LIMIT: Public agents in chat limit reached');
        er.status=422; er.code='LIVECHAT_PUBLIC_AGENT_LIMIT'; er.retryable=false; er.cause=err; throw er;
      }
      const er=new Error(`LIVECHAT_MEMBERSHIP_RECOVERY_FAILED: ${String(err?.message||err)}`);
      er.status=Number(err?.status)||502; er.cause=err; throw er;
    }
  }

  async sendEvent(chatId,event) {
    const id=String(chatId||'').trim();
    if(!id){ const er=new Error('LIVECHAT_CHAT_ID_REQUIRED'); er.status=400; throw er; }
    try{
      return await this.call('send_event',{chat_id:id,event},{retries:0});
    }catch(err){
      if(this.isChatInactiveError(err)) throw this.inactiveChatError(err);
      // Strict lane contract: sending a message is never allowed to mutate provider
      // membership. A 403 here means our local MY_CHAT view is stale or ownership changed.
      // Only the explicit Handle with AI / claim path may follow/add membership.
      // This prevents send_event -> add_user_to_chat retry storms and PUBLIC_AGENT_LIMIT.
      if(this.isRequesterMembershipError(err)) throw this.requesterMembershipRequiredError(err);
      throw err;
    }
  }

  sendMessage(chatId, text, {customId=null}={}) {
    const event={type:'message',text,visibility:'all'};
    if(customId) event.custom_id=String(customId).slice(0,128);
    return this.sendEvent(chatId,event);
  }

  async uploadFile(chatId, bytes, {name='image.jpg', contentType='image/jpeg'}={}) {
    if (!this.ready()) throw new Error('LIVECHAT_CREDENTIALS_MISSING');
    const id=String(chatId||'').trim();
    if(!id){ const er=new Error('LIVECHAT_CHAT_ID_REQUIRED'); er.status=400; throw er; }
    const data=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes||[]);
    if(!data.length){ const er=new Error('LIVECHAT_FILE_EMPTY'); er.status=400; throw er; }

    const form=new FormData();
    form.append('file',new Blob([data],{type:String(contentType||'application/octet-stream')}),String(name||'file'));
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),Math.max(this.timeoutMs,20000));
    try{
      const r=await fetch(`${this.base}/upload_file`,{
        method:'POST',
        headers:{'Authorization':this.authHeader()},
        body:form,
        signal:ctrl.signal
      });
      const txt=await r.text();
      let out; try{out=txt?JSON.parse(txt):{};}catch{out={raw:txt};}
      if(!r.ok){
        const er=new Error(`LIVECHAT_${r.status}: ${out?.error?.message||out?.message||txt.slice(0,300)}`);
        er.status=r.status; er.data=out; throw er;
      }
      const file=out?.file || out?.files?.[0] || out?.uploaded_file || out;
      const url=String(file?.url||file?.file_url||file?.download_url||out?.url||'').trim();
      if(!url){ const er=new Error('LIVECHAT_UPLOAD_URL_MISSING'); er.status=502; er.data=out; throw er; }
      return {url,name:String(file?.name||name),contentType:String(file?.content_type||file?.mime_type||contentType),size:Number(file?.size||data.length),raw:out};
    }finally{clearTimeout(timer);}
  }

  async sendFile(chatId, file={}) {
    const id=String(chatId||'').trim();
    const url=String(file?.url||'').trim();
    if(!id){ const er=new Error('LIVECHAT_CHAT_ID_REQUIRED'); er.status=400; throw er; }
    if(!url){ const er=new Error('LIVECHAT_FILE_URL_REQUIRED'); er.status=400; throw er; }
    // Agent Chat API v3.6 File event request accepts type/url/visibility (plus optional
    // custom_id/properties/alternative_text). Response-only metadata such as name,
    // content_type and size must not be sent back as request fields.
    const event={type:'file',url,visibility:'all'};
    const alternativeText=String(file?.alternativeText||file?.alternative_text||'').trim();
    if(alternativeText) event.alternative_text=alternativeText.slice(0,1000);
    return this.sendEvent(id,event);
  }

  async uploadAndSendFile(chatId, bytes, meta={}) {
    const uploaded=await this.uploadFile(chatId,bytes,meta);
    const sent=await this.sendFile(chatId,uploaded);
    return {uploaded,sent};
  }
  chatActiveFlag(chat={}) {
    const th=pickLatestThread(chat);
    if(typeof th?.active==='boolean') return th.active;
    if(typeof chat?.active==='boolean') return chat.active;
    const status=String(chat?.status||chat?.routing_status||th?.routing_status||'').toLowerCase();
    if(['closed','archived','inactive'].includes(status)) return false;
    if(status==='active') return true;
    return null;
  }
  async endChat(chatId) {
    const id=String(chatId||'').trim();
    if(!id){ const er=new Error('LIVECHAT_CHAT_ID_REQUIRED'); er.status=400; throw er; }
    // Agent Chat API v3.6 requires `id`. `ignore_requester_presence:true` is intentional:
    // this service may close a chat even when the API requester is not currently in chat.users.
    try{
      const response=await this.call('deactivate_chat',{id,ignore_requester_presence:true});
      return {ok:true,requestShape:'id',response};
    }catch(e){
      // Provider variants include both "chat is inactive" and "Chat not active".
      if(this.isChatInactiveError(e) || Number(e?.status)===404){
        return {ok:true,alreadyClosed:true,requestShape:'id'};
      }
      const er=new Error(`LIVECHAT_END_FAILED: ${String(e?.message||'unable to deactivate chat')}`);
      er.status=Number(e?.status)||502; er.cause=e; throw er;
    }
  }
  async prepareImageAttachments(attachments=[]) {
    const out=[];
    for(const a of (attachments||[]).filter(x=>x?.isImage).slice(0,3)) {
      const item={...a};
      const url=String(item.url||'');
      if(!/^https:\/\//i.test(url)) { out.push(item); continue; }
      try {
        const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),8000);
        const r=await fetch(url,{signal:ctrl.signal,redirect:'follow'}); clearTimeout(timer);
        if(!r.ok) throw new Error(`HTTP_${r.status}`);
        const ct=String(r.headers.get('content-type')||item.mime||'image/jpeg').split(';')[0];
        if(!ct.startsWith('image/')) throw new Error('NOT_IMAGE');
        const ab=await r.arrayBuffer();
        if(ab.byteLength>5*1024*1024) throw new Error('IMAGE_TOO_LARGE');
        item.url=`data:${ct};base64,${Buffer.from(ab).toString('base64')}`; item.mime=ct; item.prepared=true;
      } catch { item.prepared=false; }
      out.push(item);
    }
    return out;
  }
  async test() {
    const started = Date.now();
    const data = await this.listChats();
    const items = data?._normalizedChats || [];
    return {
      ok:true,
      connected:true,
      latencyMs:Date.now()-started,
      count:this.filterInbox(items).length,
      rawCount:items.length,
      myActiveCount:this.filterInbox(items).length,
      listSource:data?._listSource || 'none',
      foundChats:Number(data?.found_chats ?? items.length),
      hasNextPage:Boolean(data?.next_page_id),
      sampleChatIds:this.filterInbox(items).slice(0,5).map(x=>String(x?.id||'')).filter(Boolean),
      sampleStates:items.slice(0,10).map(x=>({id:String(x?.id||''),...this.chatState(x)})),
      requesterIdentity:this.requesterIdentityStatus()
    };
  }
}

export function extractChatEvents(chat) {
  const out = [];
  const seen = new Set();
  const eventGroups = [];
  const visited = new Set();

  function walk(node, owner=null, depth=0) {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node.events)) eventGroups.push({ owner: node, events: node.events });
    if (Array.isArray(node)) { for (const x of node) walk(x, owner, depth+1); return; }
    for (const [k,v] of Object.entries(node)) { if (k !== 'events' && v && typeof v === 'object') walk(v, node, depth+1); }
  }
  walk(chat);

  function collectAttachments(ev) {
    const arr=[]; const seenUrl=new Set();
    const candidates=[];
    if(Array.isArray(ev?.attachments)) candidates.push(...ev.attachments);
    if(Array.isArray(ev?.files)) candidates.push(...ev.files);
    if(ev?.file && typeof ev.file==='object') candidates.push(ev.file);
    if(ev?.image && typeof ev.image==='object') candidates.push(ev.image);
    if(ev?.content && typeof ev.content==='object') {
      if(Array.isArray(ev.content.attachments)) candidates.push(...ev.content.attachments);
      if(ev.content.file) candidates.push(ev.content.file);
      if(ev.content.image) candidates.push(ev.content.image);
    }
    const type=String(ev?.type||ev?.event_type||'').toLowerCase();
    if(['file','image'].includes(type)) candidates.push(ev);
    for(const a of candidates){
      if(!a || typeof a!=='object') continue;
      const url=a.url||a.image_url||a.file_url||a.download_url||a.secure_url||a.src||a?.content?.url||null;
      if(!url || seenUrl.has(url)) continue; seenUrl.add(url);
      const mime=String(a.content_type||a.mime_type||a.mime||a.type||'').toLowerCase();
      const name=String(a.name||a.file_name||a.filename||'');
      const isImage=mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)(?:\?|$)/i.test(String(url)) || /\.(png|jpe?g|webp|gif)$/i.test(name) || type==='image';
      arr.push({url:String(url),mime,name,isImage});
    }
    return arr.slice(0,8);
  }

  for (const {owner,events} of eventGroups) {
    for (const ev of events) {
      const type = String(ev?.type || ev?.event_type || ev?.event?.type || '').toLowerCase();
      let text = ev?.text;
      if (!text && typeof ev?.content?.text === 'string') text = ev.content.text;
      if (!text && typeof ev?.message?.text === 'string') text = ev.message.text;
      if (!text && typeof ev?.event?.text === 'string') text = ev.event.text;
      if (!text && Array.isArray(ev?.elements)) text = ev.elements.map(x=>x?.title||x?.text||x?.subtitle||'').filter(Boolean).join(' ');
      const attachments=collectAttachments(ev);
      text = String(text || '').trim();
      if (!text && attachments.length) text = attachments.some(a=>a.isImage) ? '[Member mengirim gambar]' : '[Member mengirim file]';
      if (!text) continue;
      if (type && !['message','rich_message','file','image'].includes(type) && !attachments.length) continue;
      const createdAt = ev?.created_at || owner?.created_at || new Date().toISOString();
      const ownerId = owner?.id ?? owner?.thread_id ?? '';
      const eventId = String(ev?.id ?? `${ownerId}:${createdAt}:${text}:${attachments.map(a=>a.url).join('|')}`);
      if (seen.has(eventId)) continue; seen.add(eventId);
      out.push({
        eventId, threadId:String(ownerId), createdAt, text, attachments,
        authorId: ev?.author_id || ev?.author?.id || ev?.user_id || '',
        authorType: ev?.author_type || ev?.author?.type || '', recipients: ev?.recipients || 'all'
      });
    }
  }
  return out.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
}

