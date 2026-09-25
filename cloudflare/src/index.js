const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const mediaTtl = (env) =>
  Math.max(86400, Number(env.MEDIA_TTL_DAYS || 30) * 86400);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      const db = await env.DB.prepare("SELECT 1 AS ok").first();
      return json({
        ok: db?.ok === 1,
        runtime: "cloudflare-workers",
        database: "d1",
        media: "kv",
        mediaTtlDays: Number(env.MEDIA_TTL_DAYS || 30),
      });
    }

    if (url.pathname === "/api/media" && request.method === "PUT") {
      const type = request.headers.get("content-type") || "application/octet-stream";
      const length = Number(request.headers.get("content-length") || 0);
      const max = Number(env.MAX_MEDIA_BYTES || 20 * 1024 * 1024);
      if (length && length > max) return json({ error: "file_too_large" }, 413);

      const data = await request.arrayBuffer();
      if (data.byteLength > max) return json({ error: "file_too_large" }, 413);

      const key = "media/" + crypto.randomUUID();
      await env.MEDIA.put(key, data, {
        expirationTtl: mediaTtl(env),
        metadata: { contentType: type, size: data.byteLength },
      });
      return json({ key, size: data.byteLength, expiresIn: mediaTtl(env) }, 201);
    }

    if (url.pathname.startsWith("/api/media/") && request.method === "GET") {
      const key = "media/" + url.pathname.slice("/api/media/".length);
      const result = await env.MEDIA.getWithMetadata(key, "arrayBuffer");
      if (!result.value) return json({ error: "not_found" }, 404);
      return new Response(result.value, {
        headers: {
          "content-type": result.metadata?.contentType || "application/octet-stream",
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    }

    return json({ error: "not_found" }, 404);
  },
};
