# Songbird Cloudflare port

This branch is the Cloudflare-native port of Songbird.

## Target architecture

- Cloudflare Workers: API/backend
- Cloudflare D1: users, chats, messages, settings, metadata
- Workers KV (MEDIA): transient attachments and avatars
- Media TTL: 30 days by default
- No R2/payment card required
- No server-side FFmpeg. Uploaded media is stored as-is.

## Why this is a port, not a deployment config

The upstream server is a long-running Express/Node process and uses Node-only facilities including local filesystem, HTTP server listeners, child processes, timers, SQLite/Postgres drivers, Redis/BullMQ and a standalone FFmpeg media worker. Those cannot simply be deployed unchanged as a Cloudflare Worker.

The Cloudflare implementation therefore replaces those runtime-specific pieces while keeping the existing client/API contract where practical.

## Migration phases

1. D1 schema + Worker project skeleton.
2. Authentication/users/sessions.
3. Chats/messages/groups/channels.
4. KV media upload/download with 30-day expiration.
5. Realtime delivery using Cloudflare-compatible WebSocket/SSE design.
6. Admin/settings and remaining compatible features.
7. Client integration and deployment documentation.

The original `server/` and `worker/` directories remain untouched while the port is developed under `cloudflare/`.
