import { afterEach, expect, test } from "bun:test";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { parseConfig } from "../src/config.js";
import { createRelay } from "../src/relay.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("bind failed");
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(rotation = true, status = 200, handler?: (req: IncomingMessage, res: ServerResponse) => void, timeoutMs = 1000, failureThreshold = 1) {
  let hits = 0; let proxyHits = 0;
  const origin = await listen((req, res) => { hits++; if (handler) handler(req, res); else { res.writeHead(status); res.end("origin"); } });
  const bad = await listen((req) => req.socket.destroy());
  const good = await listen((req, res) => {
    proxyHits++;
    const upstream = request(req.url!, { method: req.method, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode!, reply.headers); reply.on("error", () => res.destroy()); reply.pipe(res);
    });
    res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  const config = parseConfig(JSON.stringify({
    proxies: { bad, good }, providers: {
      p: { proxy: "bad", allowedOrigins: [origin], timeoutMs,
        ...(rotation ? { rotation: { enabled: true, proxies: ["good"], cooldownMs: 10000, failureThreshold } } : {}) },
      other: { proxy: "bad", allowedOrigins: [origin] },
    },
  }));
  const relay = await createRelay(config); cleanup.push(relay.close);
  const send = (signal?: AbortSignal) => fetch(relay.rewrite(new Request(origin, { method: "POST", body: "prompt", signal }), "p"));
  return { relay, send, hits: () => hits, proxyHits: () => proxyHits };
}

test("rotation config validates named fallbacks and defaults cooldown", () => {
  const cfg = parseConfig(JSON.stringify({ proxies: { a: "http://localhost:1", b: "http://localhost:2" },
    providers: { p: { proxy: "a", allowedOrigins: ["https://example.com"], rotation: { enabled: true, proxies: ["b"] } } } }));
  expect(cfg.providers.p!.rotation).toEqual({ enabled: true, proxies: ["b"], cooldownMs: 30000 });
});

test("transport failure rotates only the failed provider without replaying a POST", async () => {
  const f = await fixture();
  const first = await f.send(); expect(first.status).toBe(502); await first.text();
  expect(f.hits()).toBe(0); expect(f.proxyHits()).toBe(0);
  const second = await f.send(); expect(second.status).toBe(200); expect(await second.text()).toBe("origin");
  expect(f.hits()).toBe(1);
  expect(f.relay.status().providers).toMatchObject([
    { id: "p", proxy: "good", rotation: true }, { id: "other", proxy: "bad", rotation: false },
  ]);
});

test("rotation remains off for existing configs", async () => {
  const f = await fixture(false);
  for (let i = 0; i < 2; i++) { const res = await f.send(); expect(res.status).toBe(502); await res.text(); }
  expect(f.hits()).toBe(0);
});

test("configured threshold waits for two actual transport failures before switching", async () => {
  const f = await fixture(true, 200, undefined, 1000, 2);
  const first = await f.send(); expect(first.status).toBe(502); await first.text();
  expect(f.relay.status().providers[0]).toMatchObject({ proxy: "bad", consecutiveFailures: 1, failureThreshold: 2 });
  const second = await f.send(); expect(second.status).toBe(502); await second.text();
  expect(f.relay.status().providers[0]!.proxy).toBe("good");
  const next = await f.send(); expect(await next.text()).toBe("origin"); expect(f.hits()).toBe(1);
});

for (const status of [401, 429, 500, 502, 503]) test(`provider HTTP ${status} does not rotate`, async () => {
  const f = await fixture(true, status);
  f.relay.selectProxy("p", "good");
  const res = await f.send(); expect(res.status).toBe(status); await res.text();
  expect(f.relay.status().providers[0]!.proxy).toBe("good");
});

test("manual selection takes effect on the next request without exposing proxy credentials", async () => {
  const f = await fixture(false);
  f.relay.selectProxy("p", "good");
  const res = await f.send(); expect(await res.text()).toBe("origin");
  expect(f.relay.status().proxies).toEqual(["bad", "good"]);
  expect(() => f.relay.selectProxy("p", "missing")).toThrow("unknown proxy");
  expect(() => f.relay.selectProxy("missing", "good")).toThrow("unknown provider");
});

test("proxy authentication failure exhausts the pool without direct fallback", async () => {
  const f = await fixture(true, 407);
  const first = await f.send(); expect(first.status).toBe(502); await first.text();
  const second = await f.send(); expect(second.status).toBe(502); await second.text();
  const third = await f.send(); expect(third.status).toBe(503); await third.text();
  expect(f.proxyHits()).toBe(1);
});

test("blocked redirect does not rotate the proxy", async () => {
  const f = await fixture(true, 302); f.relay.selectProxy("p", "good");
  const res = await f.send(); expect(res.status).toBe(502); await res.text();
  expect(f.relay.status().providers[0]!.proxy).toBe("good");
});

test("upstream timeout rotates for future requests", async () => {
  const f = await fixture(true, 200, () => {}, 50); f.relay.selectProxy("p", "good");
  const res = await f.send(); expect(res.status).toBe(502); await res.text();
  expect(f.relay.status().providers[0]!.proxy).toBe("bad");
});

test("client cancellation does not rotate", async () => {
  let started!: () => void; let closed!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const stopped = new Promise<void>((resolve) => { closed = resolve; });
  const f = await fixture(true, 200, (_req, res) => { res.once("close", closed); started(); });
  f.relay.selectProxy("p", "good");
  const controller = new AbortController();
  const pending = f.send(controller.signal).catch(() => undefined);
  await ready; controller.abort(); await pending; await stopped;
  expect(f.relay.status().providers[0]!.proxy).toBe("good");
});

test("config replacement and manual selection preserve an active stream and route the next request differently", async () => {
  let finish!: () => void;
  const origin = await listen((_req, res) => {
    res.writeHead(200); res.write("first"); finish = () => res.end("last");
  });
  const proxy = await listen((req, res) => {
    const upstream = request(req.url!, (reply) => { res.writeHead(reply.statusCode!); reply.pipe(res); });
    upstream.on("error", () => res.destroy()); req.pipe(upstream);
  });
  const replacement = await listen((_req, res) => res.end("replacement"));
  const config = parseConfig(JSON.stringify({ proxies: { a: proxy, b: replacement }, providers: { p: { proxy: "a", allowedOrigins: [origin] } } }));
  const relay = await createRelay(config); cleanup.push(relay.close);
  const response = await fetch(relay.rewrite(new Request(origin), "p"));
  const reader = response.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  relay.selectProxy("p", "b");
  const next = await fetch(relay.rewrite(new Request(origin), "p")); expect(await next.text()).toBe("replacement");
  relay.update(config);
  finish(); expect(new TextDecoder().decode((await reader.read()).value)).toBe("last");
  expect((await reader.read()).done).toBe(true);
  expect(relay.status().providers[0]!.proxy).toBe("a");
});

test("interrupted SSE rotates without replaying the prompt", async () => {
  let interrupt!: () => void;
  const f = await fixture(true, 200, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: first\n\n"); interrupt = () => res.destroy();
  });
  f.relay.selectProxy("p", "good");
  const response = await f.send(); const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
  interrupt(); await expect(reader.read()).rejects.toThrow();
  expect(f.hits()).toBe(1); expect(f.relay.status().providers[0]!.proxy).toBe("bad");
});

