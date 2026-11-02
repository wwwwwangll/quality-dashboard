// Contract rehearsal only. No database, environment secrets or real network calls.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createWeComAdapter} from '../lib/wecom-adapter.mjs';

const example=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../examples/wecom-config.example.json');
export async function runWeComCheck(config){
 if(config.mode!=='mock'||config.enableLive!==false)throw Error('此联调脚本仅允许mock配置，不启用真实发送');
 if(config.notifications?.mode!=='mock')throw Error('提醒配置必须明确mode=mock');
 const message={missingMapping:false,payload:{msgtype:'text',text:{content:'【模拟】任务超期\n事项：QA-SYNTHETIC 显示屏低温黑屏\n任务：复位时序复核\n责任人：模拟工程师\n截止：2026-10-29\n超期：1天\n处理入口：http://127.0.0.1:3868/#analysis/SYNTHETIC',mentioned_list:['SYNTHETIC-WECOM-ID']}}};
 const mock=await createWeComAdapter({mode:'mock',transport:()=>{throw Error('mock不得访问网络')}}).send(message);
 assert.equal(mock.status,'mock');
 let injectedCalls=0;
 const adapter=createWeComAdapter({mode:'wecom',enableLive:true,webhook:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SYNTHETIC-NOT-A-SECRET',transport:async(_url,options)=>{injectedCalls++;const payload=JSON.parse(options.body);assert.deepEqual(payload.text.mentioned_list,['SYNTHETIC-WECOM-ID']);return {ok:true,json:async()=>({errcode:0})}}});
 const blocked=await adapter.send({...message,missingMapping:true});assert.equal(blocked.status,'blocked');assert.equal(injectedCalls,0);
 const accepted=await adapter.send(message);assert.equal(accepted.status,'accepted');assert.equal(injectedCalls,1);
 return {passed:true,mode:'mock',realNetworkCalls:0,secretRead:false,checks:['模拟通道未外发','缺失企业微信UserID阻止真实@','消息包含text及mentioned_list','注入模拟响应验证接口受理状态'],payloadExample:message.payload,note:'接口受理测试使用注入的模拟传输；不代表已向公司群发送、真实@成功或用户已读。'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const config=JSON.parse(fs.readFileSync(process.argv[2]||example,'utf8'));console.log(JSON.stringify(await runWeComCheck(config),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
