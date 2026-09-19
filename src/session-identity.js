export function resolveGreetingSessionIdentity({threadId=null,eventId=null,createdAt=null}={}){
  const rawThreadKey=String(threadId||'').trim();
  const bannerEventKey=String(eventId||createdAt||'').trim();
  const providerThreadKey=rawThreadKey ? `thread:${rawThreadKey}` : null;
  return {
    rawThreadKey,bannerEventKey,providerThreadKey,
    greetingKey:providerThreadKey || `welcome:${bannerEventKey}`,
    boundarySource:providerThreadKey?'LIVECHAT_THREAD_ID':null
  };
}
