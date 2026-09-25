import { hashPassword, verifyPassword, createSession, getUserFromRequest, deleteRequestSession, sessionCookie, clearSessionCookie } from "./auth.js";\nimport { listChats, createChat, getMessages, sendMessage, isMember } from "./chats.js";
import { getPresence, setTyping, listTyping } from "./realtime.js";

const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8",...headers}});
const mediaTtl=env=>Math.max(86400,Number(env.MEDIA_TTL_DAYS||30)*86400);
const usernameRe=/^[a-z0-9._]+$/;
const publicUser=u=>({id:u.id,username:u.username,nickname:u.nickname||null,avatarUrl:u.avatar_key?"/api/media/"+u.avatar_key.replace(/^media\//,""):null,status:u.status||"online",role:u.role||"user"});

async function body(request){try{return await request.json();}catch{return {};}}
async function requireUser(request,env){return getUserFromRequest(request,env);}

export default {
 async fetch(request,env){
  const url=new URL(request.url), method=request.method;
  if(url.pathname==="/api/health"){const db=await env.DB.prepare("SELECT 1 AS ok").first();return json({ok:db?.ok===1,runtime:"cloudflare-workers",database:"d1",media:"kv",mediaTtlDays:Number(env.MEDIA_TTL_DAYS||30)});}

  if(url.pathname==="/api/register"&&method==="POST"){
   const b=await body(request), username=String(b.username||"").trim().toLowerCase(), password=String(b.password||""), nickname=String(b.nickname||"").trim()||null;
   if(username.length<3||username.length>64||!usernameRe.test(username)) return json({error:"Invalid username."},400);
   if(password.length<6) return json({error:"Password must be at least 6 characters."},400);
   if(await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(username).first()) return json({error:"Username already exists."},409);
   const id=crypto.randomUUID(), now=Date.now(), passwordHash=await hashPassword(password);
   await env.DB.prepare("INSERT INTO users(id,username,password_hash,nickname,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(id,username,passwordHash,nickname,"online",now,now).run();
   const s=await createSession(env,id); return json({id,username,nickname,avatarUrl:null,status:"online",role:"user"},200,{"set-cookie":sessionCookie(s.token)});
  }

  if(url.pathname==="/api/login"&&method==="POST"){
   const b=await body(request), username=String(b.username||"").trim().toLowerCase(), password=String(b.password||"");
   const u=await env.DB.prepare("SELECT * FROM users WHERE username=?").bind(username).first();
   if(!u||!(await verifyPassword(password,u.password_hash))) return json({error:"Invalid credentials."},401);
   await env.DB.prepare("UPDATE users SET status='online',updated_at=? WHERE id=?").bind(Date.now(),u.id).run();
   const s=await createSession(env,u.id); return json(publicUser({...u,status:"online"}),200,{"set-cookie":sessionCookie(s.token)});
  }

  if(url.pathname==="/api/me"&&method==="GET"){const u=await requireUser(request,env);return u?json(publicUser(u)):json({error:"Not authenticated."},401);}
  if(url.pathname==="/api/logout"&&method==="POST"){await deleteRequestSession(request,env);return json({ok:true},200,{"set-cookie":clearSessionCookie()});}

  const user=await requireUser(request,env);
  if(url.pathname==="/api/presence"&&method==="GET"){
   if(!user)return json({error:"Not authenticated."},401);
   const p=await getPresence(env,url.searchParams.get("username"));
   return p?json(p):json({error:"User not found."},404);
  }
  if(url.pathname==="/api/messages/typing"&&method==="POST"){
   if(!user)return json({error:"Not authenticated."},401); const b=await body(request),chatId=String(b.chatId||"");
   if(!chatId||!(await isMember(env,chatId,user.id)))return json({error:"Forbidden."},403);
   await setTyping(env,chatId,user); return json({ok:true});
  }
  const typingMatch=url.pathname.match(/^\\/api\\/chats\\/([^/]+)\\/typing$/);
  if(typingMatch&&method==="GET"){
   if(!user)return json({error:"Not authenticated."},401);
   if(!(await isMember(env,typingMatch[1],user.id)))return json({error:"Forbidden."},403);
   return json(await listTyping(env,typingMatch[1],user.username));
  }
  if(url.pathname==="/api/events"&&method==="GET"){
   if(!user)return json({error:"Not authenticated."},401);
   const after=Math.max(0,Number(url.searchParams.get("after")||0));
   const rows=await env.DB.prepare("SELECT seq,payload FROM realtime_events WHERE user_id=? AND seq>? ORDER BY seq LIMIT 100").bind(user.id,after).all();
   const events=(rows.results||[]).map(r=>({seq:r.seq,...JSON.parse(r.payload)}));
   return json({events,cursor:events.length?events[events.length-1].seq:after});
  }
  if(url.pathname==="/api/profile"&&method==="GET"){
   if(!user)return json({error:"Not authenticated."},401); const name=String(url.searchParams.get("username")||user.username).trim().toLowerCase();
   const p=await env.DB.prepare("SELECT id,username,nickname,avatar_key,status,role FROM users WHERE username=?").bind(name).first();
   return p?json(publicUser(p)):json({error:"User not found."},404);
  }
  if(url.pathname==="/api/profile"&&method==="PUT"){
   if(!user)return json({error:"Not authenticated."},401); const b=await body(request),name=String(b.username||user.username).trim().toLowerCase(),nick=String(b.nickname||"").trim()||null;
   if(name.length<3||name.length>64||!usernameRe.test(name))return json({error:"Invalid username."},400);
   const taken=await env.DB.prepare("SELECT id FROM users WHERE username=? AND id<>?").bind(name,user.id).first(); if(taken)return json({error:"Username already exists."},409);
   await env.DB.prepare("UPDATE users SET username=?,nickname=?,updated_at=? WHERE id=?").bind(name,nick,Date.now(),user.id).run();
   return json(publicUser({...user,username:name,nickname:nick}));
  }
  if(url.pathname==="/api/status"&&method==="PUT"){
   if(!user)return json({error:"Not authenticated."},401); const b=await body(request),status=String(b.status||"");
   if(!["online","invisible"].includes(status))return json({error:"Invalid status."},400);
   await env.DB.prepare("UPDATE users SET status=?,updated_at=? WHERE id=?").bind(status,Date.now(),user.id).run(); return json({ok:true,status});
  }
  if(url.pathname==="/api/password"&&method==="PUT"){
   if(!user)return json({error:"Not authenticated."},401); const b=await body(request);
   const full=await env.DB.prepare("SELECT password_hash FROM users WHERE id=?").bind(user.id).first();
   if(!(await verifyPassword(String(b.currentPassword||""),full?.password_hash)))return json({error:"Invalid credentials."},401);
   if(String(b.newPassword||"").length<6)return json({error:"Password must be at least 6 characters."},400);
   await env.DB.prepare("UPDATE users SET password_hash=?,updated_at=? WHERE id=?").bind(await hashPassword(String(b.newPassword)),Date.now(),user.id).run(); return json({ok:true});
  }
  if(url.pathname==="/api/profile/delete"&&method==="POST"){
   if(!user)return json({error:"Not authenticated."},401); const b=await body(request),full=await env.DB.prepare("SELECT password_hash,avatar_key FROM users WHERE id=?").bind(user.id).first();
   if(!(await verifyPassword(String(b.password||""),full?.password_hash)))return json({error:"Invalid credentials."},401);
   if(full?.avatar_key)await env.MEDIA.delete(full.avatar_key); await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.id).run();
   return json({ok:true},200,{"set-cookie":clearSessionCookie()});
  }
  if(url.pathname==="/api/profile/avatar"&&method==="POST"){
   if(!user)return json({error:"Not authenticated."},401); const form=await request.formData(),file=form.get("avatar");
   if(!(file instanceof File))return json({error:"Avatar file is required."},400); if(!String(file.type).startsWith("image/"))return json({error:"Avatar must be an image."},400);
   const max=Math.min(Number(env.MAX_MEDIA_BYTES||20*1024*1024),10*1024*1024); if(file.size>max)return json({error:"file_too_large"},413);
   const old=await env.DB.prepare("SELECT avatar_key FROM users WHERE id=?").bind(user.id).first(); const key="media/avatar-"+crypto.randomUUID();
   await env.MEDIA.put(key,await file.arrayBuffer(),{expirationTtl:mediaTtl(env),metadata:{contentType:file.type,size:file.size,ownerId:user.id,avatar:true}});
   await env.DB.prepare("UPDATE users SET avatar_key=?,updated_at=? WHERE id=?").bind(key,Date.now(),user.id).run(); if(old?.avatar_key)await env.MEDIA.delete(old.avatar_key);
   return json({avatarUrl:"/api/media/"+key.replace(/^media\\//,""),sizeBytes:file.size,maxFileSizeBytes:max});
  }
  if(url.pathname==="/api/chats"&&method==="GET"){if(!user)return json({error:"Not authenticated."},401);return json(await listChats(env,user.id));}
  if(url.pathname==="/api/chats"&&method==="POST"){if(!user)return json({error:"Not authenticated."},401);try{return json(await createChat(env,user,await body(request)),201);}catch(e){return json({error:e.message},400);}}
  // Compatibility routes used by the existing Songbird client.
  if(url.pathname==="/api/chats/dm"&&method==="POST"){
   if(!user)return json({error:"Not authenticated."},401); const b=await body(request);
   const target=await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(String(b.to||"").trim().toLowerCase()).first();
   if(!target)return json({error:"User not found."},404);
   try{return json(await createChat(env,user,{type:"dm",memberIds:[target.id]}),201);}catch(e){return json({error:e.message},400);}
  }
  if(url.pathname==="/api/chats/group"&&method==="POST"){
   if(!user)return json({error:"Not authenticated."},401); const b=await body(request), names=Array.isArray(b.members)?b.members:[];
   const memberIds=[]; for(const name of names){const x=await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(String(name).trim().toLowerCase()).first();if(x)memberIds.push(x.id);}
   try{return json(await createChat(env,user,{...b,type:b.type==="channel"?"channel":"group",memberIds}),201);}catch(e){return json({error:e.message},400);}
  }
  if(url.pathname==="/api/users"&&method==="GET"){
   if(!user)return json({error:"Not authenticated."},401); const q=String(url.searchParams.get("query")||"").trim().toLowerCase();
   const r=await env.DB.prepare("SELECT id,username,nickname,avatar_key,status,role FROM users WHERE id<>? AND (username LIKE ? OR nickname LIKE ?) ORDER BY username LIMIT 30").bind(user.id,"%"+q+"%","%"+q+"%").all();
   return json((r.results||[]).map(publicUser));
  }
  if(url.pathname==="/api/messages"&&method==="GET"){
   if(!user)return json({error:"Not authenticated."},401); const chatId=url.searchParams.get("chatId");
   if(!chatId||!(await isMember(env,chatId,user.id)))return json({error:"Forbidden."},403);
   return json(await getMessages(env,chatId,url.searchParams.get("limit"),Number(url.searchParams.get("before"))||Number.MAX_SAFE_INTEGER));
  }
  if(url.pathname==="/api/messages"&&method==="POST"){
   if(!user)return json({error:"Not authenticated."},401); const b=await body(request),chatId=String(b.chatId||"");
   try{return json(await sendMessage(env,user,chatId,{text:b.text??b.message,replyToId:b.replyToId,files:b.files||b.presignedFiles||[]}),201);}catch(e){return json({error:e.message},e.message==="forbidden"?403:400);}
  }
  if(url.pathname.match(/^\\/api\\/messages\\/[^/]+$/)&&method==="GET"){
   if(!user)return json({error:"Not authenticated."},401); const chatId=decodeURIComponent(url.pathname.slice("/api/messages/".length));
   if(!(await isMember(env,chatId,user.id)))return json({error:"Forbidden."},403);
   return json(await getMessages(env,chatId,url.searchParams.get("limit"),Number(url.searchParams.get("before"))||Number.MAX_SAFE_INTEGER));
  }
  if(url.pathname==="/api/uploads/presign"&&method==="POST"){
   if(!user)return json({error:"Not authenticated."},401); const b=await body(request),max=Number(env.MAX_MEDIA_BYTES||20*1024*1024);
   if(Number(b.fileSize||0)>max)return json({error:"file_too_large"},413);
   const key="media/"+crypto.randomUUID();
   return json({type:"remote",storageKey:key,fileId:key,uploadUrl:"/api/media?key="+encodeURIComponent(key),downloadUrl:"/api/media/"+key.replace(/^media\\//,""),expiresIn:mediaTtl(env)});
  }

  const msgMatch=url.pathname.match(/^\\/api\\/chats\\/([^/]+)\\/messages$/);
  if(msgMatch&&method==="GET"){if(!user)return json({error:"Not authenticated."},401);if(!(await isMember(env,msgMatch[1],user.id)))return json({error:"Forbidden."},403);return json(await getMessages(env,msgMatch[1],url.searchParams.get("limit"),Number(url.searchParams.get("before"))||Number.MAX_SAFE_INTEGER));}
  if(msgMatch&&method==="POST"){if(!user)return json({error:"Not authenticated."},401);try{return json(await sendMessage(env,user,msgMatch[1],await body(request)),201);}catch(e){return json({error:e.message},e.message==="forbidden"?403:400);}}

  if(url.pathname==="/api/media"&&method==="PUT"){
   const u=await requireUser(request,env); if(!u)return json({error:"Not authenticated."},401);
   const type=request.headers.get("content-type")||"application/octet-stream", length=Number(request.headers.get("content-length")||0), max=Number(env.MAX_MEDIA_BYTES||20*1024*1024);
   if(length&&length>max)return json({error:"file_too_large"},413);
   const data=await request.arrayBuffer(); if(data.byteLength>max)return json({error:"file_too_large"},413);
   const requested=url.searchParams.get("key"); const key=requested&&requested.startsWith("media/")?requested:"media/"+crypto.randomUUID(); await env.MEDIA.put(key,data,{expirationTtl:mediaTtl(env),metadata:{contentType:type,size:data.byteLength,ownerId:u.id}});
   return json({key,size:data.byteLength,expiresIn:mediaTtl(env)},201);
  }
  if(url.pathname.startsWith("/api/media/")&&method==="GET"){
   const u=await requireUser(request,env); if(!u)return json({error:"Not authenticated."},401);
   const key="media/"+url.pathname.slice("/api/media/".length), result=await env.MEDIA.getWithMetadata(key,"arrayBuffer");
   if(!result.value)return json({error:"not_found"},404);
   return new Response(result.value,{headers:{"content-type":result.metadata?.contentType||"application/octet-stream","cache-control":"private, max-age=300","x-content-type-options":"nosniff"}});
  }
  return json({error:"not_found"},404);
 }
};
