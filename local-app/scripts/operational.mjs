import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStore,appError} from '../lib/store.mjs';
import {createSystemService} from '../lib/system.mjs';

const help=`本机运维工具（不覆盖在线数据库）
  node scripts/operational.mjs backup --environment test --data-dir "绝对数据目录"
  node scripts/operational.mjs verify-backup --environment test --data-dir "绝对数据目录" [--id 备份编号]
  node scripts/operational.mjs restore --environment test --data-dir "绝对数据目录" --id 备份编号 [--target "全新恢复目录"]
正式环境须明确 --environment production；恢复正式备份还须 --confirm-production。
restore只写入全新目录，默认创建原目录旁的 -restored-时间戳 目录，不切换或覆盖运行中的系统。
恢复完成后必须由IT核对数据，再停止服务、备份当前数据并人工切换数据目录。
`;
function parse(args){const options={};for(let i=1;i<args.length;i++){const key=args[i];if(key==='--confirm-production')options.confirmProduction=true;else if(['--environment','--data-dir','--id','--target'].includes(key)){if(!args[i+1]||args[i+1].startsWith('--'))throw appError(key+'缺少参数');options[{'--environment':'environment','--data-dir':'dataDir','--id':'id','--target':'target'}[key]]=args[++i];}else throw appError('未知参数：'+key);}return options;}
export async function runOperational(args,write=value=>console.log(value)){
 const action=args[0];if(!action||['help','--help','-h'].includes(action)){write(help);return {help:true};}
 if(!['backup','verify-backup','restore'].includes(action))throw appError('操作仅支持backup、verify-backup或restore');
 const options=parse(args);if(!['test','production'].includes(options.environment)||!options.dataDir)throw appError('必须明确指定 --environment 和 --data-dir');
 const dataDir=path.resolve(options.dataDir),marker=path.join(dataDir,'.quality-environment.json');
 if(!fs.existsSync(marker)||!fs.existsSync(path.join(dataDir,'quality.sqlite')))throw appError('数据目录不存在或没有环境标记，不会自动创建空库');
 if(JSON.parse(fs.readFileSync(marker,'utf8')).environment!==options.environment)throw appError('数据目录与指定环境不匹配');
 if(action==='restore'&&options.environment==='production'&&!options.confirmProduction)throw appError('恢复正式备份必须由操作人明确添加 --confirm-production');
 const store=createStore({dataDir,environment:options.environment,testMode:options.environment==='test'}),service=createSystemService({store,fileRoot:store.fileRoot});
 const operator={id:'local-operator',role:'admin',name:'本机运维操作人'};
 try{
   if(action==='backup'){const result=await service.api('backup',{user:operator,body:{reason:'本机运维脚本手动备份'}});write(JSON.stringify(result,null,2));return result;}
   const id=options.id||store.list('backups').filter(b=>b.status==='ready').at(-1)?.id;if(!id)throw appError('没有可验证的备份，请指定 --id');
   const verified=await service.api('verify-backup',{user:operator,body:{id}});if(!verified.ok)throw appError('备份验证失败，禁止恢复',400,verified);
   if(action==='verify-backup'){write(JSON.stringify(verified,null,2));return verified;}
   const target=path.resolve(options.target||dataDir+'-restored-'+Date.now()),sourceReal=fs.realpathSync(dataDir);
   if(fs.existsSync(target))throw appError('恢复目标必须是尚不存在的全新目录，禁止覆盖');
   let ancestor=path.dirname(target),suffix=path.basename(target);while(!fs.existsSync(ancestor)){suffix=path.join(path.basename(ancestor),suffix);ancestor=path.dirname(ancestor);}
   const targetReal=path.resolve(fs.realpathSync(ancestor),suffix);if(targetReal===sourceReal||targetReal.startsWith(sourceReal+path.sep)||sourceReal.startsWith(targetReal+path.sep))throw appError('恢复目录必须独立于原数据目录，禁止写入原库或其父目录');
   // cpSync creates the new destination itself; precreating it conflicts with
   // errorOnExist on current Node releases and would weaken the no-overwrite rule.
   fs.cpSync(verified.restoredTo,target,{recursive:true,force:false,errorOnExist:true,dereference:false});
   fs.writeFileSync(path.join(target,'.quality-environment.json'),JSON.stringify({application:'quality-dashboard-local',environment:options.environment,restoredAt:new Date().toISOString(),backupId:id,sourceDataDir:dataDir},null,2),{flag:'wx'});
   const restored=createStore({dataDir:target,environment:options.environment,testMode:options.environment==='test'});let counts;try{restored.db.exec('DELETE FROM sessions');counts=restored.db.prepare('SELECT kind,count(*) count FROM records GROUP BY kind').all();restored.audit(operator,'restore.completed',{backupId:id,sourceEnvironment:options.environment,sessionsInvalidated:true});}finally{restored.close();}
   const result={ok:true,environment:options.environment,backupId:id,target,counts,sessionsInvalidated:true,switchedLiveSystem:false};write(JSON.stringify(result,null,2));return result;
 }finally{await service.stop();store.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runOperational(process.argv.slice(2)).catch(error=>{console.error('运维操作失败：'+error.message);if(error.details)console.error(JSON.stringify(error.details));process.exitCode=1;});
