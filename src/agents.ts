import type { Agent } from "node:http";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

export interface EgressAgents {
  http: Agent;
  https: Agent;
  destroy(): void;
}

/** Explicit agents do not consult HTTP_PROXY, HTTPS_PROXY or NO_PROXY. */
export function createAgents(proxy: string): EgressAgents {
  const url = new URL(proxy);
  const socks = url.protocol.startsWith("socks");
  const http = socks ? new SocksProxyAgent(url) : new HttpProxyAgent(url);
  const https = socks ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
  return { http, https, destroy() { http.destroy(); https.destroy(); } };
}
