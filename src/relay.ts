import type { CodeSocksConfig, ProxyStatus } from "./types.js";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { forward } from "./forward.js";
import { RelayState } from "./relay-state.js";
import { Gate } from "./gate.js";
export interface Relay {
  rewrite(request: Request, providerID: string): Request;
  status(): ProxyStatus;
  selectProxy(providerID: string, proxy: string): void;
  update(config: CodeSocksConfig): void;
  close(): Promise<void>;
}
export async function createRelay(config: CodeSocksConfig): Promise<Relay> {
  let closed = false;
  const gates = new Map<string, Gate>();
  let current = new RelayState(config, gates);
  const states = new Set([current]);
  const collect = (state: RelayState) => {
    if (state.retired && state.references === 0) {
      state.destroy(); states.delete(state);
      for (const [id, gate] of gates) if (![...states].some((entry) => entry.gates.has(id))) { gate.close(); gates.delete(id); }
    }
  };
  const tickets = new Map<string, { target: URL; provider: string; method: string; expires: number; detach: () => void; state: RelayState }>();
  const server = createServer((req, res) => {
    const token = req.url ?? ""; const ticket = tickets.get(token);
    if (!ticket || ticket.expires < Date.now() || ticket.method !== req.method) {
      res.writeHead(403); res.end("codesocks: invalid relay ticket"); return;
    }
    tickets.delete(token); ticket.detach();
    const state = ticket.state;
    let released = false;
    const releaseState = () => { if (!released) { released = true; state.references--; collect(state); } };
    res.once("close", releaseState);
    const route = state.config.providers[ticket.provider]!;
    const rotation = state.rotations.get(ticket.provider)!;
    void forward(req, res, ticket.target, route, () => {
      const selection = rotation.select();
      if (!selection) return;
      const agent = state.agent(selection.proxy);
      return { agent: ticket.target.protocol === "https:" ? agent.https : agent.http,
        failed: () => rotation.failed(selection), succeeded: () => rotation.succeeded(selection),
        rateLimited: (retryMs: number) => rotation.rateLimited(selection, retryMs) };
    }, state.gates.get(ticket.provider)!).catch(() => {
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
    for (const [token, ticket] of tickets) if (ticket.expires < Date.now()) {
      tickets.delete(token); ticket.detach(); ticket.state.references--; collect(ticket.state);
    }
  }, 30000); sweep.unref();
  return {
    status() {
      return { proxies: Object.keys(current.config.proxies), providers: [...current.rotations].map(([id, state]) => ({
        id, proxy: state.proxy, rotation: state.enabled, ...state.diagnostics(),
      })) };
    },
    selectProxy(providerID, proxy) {
      if (closed) throw Error("codesocks: relay closed");
      const state = current.rotations.get(providerID);
      if (!state) throw Error("codesocks: unknown provider");
      if (!Object.hasOwn(current.config.proxies, proxy)) throw Error("codesocks: unknown proxy");
      state.manual(proxy);
    },
    update(config) {
      if (closed) throw Error("codesocks: relay closed");
      if (states.size >= 32) throw Error("codesocks: too many draining configurations");
      const next = new RelayState(config, gates);
      states.add(next); const previous = current; current = next;
      previous.retired = true; collect(previous);
    },
    rewrite(request, providerID) {
      const state = current;
      const route = state.config.providers[providerID];
      if (!state.config.enabled || !route) return request;
      if (closed) throw Error("codesocks: relay closed");
      request.signal.throwIfAborted();
      const target = new URL(request.url);
      if (!route.allowedOrigins.includes(target.origin) || !["http:", "https:"].includes(target.protocol) || target.username || target.password) {
        throw Error("codesocks: upstream origin not allowed");
      }
      if (tickets.size >= 1024) throw Error("codesocks: too many pending requests");
      const token = `/${randomBytes(32).toString("hex")}`;
      const abort = () => { if (tickets.delete(token)) { state.references--; collect(state); } };
      const detach = () => request.signal.removeEventListener("abort", abort);
      const rewritten = new Request(`${base}${token}`, request);
      request.signal.addEventListener("abort", abort, { once: true });
      state.references++;
      tickets.set(token, { target, provider: providerID, method: request.method, expires: Date.now() + 60000, detach, state });
      return rewritten;
    },
    async close() {
      if (closed) return; closed = true; clearInterval(sweep);
      for (const ticket of tickets.values()) ticket.detach(); tickets.clear();
      for (const gate of gates.values()) gate.close(); gates.clear();
      for (const state of states) state.destroy(); states.clear();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
