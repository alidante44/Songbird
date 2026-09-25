const WORKER_ORIGIN = "https://songbird.alidante44.workers.dev";

export async function onRequest({ request, params }) {
  const path = Array.isArray(params.path)
    ? params.path.join("/")
    : String(params.path || "");

  const incoming = new URL(request.url);
  const target = new URL(`/api/${path}`, WORKER_ORIGIN);
  target.search = incoming.search;

  const init = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  return fetch(new Request(target, init));
}
