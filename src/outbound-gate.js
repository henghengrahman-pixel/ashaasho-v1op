export function evaluateAiOutboundState(state){
  if(!state) return {allowed:false,reason:'CONVERSATION_MISSING',lane:'OTHER'};
  const lane=String(state.lc_lane||'OTHER').toUpperCase();
  const status=String(state.status||'active').toLowerCase();
  const handlingMode=String(state.handling_mode||'AI').toUpperCase();
  const handlingState=String(state.handling_state||'').toUpperCase();
  if(status==='closed' || state.lc_active===false) return {allowed:false,reason:'CHAT_INACTIVE',lane};
  if(handlingMode==='HUMAN' || ['HUMAN_ACTIVE','HUMAN_TAKEOVER'].includes(handlingState)) return {allowed:false,reason:'HUMAN_TAKEOVER_ACTIVE',lane};
  if(lane!=='MY_CHAT') return {allowed:false,reason:'CHAT_NOT_IN_AI_LANE',lane};
  return {allowed:true,reason:null,lane};
}
