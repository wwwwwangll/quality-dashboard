import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {verifyPackage} from './verify-package.mjs';
const require=createRequire(import.meta.url),archiver=require('archiver');
const appDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.dirname(appDir),out=path.resolve(root,'../quality-v4-delivery');
const sourceRoots=['dist','local-app/lib','local-app/public','local-app/scripts','local-app/test','local-app/examples','local-app/assets'];
const sourceFiles=['README.md','4.1.0更新与审查核对.md','.github/workflows/quality-tests.yml','.gitignore','local-app/server.mjs','local-app/package.json','local-app/package-lock.json','开始使用.md','公司部署与DeepSeek交接.md','版本说明与测试报告.md','新版预览检查路线.md','开发清单-新版看板与九宫格.md','启动测试版.cmd','启动正式版.cmd','停止服务.cmd','备份数据.cmd','还原校验.cmd'];
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):e.isSymbolicLink()?[]:[path.join(dir,e.name)]);}
const relative=p=>path.relative(root,p).replaceAll('\\','/'),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const p of sourceFiles)if(!fs.existsSync(path.join(root,p)))throw Error('交付文件尚未就绪：'+p);
const source=[...sourceFiles,...sourceRoots.flatMap(r=>walk(path.join(root,r)).map(relative))].filter(p=>!p.endsWith('.map'));
const production=[...source,...walk(path.join(appDir,'node_modules')).map(relative),...walk(path.join(appDir,'runtime')).map(relative)];
fs.mkdirSync(out,{recursive:true});
const runtime=spawnSync(path.join(appDir,'runtime/node.exe'),['--version'],{encoding:'utf8',windowsHide:true});if(runtime.status!==0)throw Error('运行时不可用');
const sourceCommit=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).stdout?.trim()||'source-package';
const manifest={format:'quality-release-v1',version:JSON.parse(fs.readFileSync(path.join(appDir,'package.json'),'utf8')).version,sourceCommit,sourceDirty:!!spawnSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8',windowsHide:true}).stdout?.trim(),createdAt:new Date().toISOString(),runtime:{version:runtime.stdout.trim(),platform:'win32',arch:'x64'},files:[...new Set(production)].map(p=>{const b=fs.readFileSync(path.join(root,p));return {path:p,size:b.length,sha256:hash(b)};})};
fs.writeFileSync(path.join(root,'RELEASE-MANIFEST.json'),JSON.stringify(manifest,null,2));
const checked=verifyPackage({projectRoot:root,release:true});if(!checked.ok)throw Error(JSON.stringify(checked));
async function zip(name,files,extra={}){const dest=path.join(out,name),stream=fs.createWriteStream(dest),zip=archiver('zip',{zlib:{level:6}}),done=new Promise((resolve,reject)=>{stream.on('close',resolve);stream.on('error',reject);zip.on('error',reject);});zip.pipe(stream);for(const f of [...new Set(files)])zip.file(path.join(root,f),{name:'quality-dashboard/'+f});for(const[n,content]of Object.entries(extra))zip.append(content,{name:'quality-dashboard/'+n});await zip.finalize();await done;return {name,size:fs.statSync(dest).size,sha256:hash(fs.readFileSync(dest))};}
const artifacts=[];
for(const [label,environment]of [['本机测试包','test'],['正式空数据部署包','production']]){const launch='@echo off\r\nchcp 65001 >nul\r\ncall "%~dp0'+(environment==='test'?'启动测试版.cmd':'启动正式版.cmd')+'"\r\n';artifacts.push(await zip('质见质量管理-'+label+'-v'+manifest.version+'.zip',[...production,'RELEASE-MANIFEST.json'],{'立即启动.cmd':launch,'包类型说明.txt':(environment==='test'?'本包用于独立本机模拟预览，首次启动自动创建假数据与30个启用的随机密码测试账号（另保留4个历史账号），访问3870。':'本包初始无账号、无业务数据；正式部署须由公司指定人员确认。')+'\r\n先阅读开始使用.md。\r\n'}));}
artifacts.push(await zip('质见质量管理-完整源码-v'+manifest.version+'.zip',source,{'源码构建说明.txt':'源码不含业务数据、密码或数据库。使用Node24，在local-app执行npm ci，再运行测试。Windows离线运行依赖与运行时请使用完整部署包。\r\n'}));
fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),artifacts.map(a=>a.sha256+'  '+a.name).join('\r\n')+'\r\n');fs.writeFileSync(path.join(out,'release-results.json'),JSON.stringify({verified:checked,artifacts},null,2));console.log(JSON.stringify({out,artifacts,checkedFiles:checked.checkedFiles},null,2));
