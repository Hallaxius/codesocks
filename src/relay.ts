import type { CodeSocksConfig } from "./types.js";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createAgents, type EgressAgents } from "./agents.js";
import { Gate } from "./gate.js";
import { forward } from "./forward.js";
export interface Relay {
  rewrite(request: Request, providerID: string): Request;
  close(): Promise<void>;
}
export async function createRelay(config: CodeSocksConfig): Promise<Relay> {
  let closed = false;
  const agents = new Map<string, EgressAgents>();
  const gates = new Map<string, Gate>();
  const tickets = new Map<string, { target: URL; provider: string; method: string; expires: number; detach: () => void }>();
  for (const [id, route] of Object.entries(config.providers)) {
    const proxy = config.proxies[route.proxy];
    if (!proxy) throw new Error("codesocks: unknown proxy");
    if (!agents.has(route.proxy)) agents.set(route.proxy, createAgents(proxy));
    gates.set(id, new Gate(route));
  }
  const server = createServer((req, res) => {
    const token = req.url ?? ""; const ticket = tickets.get(token);
    if (!ticket || ticket.expires < Date.now() || ticket.method !== req.method) {
      res.writeHead(403); res.end("codesocks: invalid relay ticket"); return;
    }
    tickets.delete(token); ticket.detach();
    const route = config.providers[ticket.provider]!;
    const agent = agents.get(route.proxy)!;
    void forward(req, res, ticket.target, route, ticket.target.protocol === "https:" ? agent.https : agent.http, gates.get(ticket.provider)!).catch(() => {
      if (!res.headersSent) { res.writeHead(502); res.end("codesocks: proxy transport failed"); }
      else res.destroy();
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("codesocks: relay failed to bind");
  server.unref();
  const base = `http://127.0.0.1:${address.port}`;
  const sweep = setInterval(() => {
    for (const [token, ticket] of tickets) if (ticket.expires < Date.now()) { tickets.delete(token); ticket.detach(); }
  }, 30000); sweep.unref();
  return {
    rewrite(request, providerID) {
      const route = config.providers[providerID];
      if (!config.enabled || !route) return request;
      if (closed) throw Error("codesocks: relay closed");
      request.signal.throwIfAborted();
      const target = new URL(request.url);
      if (!route.allowedOrigins.includes(target.origin) || !["http:", "https:"].includes(target.protocol) || target.username || target.password) {
        throw Error("codesocks: upstream origin not allowed");
      }
      if (tickets.size >= 1024) throw Error("codesocks: too many pending requests");
      const token = `/${randomBytes(32).toString("hex")}`;
      const abort = () => { tickets.delete(token); };
      const detach = () => request.signal.removeEventListener("abort", abort);
      const rewritten = new Request(`${base}${token}`, request);
      request.signal.addEventListener("abort", abort, { once: true });
      tickets.set(token, { target, provider: providerID, method: request.method, expires: Date.now() + 60000, detach });
      return rewritten;
    },
    async close() {
      if (closed) return; closed = true; clearInterval(sweep);
      for (const ticket of tickets.values()) ticket.detach(); tickets.clear();
      for (const gate of gates.values()) gate.close();
      for (const agent of agents.values()) agent.destroy();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
