/* 用户手动在旧版看板浏览器控制台运行。只读原记录、只读附件，不访问网络、不删除数据。
   大于17MB时自动拆成多个JSON；先导入01附件包，再导入02报故/索赔包，最后导入03分析包。
   浏览器如询问多个文件下载，请允许；清单文件仅用于核对，不需要导入。 */
(async()=>{
 'use strict';
 const read=key=>{const raw=localStorage.getItem(key);if(!raw)return [];let rows;try{rows=JSON.parse(raw)}catch{throw Error(key+'不是有效JSON，已停止，原内容未改动');}if(!Array.isArray(rows))throw Error(key+'不是数组，已停止，原内容未改动');return rows;};
 const analyses=read('quality-analysis-v2'),faults=read('quality-faults-v2'),claims=read('quality-insight-records-v1'),references=new Map(),missingFileIds=[],exported=[];
 function scan(v){if(!v||typeof v!=='object')return;if(Array.isArray(v.files))for(const file of v.files)if(file?.id)references.set(String(file.id),file);for(const [key,value]of Object.entries(v))if(key!=='files'&&value&&typeof value==='object')Array.isArray(value)?value.forEach(scan):scan(value);}
 analyses.forEach(scan);
 const stamp=new Date().toISOString().replace(/[:.]/g,'-'),maxBytes=17*1024*1024,encoder=new TextEncoder();let part=0;
 const download=(bundle,name)=>{const blob=new Blob([JSON.stringify(bundle)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);exported.push({name,size:blob.size,counts:{files:bundle.files?.length||0,faults:bundle.faults?.length||0,claims:bundle.claims?.length||0,analyses:bundle.analyses?.length||0}});};
 function chunks(rows,key,prefix){let batch=[],size=0;for(const row of rows){const bytes=encoder.encode(JSON.stringify(row)).length;if(bytes>maxBytes)throw Error('单条记录超过17MB，请联系IT拆分，原记录未改动');if(batch.length&&size+bytes>maxBytes){download({format:'quality-browser-migration-v1',faults:[],claims:[],analyses:[],files:[],[key]:batch},prefix+'-'+stamp+'-'+(++part)+'.json');batch=[];size=0;}batch.push(row);size+=bytes;}if(batch.length)download({format:'quality-browser-migration-v1',faults:[],claims:[],analyses:[],files:[],[key]:batch},prefix+'-'+stamp+'-'+(++part)+'.json');}
 let database=null;try{
   let exists=true;if(indexedDB.databases)exists=(await indexedDB.databases()).some(d=>d.name==='quality-analysis-files-v2');
   if(exists)database=await new Promise((resolve,reject)=>{const request=indexedDB.open('quality-analysis-files-v2');request.onupgradeneeded=()=>request.transaction.abort();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('旧附件库无法读取或不存在'));});
 }catch(e){console.warn(e.message);}
 const get=(key)=>new Promise((resolve,reject)=>{const transaction=database.transaction('files','readonly'),request=transaction.objectStore('files').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('读取附件失败：'+key));});
 const toBase64=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('附件编码失败'));reader.readAsDataURL(blob);});
 let fileBatch=[],fileBytes=0;
 try{let ids=[...references.keys()];if(database?.objectStoreNames.contains('files')){const keys=await new Promise((resolve,reject)=>{const request=database.transaction('files','readonly').objectStore('files').getAllKeys();request.onsuccess=()=>resolve(request.result);request.onerror=reject;});ids=[...new Set([...ids,...keys.map(String)])];}
   for(const id of ids){let stored=database?.objectStoreNames.contains('files')?await get(id):null;const blob=stored instanceof Blob?stored:stored?.blob instanceof Blob?stored.blob:null;if(!blob){missingFileIds.push(id);continue;}const metadata=references.get(id)||{},base64=await toBase64(blob),bytes=await blob.arrayBuffer(),hash=crypto.subtle?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join(''):undefined,file={id,name:metadata.name||stored.name||id,type:metadata.type||blob.type||'application/octet-stream',size:blob.size,base64,...(hash?{sha256:hash}:{})},size=encoder.encode(JSON.stringify(file)).length;
     if(size>maxBytes)throw Error('单个附件超过可导入上限，请联系IT处理：'+file.name);if(fileBatch.length&&fileBytes+size>maxBytes){chunks(fileBatch,'files','01-旧版附件');fileBatch=[];fileBytes=0;}fileBatch.push(file);fileBytes+=size;console.info('已读取附件：'+file.name);
   }
   chunks(fileBatch,'files','01-旧版附件');chunks(faults,'faults','02-旧版报故');chunks(claims,'claims','02-旧版索赔');chunks(analyses,'analyses','03-旧版8D');
   const manifest={format:'quality-browser-migration-manifest-v1',createdAt:new Date().toISOString(),counts:{faults:faults.length,claims:claims.length,analyses:analyses.length,referencedFiles:references.size},parts:exported.slice(),missingFileIds:[...new Set(missingFileIds)],instructions:'原数据未修改。先导入01附件包，再02报故及索赔，最后03分析包；确认人员映射。此清单文件无需导入。'};
   download(manifest,'00-旧版迁移核对清单-'+stamp+'.json');console.info('导出完成；原数据未改动。',manifest);if(missingFileIds.length)console.warn('以下附件原库中缺失，请先补齐：',missingFileIds);
 }finally{database?.close();}
})().catch(error=>console.error('导出停止，原数据未改动：'+error.message));
