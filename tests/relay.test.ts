import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createRelay } from "../src/relay.js";
import type { CodeSocksConfig } from "../src/types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function origin() {
  const received: { url?: string; auth?: string; body?: string } = {};
  const server = createServer(async (req, res) => {
    received.url = req.url;
    received.auth = req.headers.authorization;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.body = Buffer.concat(chunks).toString();
    if (req.url === "/redirect") { res.writeHead(302, { location: "/v1/stream" }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n"); res.end("data: last\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === "string") throw Error("no address");
  return { url: `http://127.0.0.1:${address.port}`, received };
}

async function forwardProxy() {
  let count = 0;
  const { request } = await import("node:http");
  const server = createServer((req, res) => {
    count++;
    const upstream = request(req.url!, { method: req.method, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === "string") throw Error("no address");
  return { url: `http://127.0.0.1:${address.port}`, count: () => count };
}

async function fixture() {
  const target = await origin(); const proxy = await forwardProxy();
  const config: CodeSocksConfig = { enabled: true, proxies: { local: proxy.url }, providers: {
    test: { proxy: "local", allowedOrigins: [target.url], maxConcurrent: 2, minIntervalMs: 0, timeoutMs: 5000, maxQueueWaitMs: 1000 },
  } };
  const relay = await createRelay(config); cleanup.push(relay.close);
  return { target, proxy, relay };
}

test("selected provider POST traverses proxy and preserves path, credentials and SSE", async () => {
  const { target, proxy, relay } = await fixture();
  const original = new Request(`${target.url}/v1/stream?x=1`, { method: "POST", headers: { authorization: "Bearer test-secret" }, body: '{"prompt":"hi"}' });
  const rewritten = relay.rewrite(original, "test");
  expect(rewritten.url).not.toBe(original.url);
  const response = await fetch(rewritten);
  expect(await response.text()).toBe("data: first\n\ndata: last\n\n");
  expect(target.received).toEqual({ url: "/v1/stream?x=1", auth: "Bearer test-secret", body: '{"prompt":"hi"}' });
  expect(proxy.count()).toBe(1);
});

test("unselected provider remains untouched", async () => {
  const { target, relay } = await fixture(); const request = new Request(target.url);
  expect(relay.rewrite(request, "other")).toBe(request);
});

test("selected provider cannot send credentials to unapproved origin", async () => {
  const { relay } = await fixture();
  expect(() => relay.rewrite(new Request("https://wrong.example/v1"), "test")).toThrow("origin");
});

test("relay rejects unauthenticated and replayed tickets", async () => {
  const { target, relay } = await fixture();
  const request = relay.rewrite(new Request(target.url), "test"); const url = request.url;
  expect((await fetch(new URL("/missing", url))).status).toBe(403);
  expect((await fetch(request)).status).toBe(200);
  expect((await fetch(url)).status).toBe(403);
});

test("upstream redirect is blocked rather than bypassing proxy", async () => {
  const { target, proxy, relay } = await fixture();
  const response = await fetch(relay.rewrite(new Request(`${target.url}/redirect`), "test"));
  expect(response.status).toBe(502); expect(proxy.count()).toBe(1);
});
