import { afterEach, expect, test } from "bun:test";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRelay } from "../src/relay.js";
import type { CodeSocksConfig } from "../src/types.js";

// Bounded local integration tests for the existing createRelay/rewrite/close API.
// Only 127.0.0.1 loopback + stub hostname "origin.test" (resolved inside the
// SOCKS5 stub, never via real DNS). No external network. No TLS disabling.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // ignore teardown noise
    }
  }
});

function track(server: { close(cb?: () => void): unknown; closeAllConnections?: () => void }) {
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        try {
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        } catch {
          // ignore
        }
        (server as { close(cb: () => void): unknown }).close(() => resolve());
        setTimeout(resolve, 1000);
      }),
  );
}

function trackRelay(relay: { close(): Promise<void> }) {
  closers.push(() => relay.close());
}

async function listenOnLocalhost(
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer> | ReturnType<typeof createNetServer>,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind 127.0.0.1");
  return (address as { port: number }).port;
}

interface OriginState {
  hits: number;
  lastUrl?: string;
  lastAuth?: string;
  clientClosed: boolean;
}

async function startHttpOrigin(): Promise<{ base: string; port: number; state: OriginState }> {
  const state: OriginState = { hits: 0, clientClosed: false };
  const server = createHttpServer((req, res) => {
    state.hits++;
    state.lastUrl = req.url;
    state.lastAuth = req.headers.authorization as string | undefined;
    // Track response close (client disconnect). Request close fires for every
    // completed GET, so only the response close proves an aborted SSE stream.
    res.on("close", () => {
      if (!res.writableEnded) state.clientClosed = true;
    });
    if (req.url === "/slow") {
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("slow-ok");
        }
      }, 800);
      return;
    }
    if (req.url === "/sse-slow") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: first\n\n");
      const timer = setInterval(() => {
        if (!res.destroyed) res.write("data: tick\n\n");
      }, 200);
      timer.unref?.();
      res.on("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: first\n\ndata: last\n\n");
  });
  const port = await listenOnLocalhost(server);
  track(server);
  return { base: `http://127.0.0.1:${port}`, port, state };
}

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

async function startHttpsOrigin(): Promise<{ base: string; port: number; state: OriginState }> {
  const state: OriginState = { hits: 0, clientClosed: false };
  const key = readFileSync(join(FIXTURE_DIR, "test-key.pem"));
  const cert = readFileSync(join(FIXTURE_DIR, "test-cert.pem"));
  const server = createHttpsServer({ key, cert }, (req, res) => {
    state.hits++;
    state.lastUrl = req.url;
    req.on("close", () => {
      state.clientClosed = true;
    });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("secure-hello");
  });
  const port = await listenOnLocalhost(server);
  track(server);
  return { base: `https://127.0.0.1:${port}`, port, state };
}

interface ConnectProxyState {
  connects: string[];
  forwards: number;
  authSeen: string[];
}

