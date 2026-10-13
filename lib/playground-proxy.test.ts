import assert from "node:assert/strict";
import test from "node:test";
import { proxyOptimization } from "./playground-proxy.ts";

function request(body = '{}', headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3100/api/optimizer", {
    method: "POST", body, headers: { "Content-Type": "application/json", ...headers },
  });
}

test("reject cross-origin, non-JSON and oversized requests before contacting Python", async () => {
  const never: typeof fetch = async () => { throw new Error("Must not forward"); };
  assert.equal((await proxyOptimization(request('{}', { origin: "https://other.example" }), never)).status, 403);
  assert.equal((await proxyOptimization(request('{}', { "sec-fetch-site": "cross-site" }), never)).status, 403);
  assert.equal((await proxyOptimization(request('{}', { "Content-Type": "text/plain" }), never)).status, 415);
  assert.equal((await proxyOptimization(request('x'.repeat(65537)), never)).status, 413);
  assert.equal((await proxyOptimization(request('bad json'), never)).status, 400);
});

test("forward JSON without browser headers and preserve backend errors", async () => {
  const send: typeof fetch = async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:3101/optimize");
    assert.equal(init?.body, '{"code":"dag = 1"}');
    assert.equal(new Headers(init?.headers).get("origin"), null);
    return Response.json({ message: "busy" }, { status: 429 });
  };
  const response = await proxyOptimization(request('{"code":"dag = 1"}', { origin: "http://127.0.0.1:3100" }), send);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { message: "busy" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("unavailable backend gives an actionable startup message", async () => {
  const send: typeof fetch = async () => { throw new Error("connection refused"); };
  const response = await proxyOptimization(request(), send);
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /backend\.server/);
});

test("use the incoming loopback Host when Next.js normalizes the URL", async () => {
  const send: typeof fetch = async () => Response.json({ status: "completed" });
  const normalized = new Request("http://localhost:3100/api/optimizer", {
    method: "POST", body: '{}', headers: { "Content-Type": "application/json",
      host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
  });
  assert.equal((await proxyOptimization(normalized, send)).status, 200);
  assert.equal((await proxyOptimization(request('{}', { host: "other.example", origin: "http://other.example" }), send)).status, 403);
});
