export async function isMember(env,chatId,userId){
 return !!(await env.DB.prepare("SELECT 1 ok FROM chat_members WHERE chat_id=? AND user_id=?").bind(chatId,userId).first());
}
export async function listChats(env,userId){
 const r=await env.DB.prepare(`SELECT c.*,cm.role AS member_role,
 (SELECT text FROM messages m WHERE m.chat_id=c.id ORDER BY m.created_at DESC LIMIT 1) last_message,
 (SELECT created_at FROM messages m WHERE m.chat_id=c.id ORDER BY m.created_at DESC LIMIT 1) last_message_at
 FROM chats c JOIN chat_members cm ON cm.chat_id=c.id WHERE cm.user_id=?
 ORDER BY COALESCE(last_message_at,c.updated_at) DESC`).bind(userId).all();
 const chats=r.results||[];
 for(const chat of chats){
  const members=await env.DB.prepare(`SELECT u.id,u.username,u.nickname,u.avatar_key,u.status,cm.role
   FROM chat_members cm JOIN users u ON u.id=cm.user_id
   WHERE cm.chat_id=? ORDER BY cm.joined_at ASC`).bind(chat.id).all();
  chat.members=(members.results||[]).map(m=>({...m,avatarUrl:m.avatar_key?"/api/media/"+String(m.avatar_key).replace(/^media\//,""):null}));
  chat.last_time=chat.last_message_at||chat.updated_at;
 }
 return chats;
}
export async function createChat(env,user,b){
 const type=String(b.type||"dm").toLowerCase(), now=Date.now(), id=crypto.randomUUID();
 if(!["dm","group","channel","saved"].includes(type)) throw new Error("invalid_type");
 let members=Array.isArray(b.memberIds)?b.memberIds.filter(Boolean):[];
 if(type==="dm"){
  if(members.length!==1) throw new Error("dm_requires_one_member");
  const other=members[0];
  const existing=await env.DB.prepare(`SELECT c.id FROM chats c
   JOIN chat_members a ON a.chat_id=c.id AND a.user_id=?
   JOIN chat_members z ON z.chat_id=c.id AND z.user_id=?
   WHERE c.type='dm' LIMIT 1`).bind(user.id,other).first();
  if(existing) return env.DB.prepare("SELECT * FROM chats WHERE id=?").bind(existing.id).first();
 }
 const username=String(b.username||"").trim().toLowerCase()||null, name=String(b.name||"").trim()||null;
 await env.DB.prepare("INSERT INTO chats(id,type,name,username,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(id,type,name,username,user.id,now,now).run();
 const ids=[...new Set([user.id,...members])];
 for(const uid of ids) await env.DB.prepare("INSERT OR IGNORE INTO chat_members(chat_id,user_id,role,joined_at) VALUES(?,?,?,?)").bind(id,uid,uid===user.id?"owner":"member",now).run();
 return env.DB.prepare("SELECT * FROM chats WHERE id=?").bind(id).first();
}
export async function getMessages(env,chatId,limit=50,before=Number.MAX_SAFE_INTEGER){
 const n=Math.max(1,Math.min(100,Number(limit)||50));
 const r=await env.DB.prepare(`SELECT m.*,u.username,u.nickname FROM messages m LEFT JOIN users u ON u.id=m.sender_id
 WHERE m.chat_id=? AND m.created_at<? ORDER BY m.created_at DESC LIMIT ?`).bind(chatId,before,n).all();
 const rows=(r.results||[]).reverse();
 if(!rows.length)return rows;
 const ids=rows.map(x=>x.id), q=ids.map(()=>"?").join(",");
 const f=await env.DB.prepare(`SELECT * FROM message_files WHERE message_id IN (${q})`).bind(...ids).all();
 const by={}; for(const x of f.results||[])(by[x.message_id]??=[]).push({...x,url:"/api/media/"+x.storage_key.replace(/^media\//,"")});
 return rows.map(x=>({...x,files:by[x.id]||[]}));
}
export async function sendMessage(env,user,chatId,b){
 if(!(await isMember(env,chatId,user.id))) throw new Error("forbidden");
 const text=String(b.text||"").trim(), files=Array.isArray(b.files)?b.files:[];
 if(!text&&!files.length)throw new Error("empty_message");
 const id=crypto.randomUUID(),now=Date.now();
 await env.DB.prepare("INSERT INTO messages(id,chat_id,sender_id,text,reply_to_id,created_at) VALUES(?,?,?,?,?,?)").bind(id,chatId,user.id,text||null,b.replyToId||null,now).run();
 for(const f of files){
  const key=String(f.key||""); if(!key.startsWith("media/"))continue;
  const obj=await env.MEDIA.getWithMetadata(key,"arrayBuffer"); if(!obj.value||obj.metadata?.ownerId!==user.id)continue;
  await env.DB.prepare("INSERT INTO message_files(id,message_id,storage_key,filename,mime_type,size_bytes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)")
   .bind(crypto.randomUUID(),id,key,String(f.filename||"")||null,obj.metadata?.contentType||null,obj.metadata?.size||obj.value.byteLength,now+Number(env.MEDIA_TTL_DAYS||30)*86400000,now).run();
 }
 await env.DB.prepare("UPDATE chats SET updated_at=? WHERE id=?").bind(now,chatId).run();
 const members=await env.DB.prepare("SELECT user_id FROM chat_members WHERE chat_id=?").bind(chatId).all();
 const event={type:"chat_message",chatId,messageId:id,username:user.username,body:text||"",createdAt:now};
 for(const m of members.results||[]) await env.DB.prepare("INSERT INTO realtime_events(user_id,event_type,payload,created_at) VALUES(?,?,?,?)").bind(m.user_id,"chat_message",JSON.stringify(event),now).run();
 return {id,chat_id:chatId,sender_id:user.id,text:text||null,created_at:now};
}
