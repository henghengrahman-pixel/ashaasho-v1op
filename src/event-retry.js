export function classifyCustomerEventError(error,attempts=1){
  const message=String(error?.message||error||'');
  const code=String(error?.code||message.match(/\b(?:LIVECHAT|OPENAI|AI|DB)_[A-Z0-9_]+\b/)?.[0]||'UNKNOWN').slice(0,160);
  const n=Math.max(1,Number(attempts)||1);
  if(/LIVECHAT_PUBLIC_AGENT_LIMIT|Public agents in chat limit reached/i.test(message)) return {errorClass:'OWNERSHIP',code:'LIVECHAT_PUBLIC_AGENT_LIMIT',retryable:true,blockedReason:'PUBLIC_AGENT_LIMIT',delayMs:120000};
  if(/LIVECHAT_MEMBERSHIP_REQUIRED|REQUESTER_NOT_CHAT_MEMBER|CHAT_NOT_IN_AI_LANE|CLAIM_OWNERSHIP/i.test(message)) return {errorClass:'OWNERSHIP',code,retryable:true,blockedReason:'CLAIM_REQUIRED',delayMs:120000};
  if(/LIVECHAT_CHAT_INACTIVE|No active chat thread|no active thread|EVENT_NOT_IN_PROVIDER_SNAPSHOT|EVENT_SESSION_OBSOLETE|closed chat|session obsolete|INVALID_EVENT|INVALID_PROVIDER_IDENTITY/i.test(message)) return {errorClass:'PERMANENT',code,retryable:false,terminal:true,delayMs:0};
  if(/AI_JSON_PARSE_FAILED|AI_SCHEMA_/i.test(message)) return {errorClass:'AI_PARSE',code,retryable:n<2,terminal:n>=2,delayMs:15000};
  if(/timeout|AbortError|ECONNRESET|ETIMEDOUT|EAI_AGAIN|\b5\d\d\b|temporar|database.*(?:restart|recover|unavailable)|connection.*(?:reset|terminated)/i.test(message)){
    const base=Math.min(300000,1000*(2**Math.min(n-1,8))); return {errorClass:'TRANSIENT',code,retryable:true,delayMs:base+Math.floor(Math.random()*Math.min(1000,base))};
  }
  const base=Math.min(300000,2000*(2**Math.min(n-1,7))); return {errorClass:'UNKNOWN',code,retryable:n<8,terminal:n>=8,delayMs:base+Math.floor(Math.random()*1000)};
}
