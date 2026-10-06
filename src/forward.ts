import { request as httpRequest, type Agent, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Gate } from "./gate.js";
import type { Route } from "./types.js";

export function cleanHeaders(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const cleaned = { ...headers };
  const connection = String(headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase());
  for (const key of ["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-authenticate", ...connection]) delete cleaned[key];
  return cleaned;
}

export async function forward(
  incoming: IncomingMessage, response: ServerResponse, target: URL,
  route: Route, agent: Agent, gate: Gate,
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
  let finished = false;
  let timer: ReturnType<typeof setTimeout>;
  const done = () => {
    if (finished) return;
    finished = true; clearTimeout(timer); release?.();
    response.removeListener("close", cancel); incoming.removeListener("aborted", cancel);
    controller.abort();
  };
  const fail = () => {
    if (!response.destroyed) {
      if (response.headersSent) response.destroy();
      else { response.writeHead(502); response.end("codesocks: proxy transport failed"); }
    }
    done();
  };
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = request(target, {
    method: incoming.method, headers: cleanHeaders(incoming.headers), agent, signal: controller.signal,
  }, (reply) => {
    const status = reply.statusCode ?? 502;
    if (status >= 300 && status < 400) { reply.destroy(); fail(); return; }
    if (status === 429) {
      const header = reply.headers["retry-after"];
      gate.cooldown(Array.isArray(header) ? header[0] : header);
    }
    response.writeHead(status, cleanHeaders(reply.headers));
    reply.on("error", fail); reply.pipe(response);
  });
  timer = setTimeout(() => { upstream.destroy(); fail(); }, route.timeoutMs);
  upstream.on("error", fail);
  incoming.on("error", fail);
  response.once("finish", done); response.once("close", done);
  incoming.pipe(upstream);
}
