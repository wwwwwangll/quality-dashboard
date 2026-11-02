// Reserved transport. The shipped application only calls the mock channel.
// Enabling a real group is an IT deployment action, never a browser setting.
export function createWeComAdapter({mode='mock',webhook='',enableLive=false,transport=globalThis.fetch}={}){
 return {async send(message){
  if(mode==='mock')return {status:'mock',mock:true,result:'模拟消息，未向企业微信发送'};
  if(mode!=='wecom'||!enableLive)throw Error('真实通道尚未由公司IT启用');
  const target=new URL(webhook);if(target.protocol!=='https:'||target.hostname!=='qyapi.weixin.qq.com'||target.pathname!=='/cgi-bin/webhook/send'||!target.searchParams.get('key'))throw Error('企业微信群机器人地址无效');
  if(message.missingMapping||!message.payload?.text?.mentioned_list?.length)return {status:'blocked',result:'缺少责任人的企业微信UserID，不能实现真实@'};
  try{const response=await transport(target.href,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message.payload),signal:AbortSignal.timeout(10000)});if(!response.ok)return {status:'failed',retryable:response.status===429||response.status>=500,result:'企业微信HTTP错误 '+response.status};const data=await response.json();if(data.errcode!==0)return {status:'failed',retryable:[45009,-1].includes(data.errcode),code:data.errcode,result:'企业微信未受理，请按错误码核查'};return {status:'accepted',result:'接口已受理，不代表用户已读或已完成任务'};
  }catch{return {status:'unknown',retryable:false,result:'发送结果不明；为避免重复@，请先由管理员核查后再重试'};}
 }};
}
