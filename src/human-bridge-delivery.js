function text(v){return String(v??'').trim();}

export function isLiveChatMembershipRequired(err){
  if(!err)return false;
  const code=String(err?.code||'').toUpperCase();
  if(code==='LIVECHAT_MEMBERSHIP_REQUIRED')return true;
  if(Number(err?.status)===403 && /requester\s+is\s+not\s+(?:a\s+)?user\s+of\s+the\s+chat/i.test(String(err?.message||'')))return true;
  return err?.cause ? isLiveChatMembershipRequired(err.cause) : false;
}

function ownershipError(lane='OTHER',cleanup=null){
  const er=new Error(`LIVECHAT_CLAIM_OWNERSHIP_NOT_CONFIRMED: provider lane is ${String(lane||'OTHER').toUpperCase()}`);
  er.code='LIVECHAT_CLAIM_OWNERSHIP_NOT_CONFIRMED';
  er.status=409;
  er.retryable=false;
  if(cleanup) er.claimCleanup=cleanup;
  return er;
}

/**
 * Human Bridge actions are explicit operator actions, so they may perform the same
 * controlled claim used by Handle With AI when provider membership is missing.
 * This is intentionally NOT used by the generic send_event path or automatic AI send.
 * Recovery is attempted at most once for a delivery.
 */
export async function sendHumanBridgeWithControlledClaim({livechat,chatId,send,onClaimed=null}={}){
  const id=text(chatId);
  if(!id) throw new Error('LIVECHAT_CHAT_ID_REQUIRED');
  if(!livechat || typeof livechat.claimChat!=='function') throw new Error('LIVECHAT_CLIENT_REQUIRED');
  if(typeof send!=='function') throw new Error('LIVECHAT_SEND_FUNCTION_REQUIRED');

  try{
    return {sent:await send(),recovered:false,claim:null};
  }catch(firstError){
    if(!isLiveChatMembershipRequired(firstError)) throw firstError;

    const claimed=await livechat.claimChat(id,{ensureMembership:true});
    const lane=String(claimed?.lane||'OTHER').toUpperCase();
    if(lane!=='MY_CHAT'){
      let cleanup=null;
      if(typeof livechat.rollbackClaimFollow==='function'){
        try{ cleanup=await livechat.rollbackClaimFollow(id,claimed,{reason:'HUMAN_BRIDGE_OWNERSHIP_NOT_CONFIRMED'}); }
        catch(cleanupError){
          const er=ownershipError(lane,cleanupError?.claimCleanup||{attempted:true,ok:false,error:String(cleanupError?.message||cleanupError)});
          er.cause=cleanupError;
          throw er;
        }
      }
      const er=ownershipError(lane,cleanup);
      er.cause=firstError;
      throw er;
    }

    if(typeof onClaimed==='function') await onClaimed(claimed);
    // Exactly one retry after a verified controlled claim. If the provider still says the
    // requester is not a member, surface the real error; never loop or mutate membership again.
    return {sent:await send(),recovered:true,claim:claimed};
  }
}
