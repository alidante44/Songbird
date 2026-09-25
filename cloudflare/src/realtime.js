export async function getPresence(env, username) {
  const name = String(username || "").trim().toLowerCase();
  if (!name) return null;
  const row = await env.DB.prepare(
    "SELECT username,status,updated_at FROM users WHERE username=?"
  ).bind(name).first();
  if (!row) return null;
  const hidden = row.status === "invisible";
  return {
    username: row.username,
    status: hidden ? "offline" : row.status,
    online: !hidden && row.status === "online",
    lastSeen: row.updated_at
  };
}

export async function setTyping(env, chatId, user) {
  const key = "typing/" + chatId + "/" + user.id;
  await env.MEDIA.put(key, JSON.stringify({
    username: user.username,
    at: Date.now()
  }), { expirationTtl: 60 });
}

export async function listTyping(env, chatId, currentUsername) {
  const listed = await env.MEDIA.list({ prefix: "typing/" + chatId + "/" });
  const items = [];
  for (const key of listed.keys) {
    const value = await env.MEDIA.get(key.name, "json");
    if (value && value.username !== currentUsername) items.push(value);
  }
  return items;
}
