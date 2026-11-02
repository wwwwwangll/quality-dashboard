import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function verifyPackage({projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),release=false}={}){
 projectRoot=path.resolve(projectRoot);const appDir=path.join(projectRoot,'local-app'),failures=[],warnings=[],manifestPath=path.join(projectRoot,'RELEASE-MANIFEST.json');
 const required=['local-app/package.json','local-app/package-lock.json','local-app/server.mjs','local-app/lib/store.mjs','local-app/lib/auth.mjs','local-app/lib/imports.mjs','local-app/lib/workflow.mjs','local-app/lib/archive.mjs','local-app/lib/system.mjs','local-app/public/index.html','local-app/public/local-app.js','local-app/public/v4-ui.js','local-app/public/grid-ui.js','local-app/public/analysis-guide.js','local-app/public/task-sequence.js','local-app/scripts/account-profiles.mjs','local-app/public/d2-ui.js','local-app/public/required-fields.js','local-app/public/dashboard-v4.js','local-app/public/nine-grid-core.js','local-app/lib/access.mjs','local-app/lib/grid-service.mjs','local-app/assets/NotoSansSC-Regular.ttf','local-app/assets/FONT-LICENSE.txt','dist/analysis-core.js','dist/analysis-workflow.js','dist/analysis-workflow-ui.js','dist/analysis-dialogs.js'];
 for(const relative of required)if(!fs.existsSync(path.join(projectRoot,relative)))failures.push('缺少文件：'+relative);
 const runtime=path.join(appDir,'runtime','node.exe');if(!fs.existsSync(runtime)){(release?failures:warnings).push('缺少随包Windows运行时 local-app/runtime/node.exe（开发目录可使用已安装Node）');}
 if(release&&!fs.existsSync(path.join(appDir,'runtime','NODE-LICENSE.txt')))failures.push('缺少随包Node运行时许可证');
 let manifest;try{manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));}catch{(release?failures:warnings).push('缺少或无法解析 RELEASE-MANIFEST.json');}
 let files=[];if(manifest){if(Array.isArray(manifest.files))files=manifest.files;else if(manifest.files&&typeof manifest.files==='object')files=Object.entries(manifest.files).map(([p,v])=>typeof v==='string'?{path:p,sha256:v}:{path:p,...v});else failures.push('发布清单缺少files');}
 const seen=new Set();for(const entry of files){const relative=String(entry.path||'').replaceAll('\\','/'),segments=relative.split('/');if(!relative||path.isAbsolute(relative)||segments.includes('..')||seen.has(relative)){failures.push('清单路径无效或重复：'+relative);continue;}seen.add(relative);
   if(/^\.git(?:\/|$)|^\.openai(?:\/|$)|^local-app\/(?:data|backups|test-results)(?:\/|$)|^test-results(?:\/|$)/i.test(relative)||/\.(?:sqlite|sqlite-wal|sqlite-shm|db-wal|db-shm)$/i.test(relative)||/\/(?:\.env|\.env\.production)$/.test(relative)){failures.push('发布包禁止包含业务数据、备份或密钥：'+relative);continue;}
   const absolute=path.resolve(projectRoot,relative);if(!absolute.startsWith(projectRoot+path.sep)){failures.push('清单路径越界：'+relative);continue;}if(!fs.existsSync(absolute)||!fs.statSync(absolute).isFile()){failures.push('清单文件不存在：'+relative);continue;}if(fs.lstatSync(absolute).isSymbolicLink()){failures.push('发布包不接受符号链接：'+relative);continue;}
   const bytes=fs.readFileSync(absolute),hash=createHash('sha256').update(bytes).digest('hex');if(hash!==entry.sha256)failures.push('SHA256校验失败：'+relative);if(entry.size!==undefined&&bytes.length!==entry.size)failures.push('文件大小不匹配：'+relative);
 }
 if(release&&manifest)for(const relative of [...required,'local-app/runtime/node.exe'])if(!seen.has(relative))failures.push('发布清单未覆盖必要文件：'+relative);
 if(fs.existsSync(runtime)&&process.platform==='win32'){const child=spawnSync(runtime,['--version'],{encoding:'utf8',windowsHide:true,timeout:15000});const version=(child.stdout||'').trim(),major=Number(/^v(\d+)/.exec(version)?.[1]);const parts=/^v(\d+)\.(\d+)\.(\d+)$/.exec(version);if(child.status!==0||major!==24||!parts||Number(parts[2])<22||Number(parts[2])===22&&Number(parts[3])<1)failures.push('随包运行时版本不受支持：'+version);if(manifest?.runtime?.version&&manifest.runtime.version!==version)failures.push('运行时版本与发布清单不一致');}
 return {ok:failures.length===0,release,version:manifest?.version||'开发目录',checkedFiles:files.length,failures,warnings};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=verifyPackage({release:process.argv.includes('--release')});console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}

