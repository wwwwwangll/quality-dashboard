import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync, backup} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const args=process.argv.slice(2),option=(name,defaultValue)=>args[args.indexOf(name)+1]||defaultValue;
const requested=args.includes('--target')?option('--target'):'';
if(!requested)throw Error('请提供 --target 已有quality-dashboard目录');
const target=fs.realpathSync(path.resolve(requested)),app=path.join(target,'local-app');
const patchDir=args.includes('--patch')?path.resolve(option('--patch')):path.dirname(fileURLToPath(import.meta.url)),patch=JSON.parse(fs.readFileSync(path.join(patchDir,'PATCH.json'),'utf8'));
const port=Number(args.includes('--port')?option('--port'):3870);
if(path.basename(target)!=='quality-dashboard'||!Number.isInteger(port)||port<1024||port>65535)throw Error('安装路径或端口无效');
const data=path.join(app,'data/test'),marker=JSON.parse(fs.readFileSync(path.join(data,'.quality-environment.json'),'utf8'));
if(marker.environment!=='test')throw Error('此修补器仅用于本机测试环境');
const pkg=JSON.parse(fs.readFileSync(path.join(app,'package.json'),'utf8'));
if(patch.format!=='quality-patch-v1'||!['4.1.0','4.1.1','4.2.0'].includes(pkg.version)||patch.version!=='4.2.0')throw Error('只支持本机测试版4.1.0/4.1.1/4.2.0升级至4.2.0');
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const f of patch.files){
 if(!/^(?:local-app\/(?:lib|public|test|scripts)\/[\w./-]+|local-app\/(?:package(?:-lock)?\.json|server\.mjs)|dist\/analysis-workflow\.js|\.gitignore|[^/]+\.md)$/.test(f.path)||f.path.split('/').includes('..'))throw Error('补丁路径无效');
 const source=path.resolve(patchDir,'files',f.path);
 if(!source.startsWith(path.resolve(patchDir,'files')+path.sep)||hash(fs.readFileSync(source))!==f.sha256)throw Error('补丁内容校验失败：'+f.path);
}
let {verifyPackage}=await import(pathToFileURL(path.join(app,'scripts/verify-package.mjs')));
const checked=verifyPackage({projectRoot:target,release:true});if(!checked.ok)throw Error(JSON.stringify(checked));
if(args.includes('--dry-run')){console.log(JSON.stringify({ok:true,preflight:true,from:pkg.version,to:patch.version,files:patch.files.length}));process.exit(0);}
function powershell(script,extra=[]){const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(app,'scripts',script),...extra],{encoding:'utf8',windowsHide:true,timeout:90000});if(r.status!==0)throw Error(script+'失败：'+r.stdout+r.stderr);}
function recordsDigest(){const db=new DatabaseSync(path.join(data,'quality.sqlite'),{readOnly:true});try{return hash(JSON.stringify(db.prepare('SELECT kind,id,data,version FROM records ORDER BY kind,id').all()));}finally{db.close();}}
function inventory(dir,base=dir){if(!fs.existsSync(dir))return [];return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('业务资料目录存在链接，停止自动升级');return e.isDirectory()?inventory(p,base):[{path:path.relative(base,p),sha256:hash(fs.readFileSync(p))}];});}
const stamp=Date.now(),saved=path.join(app,'upgrade-backups','grid-4.2.0-'+stamp),savedData=path.join(saved,'test-data');
fs.mkdirSync(savedData,{recursive:true});
let stopped=false,changed=false;
try{
 powershell('stop.ps1',['-Environment','test']);stopped=true;
 const before=recordsDigest(),filesBefore=JSON.stringify([inventory(path.join(data,'attachments')),inventory(path.join(data,'pdfs'))]);
 const db=new DatabaseSync(path.join(data,'quality.sqlite'),{readOnly:true});try{await backup(db,path.join(savedData,'quality.sqlite'));}finally{db.close();}
 for(const dir of ['attachments','pdfs'])if(fs.existsSync(path.join(data,dir)))fs.cpSync(path.join(data,dir),path.join(savedData,dir),{recursive:true});
 fs.copyFileSync(path.join(target,'RELEASE-MANIFEST.json'),path.join(saved,'RELEASE-MANIFEST.json'));
 for(const f of patch.files){const dest=path.join(target,f.path),copy=path.join(saved,'code',f.path);if(fs.existsSync(dest)){fs.mkdirSync(path.dirname(copy),{recursive:true});fs.copyFileSync(dest,copy);}}
 changed=true;
 for(const f of patch.files){const dest=path.join(target,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(patchDir,'files',f.path),dest);}
 const manifest=JSON.parse(fs.readFileSync(path.join(saved,'RELEASE-MANIFEST.json'),'utf8'));
 Object.assign(manifest,{version:patch.version,sourceCommit:patch.sourceCommit,sourceDirty:false,createdAt:new Date().toISOString()});
 for(const f of patch.files){const entry=manifest.files.find(x=>x.path===f.path);if(entry)Object.assign(entry,f);else manifest.files.push(f);}
 fs.writeFileSync(path.join(target,'RELEASE-MANIFEST.json'),JSON.stringify(manifest,null,2));
 ({verifyPackage}=await import(pathToFileURL(path.join(app,'scripts/verify-package.mjs')).href+'?upgrade='+stamp));
 const verified=verifyPackage({projectRoot:target,release:true});if(!verified.ok)throw Error(JSON.stringify(verified));
 if(recordsDigest()!==before||JSON.stringify([inventory(path.join(data,'attachments')),inventory(path.join(data,'pdfs'))])!==filesBefore)throw Error('业务记录或资料核验失败');
 powershell('start.ps1',['-Environment','test','-Port',String(port),'-NoBrowser']);stopped=false;
 const status=await (await fetch('http://127.0.0.1:'+port+'/api/status')).json();if(status.version!==patch.version)throw Error('服务版本不符');
 console.log(JSON.stringify({ok:true,version:status.version,url:'http://127.0.0.1:'+port+'/',businessRecordsUnchanged:true,attachmentsUnchanged:true,backup:saved,checkedFiles:verified.checkedFiles}));
}catch(error){
 if(changed){if(!stopped)powershell('stop.ps1',['-Environment','test']);for(const f of patch.files){const old=path.join(saved,'code',f.path);if(fs.existsSync(old))fs.copyFileSync(old,path.join(target,f.path));}fs.copyFileSync(path.join(saved,'RELEASE-MANIFEST.json'),path.join(target,'RELEASE-MANIFEST.json'));stopped=true;}
 if(stopped)try{powershell('start.ps1',['-Environment','test','-Port',String(port),'-NoBrowser']);}catch(restart){console.error('服务重启失败：'+restart.message);}
 throw error;
}
