import {randomBytes,createHash,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {appError} from './store.mjs';

const scrypt=promisify(scryptCallback);
let passwordOperations=0;
async function derive(password,salt){if(passwordOperations>=2)throw appError('密码验证繁忙，请稍后重试',429);passwordOperations++;try{return await scrypt(password,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024});}finally{passwordOperations--;}}
export const permissionOptions=[
 ['analysis.manage','管理8D、团队和阶段'],['analysis.start','开启8D'],['tasks.assign','分派任务'],['tasks.review','验收、判责和关单'],['tasks.transfer','转交自己的未完成任务'],['imports.manage','导入OA数据'],['preliminary.write','填写自己的初步失效分析'],['freeze.number.write','填写分派的冻结编号']
].map(([key,label])=>({key,label}));
export const roles=[{id:'admin',name:'管理员'},{id:'quality-engineer',name:'质量工程师'},{id:'failure-analyst',name:'失效分析人员'},{id:'worker',name:'执行人员'},{id:'viewer',name:'看板与报告查看'},{id:'freeze-clerk',name:'变更管理员'}];
const business=permissionOptions.map(p=>p.key);
const defaults={'admin':['*'],'quality-engineer':business,'failure-analyst':['preliminary.write','tasks.transfer'],'worker':['tasks.transfer'],'viewer':[],'freeze-clerk':['freeze.number.write']};
export const permissionsFor=user=>user?.enabled===false?[]:user?.role==='admin'?['*']:Array.isArray(user?.permissions)?user.permissions.filter(p=>business.includes(p)):defaults[user?.role]||[];
export const hasPermission=(user,key)=>!!user&&user.enabled!==false&&(user.role==='admin'||(!['users.manage','system.manage'].includes(key)&&permissionsFor(user).includes(key)));
export function requirePermission(user,key){if(!hasPermission(user,key))throw appError('当前账号没有此操作权限',403)}
export function publicUser(user){if(!user)return null;return {id:user.id,version:user.version,username:user.username,name:user.name,dept:user.dept||'',role:user.role,permissions:permissionsFor(user),enabled:user.enabled!==false,archived:!!user.archived,wecomUserId:user.wecomUserId||'',mustChangePassword:!!user.mustChangePassword,createdAt:user.createdAt};}
export function validatePassword(value){if(typeof value!=='string'||value.length<10||value.length>128)throw appError('密码须为10至128位');return value;}
export async function hashPassword(password){validatePassword(password);const salt=randomBytes(24).toString('hex');const hash=await derive(password,salt);return `scrypt-v1$${salt}$${hash.toString('hex')}`;}
export async function verifyPassword(password,encoded){if(typeof password!=='string'||password.length>128)return false;const [type,salt,hex]=String(encoded||'').split('$');if(type!=='scrypt-v1'||!salt||!/^[a-f0-9]{128}$/.test(hex||''))return false;const hash=await derive(password,salt);return timingSafeEqual(hash,Buffer.from(hex,'hex'));}
export function validatedUser(input,old=null){
 const role=input.role??old?.role??'worker';if(!roles.some(r=>r.id===role))throw appError('账号角色无效');
 const username=String(input.username??old?.username??'').trim();if(!/^[\p{L}\p{N}_.@-]{3,64}$/u.test(username))throw appError('用户名须为3至64位字母、数字或_.@-');
 const name=String(input.name??old?.name??'').trim();if(!name||name.length>80)throw appError('请填写有效姓名');
 const permissions=input.permissions??old?.permissions??defaults[role];if(!Array.isArray(permissions)||role!=='admin'&&permissions.some(p=>!business.includes(p)))throw appError('权限配置无效，非管理员不能取得账号或系统管理权限');
 if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw appError('账号启用状态必须是布尔值');
 return {username,name,dept:String(input.dept??old?.dept??'').trim().slice(0,80),role,permissions:role==='admin'?['*']:[...new Set(permissions)],enabled:input.enabled??old?.enabled??true,wecomUserId:String(input.wecomUserId??old?.wecomUserId??'').trim().slice(0,128)};
}
export function createAuth(store){
 const cookieName='quality_session_'+store.environment;
 const attempts=new Map();
 function session(req){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;const tokenHash=createHash('sha256').update(token).digest('hex');const s=store.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash,Date.now());if(!s)return null;const user=store.get('users',s.user_id);if(!user||user.enabled===false)return null;return {user,csrf:s.csrf,tokenHash};}
 async function login(username,password,address){username=String(username||'').trim().slice(0,64);const key=String(address)+'|'+username,entry=attempts.get(key);if(entry&&entry.until>Date.now()&&entry.count>=8)throw appError('登录失败次数过多，请15分钟后重试',429);const user=store.list('users').find(u=>u.username===username);const valid=await verifyPassword(password,user?.passwordHash||('scrypt-v1$'+'0'.repeat(48)+'$'+'0'.repeat(128)));if(!user||user.enabled===false||!valid){const next=entry&&entry.until>Date.now()?entry:{count:0,until:Date.now()+15*60*1000};next.count++;if(attempts.size<10000||attempts.has(key))attempts.set(key,next);throw appError('用户名或密码错误，或账号已停用',401)}attempts.delete(key);store.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');store.db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),user.id,csrf,Date.now()+8*3600*1000);store.audit(user,'login',{});return {token,csrf,user:publicUser(user)};}
 function logout(s){if(s)store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.tokenHash);}
 function invalidate(userId){store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);}
 return {session,login,logout,invalidate,cookieName};
}