test("reload preserves the provider concurrency cap across old and new streams", async () => {
  let finish!: () => void; let hits = 0;
  const origin = await listen((_req, res) => {
    hits++; res.writeHead(200);
    if (hits === 1) { res.write("first"); finish = () => res.end("last"); } else res.end("next");
  });
  const proxy = await listen((req, res) => {
    const upstream = request(req.url!, (reply) => { res.writeHead(reply.statusCode!); reply.pipe(res); });
    upstream.on("error", () => res.destroy()); req.pipe(upstream);
  });
  const config = parseConfig(JSON.stringify({ proxies: { a: proxy }, providers: { p: {
    proxy: "a", allowedOrigins: [origin], maxConcurrent: 1, maxQueueWaitMs: 50,
  } } }));
  const relay = await createRelay(config); cleanup.push(relay.close);
  const first = await fetch(relay.rewrite(new Request(origin), "p"));
  relay.update(config);
  const queued = await fetch(relay.rewrite(new Request(origin), "p"));
  try { expect(queued.status).toBe(503); await queued.text(); expect(hits).toBe(1); }
  finally { finish(); await first.text(); }
  const next = await fetch(relay.rewrite(new Request(origin), "p")); expect(await next.text()).toBe("next");
});

test("cooldown expiry makes the pool available again", async () => {
  const { ProxyRotation } = await import("../src/rotation.js");
  const route = parseConfig(JSON.stringify({ proxies: { a: "http://localhost:1", b: "http://localhost:2" },
    providers: { p: { proxy: "a", allowedOrigins: ["https://example.com"], rotation: { enabled: true, proxies: ["b"], cooldownMs: 100 } } } })).providers.p!;
  const state = new ProxyRotation(route);
  state.failed(state.select(0)!, 0); expect(state.proxy).toBe("b");
  state.failed(state.select(1)!, 1); expect(state.select(99)).toBeUndefined();
  expect(state.select(100)?.proxy).toBe("a");
});

