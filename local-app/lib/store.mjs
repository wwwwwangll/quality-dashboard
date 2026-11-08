import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function appError(message, status=400, details) {
  const e=new Error(message);e.status=status;if(details!==undefined)e.details=details;return e;
}
export function createStore({dataDir,environment='test',testMode=false}) {
  if(!['test','production'].includes(environment))throw appError('环境只能是 test 或 production');
  if(testMode&&environment!=='test')throw appError('自动测试禁止打开正式环境',403);
  if(!dataDir)throw appError('必须明确指定数据目录');
  dataDir=path.resolve(dataDir);
  if(testMode&&!/test|tmp|temp/i.test(dataDir))throw appError('自动测试只能使用明确标记的测试目录',403);
  fs.mkdirSync(dataDir,{recursive:true});
  const marker=path.join(dataDir,'.quality-environment.json');
  if(fs.existsSync(marker)){
    const old=JSON.parse(fs.readFileSync(marker,'utf8'));
    if(old.environment!==environment)throw appError('数据目录环境不匹配，禁止混用测试与正式数据',403);
  }else fs.writeFileSync(marker,JSON.stringify({application:'quality-dashboard-local',environment,createdAt:new Date().toISOString()},null,2),{flag:'wx'});
  const fileRoot=path.join(dataDir,'attachments');for(const d of ['attachments','pdfs','backups'])fs.mkdirSync(path.join(dataDir,d),{recursive:true});
  const db=new DatabaseSync(path.join(dataDir,'quality.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,actor TEXT NOT NULL,event TEXT NOT NULL,details TEXT NOT NULL);');
  const select=db.prepare('SELECT id,data,version FROM records WHERE kind=? AND id=?'),listStmt=db.prepare('SELECT id,data,version FROM records WHERE kind=? ORDER BY rowid');
  const unpack=r=>r?{...JSON.parse(r.data),id:r.id,version:r.version}:null;
  const hydrate=(kind,u)=>{if(u&&kind==='users'&&u.groupId)Object.defineProperty(u,'_group',{value:unpack(select.get('groups',u.groupId)),enumerable:false});return u;};
  const get=(kind,id)=>hydrate(kind,unpack(select.get(kind,String(id))));
  const list=kind=>listStmt.all(kind).map(r=>hydrate(kind,unpack(r)));
  const audit=(actor,event,details={})=>db.prepare('INSERT INTO audit(at,actor,event,details) VALUES(?,?,?,?)').run(new Date().toISOString(),typeof actor==='object'?actor.id||'system':String(actor||'system'),event,JSON.stringify(details));
  function put(kind,id,data,options={}){
    id=String(id);if(!id||id.length>200)throw appError('记录编号无效');const old=get(kind,id);
    if(options.expectedVersion!==undefined&&Number(options.expectedVersion)!==(old?.version||0))throw appError('记录已被其他人更新，请刷新后重试',409,{currentVersion:old?.version||0});
    const clean={...data};delete clean.version;delete clean.id;const version=(old?.version||0)+1;
    db.prepare('INSERT INTO records(kind,id,data,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at').run(kind,id,JSON.stringify(clean),version,new Date().toISOString());
    if(options.event)audit(options.actor,options.event,{...(options.details||{}),kind,id,version});return hydrate(kind,{...clean,id,version});
  }
  function remove(kind,id,options={}){
    const old=get(kind,id);if(!old)return false;if(options.expectedVersion!==undefined&&Number(options.expectedVersion)!==old.version)throw appError('记录版本冲突',409);
    db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);if(options.event)audit(options.actor,options.event,{kind,id});return true;
  }
  function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e}}
  return {db,dataDir,fileRoot,environment,get,list,put,remove,audit,transaction,close(){db.close()}};
}
