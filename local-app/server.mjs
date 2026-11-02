import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createStore,appError} from './lib/store.mjs';
import {createAuth,hashPassword,verifyPassword,validatePassword,validatedUser,publicUser,permissionOptions,roles,requirePermission} from './lib/auth.mjs';
import {createImportService} from './lib/imports.mjs';
import {scopedData,requireRecord,canReadFile,isReader,isFreeze} from './lib/access.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const isLoopback=value=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(value);
const redact=value=>Array.isArray(value)?value.map(redact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[/secret|password|webhook|token/i.test(k)?k:k,/secret|password|webhook|token/i.test(k)?(v?'[已配置]':''):redact(v)])):value;

export async function startServer({dataDir,environment='test',port=0,host='127.0.0.1',testMode=false}={}){
 const [major,minor,patch]=process.versions.node.split('.').map(Number);if(major!==24||minor<22||minor===22&&patch<1)throw appError('请使用随包Node24.22.1或更高的24.x安全修复版启动',500);
 const store=createStore({dataDir,environment,testMode}),auth=createAuth(store),imports=createImportService({store}),app=express();
 const {createArchiveService}=await import('./lib/archive.mjs');
 const {createSystemService}=await import('./lib/system.mjs');
 const archive=createArchiveService({store,fileRoot:store.fileRoot}),system=createSystemService({store,fileRoot:store.fileRoot});
 const {createWorkflowService}=await import('./lib/workflow.mjs');
 const wf=createWorkflowService({store,fileRoot:store.fileRoot,onClosed:async item=>archive.generate(item)});
 const allowedHosts=new Set(['localhost','127.0.0.1','[::1]',...(process.env.QUALITY_ALLOWED_HOSTS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)]);
 app.disable('x-powered-by');
 if(process.env.QUALITY_TRUST_PROXY==='loopback')app.set('trust proxy','loopback');
 app.use((req,res,next)=>{
   res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'same-origin','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'"});
   let requestHost;try{const supplied=req.get('host')||'';if(!/^[\w.\-:[\]]+$/.test(supplied))throw Error();requestHost=new URL('http://'+supplied).hostname.toLowerCase();}catch{return res.status(400).json({error:'主机名无效'});}
   if(!allowedHosts.has(requestHost))return res.status(421).json({error:'此主机名尚未获准访问，请由IT配置QUALITY_ALLOWED_HOSTS'});
   if(req.path.startsWith('/api/')){
     if(req.headers['x-quality-test']==='true'&&environment!=='test')return res.status(403).json({error:'自动测试禁止访问正式环境'});
     const origin=req.get('origin');if(origin&&origin!==`${req.protocol}://${req.get('host')}`)return res.status(403).json({error:'禁止跨站请求'});
   }next();
 });
 app.use('/api/files',express.raw({type:()=>true,limit:'10mb'}));
 app.use(express.json({limit:'22mb'}));
 app.get('/api/status',(req,res)=>res.json({environment,initialized:store.list('users').some(u=>u.role==='admin'),application:'quality-dashboard-local',version:'4.1.0'}));
 const setCookie=(res,token)=>res.cookie(auth.cookieName,token,{httpOnly:true,sameSite:'strict',secure:process.env.QUALITY_HTTPS==='1',maxAge:8*3600*1000,path:'/'});
 app.post('/api/setup',async(req,res)=>{
   if(!isLoopback(req.socket.remoteAddress))throw appError('首次管理员只能在运行电脑本机创建',403);
   if(store.list('users').some(u=>u.role==='admin'))throw appError('管理员已初始化，请登录',409);
   const values=validatedUser({...req.body,role:'admin',permissions:['*'],enabled:true}),passwordHash=await hashPassword(req.body.password);
   if(store.list('users').some(u=>u.role==='admin'))throw appError('管理员已初始化，请登录',409);
   const user=store.put('users',randomUUID(),{...values,passwordHash,createdAt:new Date().toISOString(),mustChangePassword:false},{event:'setup.admin'});
   const session=await auth.login(user.username,req.body.password,req.socket.remoteAddress);setCookie(res,session.token);res.status(201).json({user:session.user,csrf:session.csrf});
 });
 app.post('/api/login',async(req,res)=>{const s=await auth.login(req.body.username,req.body.password,req.socket.remoteAddress);setCookie(res,s.token);res.json({user:s.user,csrf:s.csrf});});
 app.use('/api',(req,res,next)=>{const s=auth.session(req);if(!s)return res.status(401).json({error:'请先登录，或当前会话已失效'});req.auth=s;req.user=s.user;if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.get('x-csrf-token')!==s.csrf)return res.status(403).json({error:'操作校验失效，请刷新后重试'});if(s.user.mustChangePassword&&!['GET','HEAD','OPTIONS'].includes(req.method)&&!['/logout','/change-password'].includes(req.path))return res.status(403).json({error:'密码已重置，请先修改临时密码',code:'PASSWORD_CHANGE_REQUIRED'});next();});
 app.post('/api/logout',(req,res)=>{auth.logout(req.auth);res.clearCookie(auth.cookieName,{path:'/'});res.json({ok:true});});
 app.post('/api/change-password',async(req,res)=>{if(!await verifyPassword(req.body.currentPassword,req.user.passwordHash))throw appError('原密码不正确',400);validatePassword(req.body.password);const passwordHash=await hashPassword(req.body.password);store.put('users',req.user.id,{...req.user,passwordHash,mustChangePassword:false},{expectedVersion:req.user.version,actor:req.user,event:'user.password.change'});auth.invalidate(req.user.id);res.clearCookie(auth.cookieName,{path:'/'});res.json({ok:true,relogin:true});});
 app.use('/api',(req,res,next)=>{try{
  if(req.user.role==='admin')return next();
  const p=req.path,write=!['GET','HEAD','OPTIONS'].includes(req.method),personal=['/logout','/change-password'].includes(p);
  if(isReader(req.user)&&!personal&&(write||!['/bootstrap','/queues'].includes(p)&&!/^\/archives\/[^/]+\/pdf$/.test(p)))throw appError('此账号仅可查看本部门看板和8D报告',403);
  if(isFreeze(req.user)&&!personal&&write&&!/^\/analyses\/[^/]+\/commands$/.test(p))throw appError('变更管理员仅可填写分派的冻结编号',403);
  let match=p.match(/^\/analyses\/([^/]+)/)||p.match(/^\/archives\/([^/]+)/);if(match)requireRecord(store,req.user,'analyses',decodeURIComponent(match[1]));
  match=p.match(/^\/faults\/([^/]+)/);if(match)requireRecord(store,req.user,'faults',decodeURIComponent(match[1]));
  match=p.match(/^\/claims\/([^/]+)/);if(match)requireRecord(store,req.user,'claims',decodeURIComponent(match[1]));
  match=p.match(/^\/files\/([^/]+)/);if(match&&!canReadFile(store,req.user,decodeURIComponent(match[1])))throw appError('附件不存在或无查看权限',404);
  next();
 }catch(e){next(e)}});
 app.get('/api/bootstrap',(req,res)=>{const v=scopedData(store,req.user),ids=new Set(v.analyses.map(a=>a.id)),faultIds=new Set(v.faults.map(f=>f.id));res.json({user:publicUser(req.user),csrf:req.auth.csrf,users:store.list('users').filter(u=>req.user.role==='admin'||u.enabled!==false).map(publicUser),...v,analyses:isReader(req.user)?v.analyses.filter(a=>a.status==='closed').map(a=>({id:a.id,faultId:a.faultId,title:a.title,status:a.status,revised:a.revised})):v.analyses,preliminary:isReader(req.user)||isFreeze(req.user)?[]:store.list('preliminary').filter(p=>faultIds.has(p.faultId)),settings:req.user.role==='admin'?redact(store.list('settings')):[],archives:store.list('archive').filter(a=>ids.has(a.analysisId||a.id)).map(({snapshot,...metadata})=>metadata),...(req.user.role==='admin'?{backups:store.list('backups'),outbox:store.list('outbox').slice(-100)}:{}),environment,roles,permissionOptions,version:'4.1.0'});});
 app.delete('/api/users/:id',(req,res)=>{requirePermission(req.user,'users.manage');const old=store.get('users',req.params.id);if(!old)throw appError('账号不存在',404);if(old.role==='admin'&&store.list('users').filter(u=>u.role==='admin'&&u.enabled!==false&&!u.archived).length<=1)throw appError('不能移除最后一个有效管理员');const saved=store.put('users',old.id,{...old,enabled:false,archived:true,archivedAt:new Date().toISOString()},{expectedVersion:req.body.version,actor:req.user,event:'user.archive'});auth.invalidate(old.id);res.json(publicUser(saved));});
 app.get('/api/users',(req,res)=>{requirePermission(req.user,'users.manage');res.json(store.list('users').map(publicUser));});
 function duplicateUsername(username,exclude){if(store.list('users').some(u=>u.id!==exclude&&u.username.toLowerCase()===username.toLowerCase()))throw appError('用户名已存在',409);}
 app.post('/api/users',async(req,res)=>{requirePermission(req.user,'users.manage');const values=validatedUser(req.body);duplicateUsername(values.username);const passwordHash=await hashPassword(req.body.password);duplicateUsername(values.username);const user=store.put('users',randomUUID(),{...values,passwordHash,createdAt:new Date().toISOString(),mustChangePassword:false},{actor:req.user,event:'user.create'});res.status(201).json(publicUser(user));});
 app.patch('/api/users/:id',(req,res)=>{requirePermission(req.user,'users.manage');const old=store.get('users',req.params.id);if(!old)throw appError('账号不存在',404);if(req.body.version===undefined)throw appError('请提供账号版本号');const values=validatedUser(req.body,old);duplicateUsername(values.username,old.id);if(old.role==='admin'&&old.enabled!==false&&(values.role!=='admin'||!values.enabled)&&store.list('users').filter(u=>u.role==='admin'&&u.enabled!==false).length<=1)throw appError('不能停用或降级最后一个管理员');const user=store.put('users',old.id,{...old,...values},{expectedVersion:req.body.version,actor:req.user,event:'user.update'});auth.invalidate(old.id);res.json(publicUser(user));});
 app.post('/api/users/:id/reset-password',async(req,res)=>{requirePermission(req.user,'users.manage');const old=store.get('users',req.params.id);if(!old)throw appError('账号不存在',404);const passwordHash=await hashPassword(req.body.password);store.put('users',old.id,{...old,passwordHash,mustChangePassword:true},{expectedVersion:old.version,actor:req.user,event:'user.password.reset'});auth.invalidate(old.id);res.json({ok:true});});
 app.post('/api/files',(req,res)=>{
   if(!Buffer.isBuffer(req.body)||!req.body.length)throw appError('请上传非空文件');let name;try{name=decodeURIComponent(req.get('x-file-name')||'')}catch{throw appError('文件名编码无效')}name=path.basename(name.replaceAll('\\','/')).slice(0,200);if(!name||/\.(exe|com|cmd|bat|ps1|js|mjs|html?|svg|xml|scr|msi)$/i.test(name))throw appError('不允许上传可执行文件、脚本或网页');
   let type=(req.get('content-type')||'application/octet-stream').split(';')[0].toLowerCase();const b=req.body;
   if(type==='image/png'&&b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||type==='image/jpeg'&&b.subarray(0,3).toString('hex')!=='ffd8ff'||type==='image/webp'&&(b.subarray(0,4).toString()!=='RIFF'||b.subarray(8,12).toString()!=='WEBP')||type==='application/pdf'&&b.subarray(0,5).toString()!=='%PDF-')throw appError('文件内容与声明类型不一致');
   if(!['image/png','image/jpeg','image/webp','application/pdf'].includes(type))type='application/octet-stream';
   const id=randomUUID(),file={name,size:b.length,type,sha256:createHash('sha256').update(b).digest('hex'),uploadedBy:req.user.id,uploadedAt:new Date().toISOString()};fs.writeFileSync(path.join(store.fileRoot,id),b,{flag:'wx'});try{res.status(201).json(store.put('files',id,file,{actor:req.user,event:'file.upload'}))}catch(e){fs.unlinkSync(path.join(store.fileRoot,id));throw e}
 });
 app.get('/api/files/:id',(req,res)=>{const file=store.get('files',req.params.id);if(!file||!/^[\w.-]{1,200}$/.test(file.id)||file.id.startsWith('.'))throw appError('附件不存在',404);const p=path.join(store.fileRoot,file.id);if(!fs.existsSync(p))throw appError('附件内容缺失，请联系管理员恢复',404);const inline=['image/png','image/jpeg','image/webp','application/pdf'].includes(file.type);res.set('Content-Security-Policy',"default-src 'none'; sandbox");res.type(inline?file.type:'application/octet-stream');res.set('Content-Disposition',`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);res.sendFile(p);});
 app.get('/api/imports/templates',(req,res)=>{requirePermission(req.user,'imports.manage');res.type('text/csv; charset=utf-8').send(imports.template(req.query.kind));});
 app.post('/api/imports/preview',async(req,res)=>res.json(await imports.preview(req.body,req.user)));
 app.post('/api/imports/:id/commit',(req,res)=>res.json(imports.commit(req.params.id,req.body,req.user)));
 app.get('/api/imports/:id/errors.csv',(req,res)=>{requirePermission(req.user,'imports.manage');res.type('text/csv; charset=utf-8').send(imports.errorsCSV(req.params.id));});
 app.patch('/api/claims/:id/link',(req,res)=>{requirePermission(req.user,'imports.manage');const old=store.get('claims',req.params.id);if(!old)throw appError('索赔记录不存在',404);if(req.body.version===undefined)throw appError('请提供记录版本号');const ids=[...new Set(req.body.faultIds||[])];if(!Array.isArray(req.body.faultIds)||ids.length>100||ids.some(id=>typeof id!=='string'||!store.get('faults',id)))throw appError('请选择存在的报故单号');res.json(store.put('claims',old.id,{...old,faultIds:ids,faultId:ids[0]||'',linkUpdatedAt:new Date().toISOString()},{expectedVersion:req.body.version,actor:req.user,event:'claim.link'}));});
 app.patch('/api/claims/:id',(req,res)=>{
   const old=store.get('claims',req.params.id);if(!old)throw appError('索赔记录不存在',404);if(req.body.version===undefined)throw appError('请提供记录版本号');
   if(Object.keys(req.body).some(k=>!['version','faultId','status','deadline','note'].includes(k)))throw appError('此操作不能修改金额或其他源单字段');const next={...old};
   if(Object.hasOwn(req.body,'faultId')){requirePermission(req.user,'imports.manage');const faultId=String(req.body.faultId||'').trim();if(faultId&&!store.get('faults',faultId))throw appError('请选择存在的报故单号');Object.assign(next,{faultId,faultIds:faultId?[faultId]:[],linkUpdatedAt:new Date().toISOString()});}
   const progress=['status','deadline','note'].some(k=>Object.hasOwn(req.body,k));if(progress){requirePermission(req.user,'analysis.manage');const states=['待处理','处理中','待验证','已闭环'],aliases={'已关闭':'已闭环','已完成':'已闭环','已结案':'已闭环','关闭':'已闭环'},oldStatus=aliases[old.status]||old.status,proposed=req.body.status??oldStatus,oldIndex=Math.max(0,states.indexOf(oldStatus));if(!states.includes(proposed))throw appError('请选择有效处理状态');if(oldStatus==='已闭环'&&proposed!=='已闭环')throw appError('已闭环索赔不能直接重开');if(states.indexOf(proposed)>oldIndex+1)throw appError('请依次处理并提交验证，不能跳过阶段');if(proposed==='已闭环'&&oldStatus!=='已闭环')requirePermission(req.user,'tasks.review');const note=String(req.body.note??old.note??'').trim();if(!note||note.length>2000)throw appError('请填写2000字以内的处理措施或最新进展');const deadline=String(req.body.deadline??old.deadline??'');if(deadline&&(!/^\d{4}-\d{2}-\d{2}$/.test(deadline)||!Number.isFinite(Date.parse(deadline+'T00:00:00Z'))||new Date(deadline+'T00:00:00Z').toISOString().slice(0,10)!==deadline||deadline<old.date))throw appError('截止日期无效或早于索赔日期');Object.assign(next,{status:proposed,deadline,note,history:[...(old.history||[]),{at:new Date().toISOString(),actor:req.user.name,actorId:req.user.id,text:`${old.status} → ${proposed}；截止 ${deadline||'未设'}；${note}`}]});}
   if(!progress&&!Object.hasOwn(req.body,'faultId'))throw appError('没有可保存的变更');res.json(store.put('claims',old.id,next,{expectedVersion:req.body.version,actor:req.user,event:progress?'claim.progress':'claim.link'}));
 });
 app.post('/api/analyses',async(req,res)=>res.status(201).json(await wf.api('create',{user:req.user,body:req.body})));
 app.get('/api/analyses/:id',async(req,res)=>res.json(await wf.api('get',{user:req.user,id:req.params.id})));
 app.post('/api/analyses/:id/commands',async(req,res)=>res.json(await wf.api('command',{user:req.user,body:req.body,id:req.params.id})));
 app.get('/api/metrics',async(req,res)=>res.json(await wf.api('metrics',{user:req.user,body:req.query})));
 app.get('/api/queues',async(req,res)=>res.json(await wf.api('queues',{user:req.user,body:req.query})));
 app.post('/api/faults/:id/preliminary',async(req,res)=>res.json(await wf.api('preliminary',{user:req.user,body:req.body,id:req.params.id})));
 app.post('/api/faults/:id/assign',async(req,res)=>res.json(await wf.api('assign',{user:req.user,body:req.body,id:req.params.id})));
 app.get('/api/archives/:id/pdf',async(req,res)=>{const out=await archive.api('pdf',{user:req.user,id:req.params.id});res.type(out.type||'application/pdf');res.set('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(out.name||'8D.pdf')}`);res.send(out.buffer);});
 app.post('/api/archives/:id/retry',async(req,res)=>res.json(await archive.api('retry',{user:req.user,body:req.body,id:req.params.id})));
 app.post('/api/system/actions',async(req,res)=>{const {action,...body}=req.body;res.json(await system.api(action,{user:req.user,body,id:req.body.id}));});
 app.get('/api/audit',(req,res)=>{requirePermission(req.user,'system.manage');res.json(store.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all().map(r=>({...r,details:JSON.parse(r.details)})));});
 app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在'}));
 const allowedLegacy=new Set(['analysis-core.js','analysis-workflow.js','analysis-workflow-ui.js','analysis-dialogs.js','analysis.css','analysis-workflow.css','style.css','guide.html']);
 app.get('/legacy/:name',(req,res)=>{if(!allowedLegacy.has(req.params.name))return res.sendStatus(404);res.sendFile(path.join(here,'..','dist',req.params.name));});
 app.use(express.static(path.join(here,'public'),{dotfiles:'deny',index:'index.html',etag:false}));
 app.use((err,req,res,next)=>{if(res.headersSent)return next(err);const status=err.status||err.statusCode||500;res.status(status).json({error:status>=500?'服务处理失败，请查看本机日志并重试':err.message,details:err.details});if(status>=500)console.error('[quality-server]',err.stack);});
 const server=await new Promise((resolve,reject)=>{const s=app.listen(port,host,()=>resolve(s));s.once('error',reject)});if(!testMode)system.start?.();archive.resume?.().catch(e=>console.error('[archive-resume]',e.message));
 let closed=false;return {server,store,app,address:`http://${host}:${server.address().port}`,async close(){if(closed)return;closed=true;await system.stop?.();await new Promise(resolve=>server.close(resolve));store.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const environment=process.env.QUALITY_ENV||'test',dataDir=process.env.QUALITY_DATA_DIR||path.join(here,'data',environment);const host=process.env.QUALITY_HOST||'127.0.0.1',port=Number(process.env.QUALITY_PORT||3868);
 startServer({dataDir,environment,host,port}).then(runtime=>{console.log(`质量管理本机服务：${runtime.address} （${environment}）`);let stopping=false,controlTimer;const stop=()=>{if(stopping)return;stopping=true;clearInterval(controlTimer);runtime.close().finally(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);const controlFile=process.env.QUALITY_STOP_FILE,token=process.env.QUALITY_STOP_TOKEN;if(controlFile&&token&&path.resolve(controlFile).startsWith(path.join(here,'.run')+path.sep)){controlTimer=setInterval(()=>{if(!fs.existsSync(controlFile))return;try{const request=JSON.parse(fs.readFileSync(controlFile,'utf8').replace(/^\uFEFF/,''));if(request.token===token&&request.environment===environment&&request.pid===process.pid){fs.unlinkSync(controlFile);stop();}}catch{}},400);controlTimer.unref();}}).catch(error=>{console.error('启动失败：'+error.message);process.exitCode=1;});
}