async function startConnectProxy(expectedAuth?: { user: string; pass: string }): Promise<{
  url: string;
  port: number;
  state: ConnectProxyState;
}> {
  const state: ConnectProxyState = { connects: [], forwards: 0, authSeen: [] };
  const wanted = expectedAuth ? `Basic ${Buffer.from(`${expectedAuth.user}:${expectedAuth.pass}`).toString("base64")}` : null;

  const server = createHttpServer((req, res) => {
    if (wanted) {
      const got = req.headers["proxy-authorization"] as string | undefined;
      state.authSeen.push(got ?? "");
      if (got !== wanted) {
        res.writeHead(407, { "proxy-authenticate": 'Basic realm="test"' });
        res.end();
        return;
      }
    }
    state.forwards++;
    const upstream = httpRequest(req.url!, { method: req.method, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode!, reply.headers);
      reply.pipe(res);
    });
    const tearDown = () => {
      if (res.writableEnded) return;
      try {
        upstream.destroy();
      } catch {
        // ignore
      }
    };
    res.on("close", tearDown);
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      } else res.destroy();
    });
    req.pipe(upstream);
  });

  server.on("connect", (req: { url?: string; headers: Record<string, unknown> }, socket, head) => {
    const headers = req.headers as Record<string, string | undefined>;
    if (wanted) {
      const got = headers["proxy-authorization"];
      state.authSeen.push(got ?? "");
      if (got !== wanted) {
        socket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"test\"\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const target = req.url ?? "";
    state.connects.push(target);
    const [host, portText] = target.split(":");
    const upstream = netConnect(Number(portText), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => {
      try {
        socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch {
        // ignore
      }
      socket.destroy();
    });
    upstream.on("close", () => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });

  const port = await listenOnLocalhost(server);
  track(server);
  const authPrefix = expectedAuth ? `${encodeURIComponent(expectedAuth.user)}:${encodeURIComponent(expectedAuth.pass)}@` : "";
  return { url: `http://${authPrefix}127.0.0.1:${port}`, port, state };
}

interface SocksState {
  connections: number;
  lastAtyp?: number;
  lastHost?: string;
  lastPort?: number;
  authAttempts: string[];
}

function createSocksReader(socket: import("node:net").Socket) {
  let buf = Buffer.alloc(0);
  const waiters: Array<{ n: number; resolve: (b: Buffer) => void; reject: (e: unknown) => void }> = [];
  const pump = () => {
    while (waiters.length > 0 && buf.length >= waiters[0]!.n) {
      const waiter = waiters.shift()!;
      const out = buf.subarray(0, waiter.n);
      buf = buf.subarray(waiter.n);
      waiter.resolve(Buffer.from(out));
    }
  };
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  socket.on("error", (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  socket.on("close", () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("socket closed"));
  });
  return (n: number): Promise<Buffer> => {
    if (buf.length >= n) {
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return Promise.resolve(Buffer.from(out));
    }
    return new Promise<Buffer>((resolve, reject) => {
      waiters.push({ n, resolve, reject });
    });
  };
}

// Minimal SOCKS5 stub: NO_AUTH (0x00) or USERNAME/PASSWORD (0x02).
// Hostnames are resolved via the provided stub table, proving remote (proxy-side) DNS.
async function startSocks5Stub(
  resolveStub: (host: string) => { host: string; port: number } | null,
  expectedAuth?: { user: string; pass: string },
): Promise<{ url: string; port: number; state: SocksState }> {
  const state: SocksState = { connections: 0, authAttempts: [] };
  const server = createNetServer(async (socket) => {
    const readN = createSocksReader(socket);
    try {
      state.connections++;
      const hello = await readN(2);
      const nMethods = hello[1]!;
      const methods = await readN(nMethods);
      const wantsAuth = Boolean(expectedAuth);
      if (wantsAuth) {
        if (!methods.includes(0x02)) {
          socket.write(Buffer.from([0x05, 0xff]));
          socket.destroy();
          return;
        }
        socket.write(Buffer.from([0x05, 0x02]));
        const authHead = await readN(2);
        const ulen = authHead[1]!;
        const uname = (await readN(ulen)).toString("utf8");
        const plenBuf = await readN(1);
        const plen = plenBuf[0]!;
        const passwd = (await readN(plen)).toString("utf8");
        state.authAttempts.push(`${uname}:${passwd}`);
        if (uname !== expectedAuth!.user || passwd !== expectedAuth!.pass) {
          socket.write(Buffer.from([0x01, 0x01]));
          socket.destroy();
          return;
        }
        socket.write(Buffer.from([0x01, 0x00]));
      } else {
        socket.write(Buffer.from([0x05, 0x00]));
      }
      const reqHead = await readN(4);
      if (reqHead[0] !== 0x05 || reqHead[1] !== 0x01) {
        socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.destroy();
        return;
      }
      const atyp = reqHead[3]!;
      let host = "";
      if (atyp === 0x01) {
        const raw = await readN(4 + 2);
        host = Array.from(raw.subarray(0, 4)).join(".");
        state.lastPort = raw.readUInt16BE(4);
      } else if (atyp === 0x03) {
        const lenBuf = await readN(1);
        const len = lenBuf[0]!;
        const rest = await readN(len + 2);
        host = rest.subarray(0, len).toString("utf8");
        state.lastPort = rest.readUInt16BE(len);
      } else if (atyp === 0x04) {
        await readN(16 + 2);
        socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.destroy();
        return;
      } else {
        socket.destroy();
        return;
      }
      state.lastAtyp = atyp;
      state.lastHost = host;
      const mapped = resolveStub(host);
      if (!mapped) {
        socket.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.destroy();
        return;
      }
      const upstream = netConnect(mapped.port, mapped.host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", () => {
        try {
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        } catch {
          // ignore
        }
        socket.destroy();
      });
      upstream.on("close", () => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      });
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    } catch {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  });
  const port = await listenOnLocalhost(server);
  track(server);
  const authPrefix = expectedAuth ? `${encodeURIComponent(expectedAuth.user)}:${encodeURIComponent(expectedAuth.pass)}@` : "";
  return { url: `socks5h://${authPrefix}127.0.0.1:${port}`, port, state };
}

function configFor(proxyUrl: string, allowedOrigins: string[], route?: Partial<CodeSocksConfig["providers"][string]>): CodeSocksConfig {
  return {
    enabled: true,
    proxies: { testproxy: proxyUrl },
    providers: {
      test: {
        proxy: "testproxy",
        allowedOrigins,
        maxConcurrent: 4,
        minIntervalMs: 0,
        timeoutMs: 5000,
        maxQueueWaitMs: 1000,
        ...route,
      },
    },
  };
}

test("SOCKS5h keeps DNS remote: stub hostname reaches proxy as a domain", async () => {
  const origin = await startHttpOrigin();
  const socks = await startSocks5Stub((host) => {
    if (host === "origin.test") return { host: "127.0.0.1", port: origin.port };
    if (host === "127.0.0.1") return { host: "127.0.0.1", port: origin.port };
    return null;
  });
  const relay = await createRelay(configFor(socks.url, [`http://origin.test:${origin.port}`]));
  trackRelay(relay);

  const rewritten = relay.rewrite(new Request(`http://origin.test:${origin.port}/v1/stream?x=1`), "test");
  const response = await fetch(rewritten);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("data: first\n\ndata: last\n\n");
  expect(origin.state.hits).toBe(1);
  // ATYP 0x03 proves the client sent a domain name, not a pre-resolved IPv4.
  expect(socks.state.lastAtyp).toBe(0x03);
  expect(socks.state.lastHost).toBe("origin.test");
});

test("HTTPS over HTTP CONNECT tunnels TLS with verification enabled", async () => {
  const origin = await startHttpsOrigin();
  const proxy = await startConnectProxy();
  const relay = await createRelay(configFor(proxy.url, [origin.base]));
  trackRelay(relay);

  const response = await fetch(relay.rewrite(new Request(origin.base), "test"));
  // The CONNECT tunnel must have been attempted against loopback only.
  expect(proxy.state.connects.length).toBeGreaterThanOrEqual(1);
  expect(proxy.state.connects[0]).toBe(`127.0.0.1:${origin.port}`);

  if (response.status === 200) {
    // Runtime already trusts the fixture CA (e.g. NODE_EXTRA_CA_CERTS set by parent).
    expect(await response.text()).toBe("secure-hello");
    expect(origin.state.hits).toBe(1);
  } else {
    // Without extra CA trust the self-signed fixture must fail closed with a
    // generic 502, never plaintext fallback or a leaked TLS detail.
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toBe("codesocks: proxy transport failed");
  }

});

test("trusted HTTPS traverses the actual CodeSocks relay over CONNECT on Node", async () => {
  const origin = await startHttpsOrigin();
  const proxy = await startConnectProxy();
  const relayModule = pathToFileURL(join(import.meta.dir, "../dist/src/relay.js")).href;
  const check = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const script = `
import { createRelay } from ${JSON.stringify(relayModule)};
const origin = process.env.TEST_ORIGIN_URL;
const relay = await createRelay({ enabled: true, proxies: { p: process.env.TEST_PROXY_URL },
  providers: { test: { proxy: 'p', allowedOrigins: [origin], maxConcurrent: 1,
    minIntervalMs: 0, timeoutMs: 5000, maxQueueWaitMs: 5000 } } });
try {
  const res = await fetch(relay.rewrite(new Request(origin), 'test'));
  const body = await res.text();
  if (res.status !== 200 || body !== 'secure-hello') throw new Error('unexpected ' + res.status + ' ' + body);
  console.log('trusted-relay-ok');
} finally { await relay.close(); }
`;
    execFile(
      "node",
      ["--input-type=module", "-e", script],
      {
        cwd: join(import.meta.dir, ".."),
        timeout: 15000,
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: join(FIXTURE_DIR, "test-cert.pem"),
          TEST_PROXY_URL: proxy.url,
          TEST_ORIGIN_URL: origin.base,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
  expect(check.stdout, check.stderr).toContain("trusted-relay-ok");
  expect(check.code).toBe(0);
  expect(proxy.state.connects).toEqual([`127.0.0.1:${origin.port}`]);
  expect(origin.state.hits).toBe(1);
});

test("HTTP proxy auth traverses CONNECT proxy only with credentials", async () => {
  const origin = await startHttpOrigin();
  const proxy = await startConnectProxy({ user: "tester", pass: "s3cret" });
  const relay = await createRelay(configFor(proxy.url, [origin.base]));
  trackRelay(relay);

  const response = await fetch(relay.rewrite(new Request(origin.base), "test"));
  expect(response.status).toBe(200);
  expect(proxy.state.authSeen).toEqual([`Basic ${Buffer.from("tester:s3cret").toString("base64")}`]);
  expect(origin.state.hits).toBe(1);
});

test("SOCKS5 auth succeeds with credentials and fails closed without them", async () => {
  const origin = await startHttpOrigin();
  const socks = await startSocks5Stub(
    (host) => (host === "127.0.0.1" ? { host: "127.0.0.1", port: origin.port } : null),
    { user: "socksuser", pass: "sockspass" },
  );
  const relay = await createRelay(configFor(socks.url, [origin.base]));
  trackRelay(relay);
  const ok = await fetch(relay.rewrite(new Request(origin.base), "test"));
  expect(ok.status).toBe(200);
  expect(socks.state.authAttempts).toContain("socksuser:sockspass");

  const badPort = socks.port;
  const badRelay = await createRelay(configFor(`socks5h://127.0.0.1:${badPort}`, [origin.base]));
  trackRelay(badRelay);
  const denied = await fetch(badRelay.rewrite(new Request(origin.base), "test"));
  expect(denied.status).toBe(502);
  expect(await denied.text()).toBe("codesocks: proxy transport failed");
});

test("SOCKS5 authentication rejection rotates to authenticated backup without replay", async () => {
  const origin = await startHttpOrigin();
  const socks = await startSocks5Stub(() => ({ host: "127.0.0.1", port: origin.port }), { user: "tester", pass: "correct" });
  const config = configFor(`socks5h://tester:wrong@127.0.0.1:${socks.port}`, [origin.base], {
    rotation: { enabled: true, proxies: ["backup"], cooldownMs: 10000 },
  });
  config.proxies.backup = socks.url;
  const relay = await createRelay(config); trackRelay(relay);
  const rejected = await fetch(relay.rewrite(new Request(origin.base, { method: "POST", body: "prompt" }), "test"));
  expect(rejected.status).toBe(502); await rejected.text();
  expect(origin.state.hits).toBe(0); expect(socks.state.authAttempts).toEqual(["tester:wrong"]);
  const accepted = await fetch(relay.rewrite(new Request(origin.base, { method: "POST", body: "prompt" }), "test"));
  expect(accepted.status).toBe(200); await accepted.text(); expect(origin.state.hits).toBe(1);
  expect(socks.state.authAttempts).toEqual(["tester:wrong", "tester:correct"]);
  expect(relay.status().providers[0]!.proxy).toBe("backup");
  expect(JSON.stringify(relay.status())).not.toContain("correct");
});

test("HTTPS CONNECT authentication failure rotates to trusted authenticated backup on Node", async () => {
  const origin = await startHttpsOrigin();
  const proxy = await startConnectProxy({ user: "tester", pass: "correct" });
  const relayModule = pathToFileURL(join(import.meta.dir, "../dist/src/relay.js")).href;
  const script = `import { createRelay } from ${JSON.stringify(relayModule)};
    const origin = process.env.TEST_ORIGIN_URL;
    const config = { enabled: true, proxies: { bad: process.env.TEST_BAD_PROXY, good: process.env.TEST_GOOD_PROXY },
      providers: { test: { proxy: 'bad', allowedOrigins: [origin], maxConcurrent: 2, minIntervalMs: 0, timeoutMs: 5000, maxQueueWaitMs: 5000,
        rotation: { enabled: true, proxies: ['good'], cooldownMs: 10000 } } } };
    const relay = await createRelay(config);
    try {
      const first = await fetch(relay.rewrite(new Request(origin, { method: 'POST', body: 'prompt' }), 'test'));
      if (first.status !== 502) throw Error('bad proxy did not fail'); await first.text();
      if (relay.status().providers[0].proxy !== 'good') throw Error('did not rotate');
      const next = await fetch(relay.rewrite(new Request(origin), 'test'));
      if (next.status !== 200 || await next.text() !== 'secure-hello') throw Error('backup failed');
      console.log('connect-rotation-ok');
    } finally { await relay.close(); }`;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("node", ["--input-type=module", "-e", script], { timeout: 15000, env: { ...process.env,
      NODE_EXTRA_CA_CERTS: join(FIXTURE_DIR, "test-cert.pem"), TEST_ORIGIN_URL: origin.base,
      TEST_BAD_PROXY: `http://tester:wrong@127.0.0.1:${proxy.port}`, TEST_GOOD_PROXY: proxy.url,
    } }, (error, out, stderr) => { if (error) reject(Error(stderr)); else resolve(out); });
  });
  expect(stdout).toContain("connect-rotation-ok"); expect(origin.state.hits).toBe(1);
  expect(proxy.state.authSeen).toEqual([`Basic ${Buffer.from("tester:wrong").toString("base64")}`, `Basic ${Buffer.from("tester:correct").toString("base64")}`]);
});

test("dead proxy fails closed and origin never receives the request", async () => {
  const origin = await startHttpOrigin();
  const dead = createNetServer(() => {});
  const deadPort = await listenOnLocalhost(dead);
  await new Promise<void>((resolve) => dead.close(() => resolve()));
  const relay = await createRelay(configFor(`http://127.0.0.1:${deadPort}`, [origin.base], { timeoutMs: 2000 }));
  trackRelay(relay);

  const response = await fetch(relay.rewrite(new Request(origin.base), "test"));
  expect(response.status).toBe(502);
  expect(await response.text()).toBe("codesocks: proxy transport failed");
  expect(origin.state.hits).toBe(0);
});

test("abort mid SSE cancels the upstream socket", async () => {
  const origin = await startHttpOrigin();
  const proxy = await startConnectProxy();
  // Route through the plain forward proxy so the SSE path is exercised end to end.
  const relay = await createRelay(configFor(proxy.url, [origin.base]));
  trackRelay(relay);

  const controller = new AbortController();
  const response = await fetch(relay.rewrite(new Request(`${origin.base}/sse-slow`), "test"), {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  controller.abort();
  try {
    await reader.read();
  } catch {
    // abort surfaces as a read error in some runtimes
  }
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  const deadline = Date.now() + 3000;
  while (!origin.state.clientClosed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(origin.state.clientClosed).toBe(true);
  await relay.close();
});

test("slow upstream times out with a generic error", async () => {
  const origin = await startHttpOrigin();
  const proxy = await startConnectProxy();
  const relay = await createRelay(configFor(proxy.url, [origin.base], { timeoutMs: 150, maxQueueWaitMs: 1000 }));
  trackRelay(relay);

  const response = await fetch(relay.rewrite(new Request(`${origin.base}/slow`), "test"));
  expect(response.status).toBe(502);
  const body = await response.text();
  expect(body).toBe("codesocks: proxy transport failed");
});