test("stale concurrent failures cannot overwrite a manual selection", async () => {
  const { ProxyRotation } = await import("../src/rotation.js");
  const route = parseConfig(JSON.stringify({ proxies: { a: "http://localhost:1", b: "http://localhost:2" },
    providers: { p: { proxy: "a", allowedOrigins: ["https://example.com"], rotation: { enabled: true, proxies: ["b"] } } } })).providers.p!;
  const state = new ProxyRotation(route);
  const old = state.select(0)!;
  state.manual("b"); state.failed(old, 1); expect(state.proxy).toBe("b");
  const newer = state.select(1)!; state.manual("b"); state.failed(newer, 2);
  expect(state.select(2)?.proxy).toBe("b");
});

for (const rotation of [
  { enabled: true, proxies: [] }, { enabled: true, proxies: ["missing"] },
  { enabled: "true", proxies: ["b"] }, { proxies: ["b"], cooldownMs: -1 },
  { proxies: ["b", "b"] }, { proxies: ["a"] }, { proxies: ["b"], unknown: true },
  { enabled: null, proxies: ["b"] },
  { proxies: ["b"], rotateOnRateLimit: "true" },
]) test(`rejects invalid rotation ${JSON.stringify(rotation)}`, () => {
  expect(() => parseConfig(JSON.stringify({ proxies: { a: "http://localhost:1", b: "http://localhost:2" },
    providers: { p: { proxy: "a", allowedOrigins: ["https://example.com"], rotation } } }))).toThrow();
});

test("opt-in HTTP 429 rotates the next POST without replay and retains Retry-After", async () => {
  let aHits = 0; let bHits = 0;
  const a = await listen((_req, res) => { aHits++; res.writeHead(429, { "retry-after": "0.15" }); res.end("limited"); });
  const b = await listen((_req, res) => { bHits++; res.end("next proxy"); });
  const config = parseConfig(JSON.stringify({ proxies: { a, b }, providers: { p: {
    proxy: "a", allowedOrigins: ["http://example.test"], maxConcurrent: 1,
    rotation: { enabled: true, proxies: ["b"], cooldownMs: 10000, rotateOnRateLimit: true },
  } } }));
  const relay = await createRelay(config); cleanup.push(relay.close);
  const send = () => fetch(relay.rewrite(new Request("http://example.test", { method: "POST", body: "prompt" }), "p"));
  const first = await send(); expect(first.status).toBe(429);
  expect(first.headers.get("retry-after")).toBe("0.15"); expect(await first.text()).toBe("limited");
  expect(aHits).toBe(1); expect(bHits).toBe(0);
  expect(relay.status().providers[0]).toMatchObject({ proxy: "b", pool: [{ proxy: "a" }, { proxy: "b" }] });
  const start = Date.now(); const next = await send();
  expect(await next.text()).toBe("next proxy"); expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  expect(aHits).toBe(1); expect(bHits).toBe(1);
});

test("rate-limit cooldown honors the longer Retry-After and ignores stale selections", async () => {
  const { ProxyRotation } = await import("../src/rotation.js");
  const route = parseConfig(JSON.stringify({ proxies: { a: "http://localhost:1", b: "http://localhost:2" }, providers: { p: {
    proxy: "a", allowedOrigins: ["https://example.com"],
    rotation: { enabled: true, proxies: ["b"], cooldownMs: 100, failureThreshold: 2, rotateOnRateLimit: true },
  } } })).providers.p!;
  const state = new ProxyRotation(route); const old = state.select(0)!;
  state.rateLimited(old, 500, 0); expect(state.proxy).toBe("b");
  state.rateLimited(state.select(1)!, 1000, 1);
  expect(state.select(499)).toBeUndefined(); expect(state.select(500)?.proxy).toBe("a");
  state.manual("b"); state.rateLimited(old, 500, 501);
  expect(state.proxy).toBe("b");
});

test("rate-limit rotation requires both rotation enabled and explicit opt-in", async () => {
  const { ProxyRotation } = await import("../src/rotation.js");
  for (const rotation of [{ enabled: false, rotateOnRateLimit: true }, { enabled: true, rotateOnRateLimit: false }]) {
    const route = parseConfig(JSON.stringify({ proxies: { a: "http://localhost:1", b: "http://localhost:2" }, providers: { p: {
      proxy: "a", allowedOrigins: ["https://example.com"], rotation: { ...rotation, proxies: ["b"] },
    } } })).providers.p!;
    const state = new ProxyRotation(route); state.rateLimited(state.select(0)!, 500, 0);
    expect(state.select(1)?.proxy).toBe("a");
  }
});
