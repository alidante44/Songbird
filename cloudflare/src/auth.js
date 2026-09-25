const enc = new TextEncoder();

export function parseCookies(request) {
  const raw = request.headers.get("cookie") || "";
  return Object.fromEntries(raw.split(";").map(v => v.trim()).filter(Boolean).map(v => {
    const i=v.indexOf("="); return i<0 ? [v,""] : [v.slice(0,i),decodeURIComponent(v.slice(i+1))];
  }));
}
const hex = b => [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function sha256(v){ return hex(await crypto.subtle.digest("SHA-256",enc.encode(v))); }
function b64(b){ return btoa(String.fromCharCode(...new Uint8Array(b))); }
function unb64(s){ return Uint8Array.from(atob(s),c=>c.charCodeAt(0)); }

export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:210000,hash:"SHA-256"},key,256);
  return "pbkdf2-sha256$210000$"+b64(salt)+"$"+b64(bits);
}
export async function verifyPassword(password, stored) {
  const [kind,it,saltB64,want]=String(stored||"").split("$");
  if(kind!=="pbkdf2-sha256") return false;
  const salt=unb64(saltB64);
  const key=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);
  const got=b64(await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:Number(it),hash:"SHA-256"},key,256));
  if(got.length!==want.length) return false;
  let d=0; for(let i=0;i<got.length;i++) d|=got.charCodeAt(i)^want.charCodeAt(i); return d===0;
}
export async function createSession(env,userId){
  const token=hex(crypto.getRandomValues(new Uint8Array(32))), now=Date.now(), exp=now+30*86400000;
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").bind(await sha256(token),userId,exp,now).run();
  return {token,expiresAt:exp};
}
export async function getUserFromRequest(request,env){
  const token=parseCookies(request).sid || (request.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
  if(!token) return null;
  return env.DB.prepare(`SELECT u.id,u.username,u.nickname,u.avatar_key,u.role,u.status
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).bind(await sha256(token),Date.now()).first();
}
export async function deleteRequestSession(request,env){
  const token=parseCookies(request).sid || (request.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
  if(token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
}
export const sessionCookie=(token,maxAge=2592000)=>`sid=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
export const clearSessionCookie=()=> "sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
