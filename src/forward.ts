import { request as httpRequest, type Agent, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Gate } from "./gate.js";
import { retryAfterMs } from "./gate.js";
import type { Route } from "./types.js";

export function cleanHeaders(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const cleaned = { ...headers };
  const connection = String(headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase());
  for (const key of ["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-authenticate", ...connection]) delete cleaned[key];
  return cleaned;
}

export async function forward(
  incoming: IncomingMessage, response: ServerResponse, target: URL,
  route: Route, select: () => { agent: Agent; failed(): void; succeeded(): void; rateLimited(retryMs: number): void } | undefined, gate: Gate,
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  response.once("close", cancel); incoming.once("aborted", cancel);
  let release: (() => void) | undefined;
  try { release = await gate.acquire(controller.signal); }
  catch {
    if (!response.destroyed) { response.writeHead(503); response.end("codesocks: proxy queue unavailable"); }
    response.removeListener("close", cancel); incoming.removeListener("aborted", cancel); return;
  }
  if (controller.signal.aborted) { release(); return; }
  let selection: ReturnType<typeof select>;
  try { selection = select(); }
  catch { release(); response.removeListener("close", cancel); incoming.removeListener("aborted", cancel); throw Error("codesocks: proxy selection failed"); }
  if (!selection) {
    release(); response.removeListener("close", cancel); incoming.removeListener("aborted", cancel);
    response.writeHead(503); response.end("codesocks: all proxies cooling down"); return;
  }
  let finished = false;
  let rateLimited = false;
  let timer: ReturnType<typeof setTimeout>;
  const done = () => {
    if (finished) return;
    finished = true; clearTimeout(timer); release?.();
    response.removeListener("close", cancel); incoming.removeListener("aborted", cancel);
    controller.abort();
  };
  const fail = (transport = false) => {
    if (finished) return;
    if (transport && !controller.signal.aborted) selection.failed();
    if (!response.destroyed) {
      if (response.headersSent) response.destroy();
      else { response.writeHead(502); response.end("codesocks: proxy transport failed"); }
    }
    done();
  };
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = request(target, {
    method: incoming.method, headers: cleanHeaders(incoming.headers), agent: selection.agent, signal: controller.signal,
  }, (reply) => {
    const status = reply.statusCode ?? 502;
    if (status === 407) { reply.destroy(); fail(true); return; }
    if (status >= 300 && status < 400) { reply.destroy(); fail(); return; }
    if (status === 429) {
      const header = reply.headers["retry-after"];
      const value = Array.isArray(header) ? header[0] : header;
      // Keep provider-wide backoff: a 429 does not prove an IP-scoped limit.
      rateLimited = true; gate.cooldown(value); selection.rateLimited(retryAfterMs(value));
    }
    response.writeHead(status, cleanHeaders(reply.headers));
    reply.on("error", () => fail(true)); reply.pipe(response);
  });
  timer = setTimeout(() => { fail(true); upstream.destroy(); }, route.timeoutMs);
  upstream.on("error", () => fail(true));
  incoming.on("error", () => fail());
  response.once("finish", () => { if (!finished && !rateLimited) selection.succeeded(); done(); }); response.once("close", done);
  incoming.pipe(upstream);
}
