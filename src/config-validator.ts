import { parse, printParseErrorCode, visit } from "jsonc-parser";
import type { CodeSocksConfig, Route } from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const PROXY_SCHEMES = new Set([
  "http",
  "https",
  "socks4",
  "socks4a",
  "socks5",
  "socks5h",
]);
const ENV_TOKEN = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const TOP_KEYS = new Set(["$schema", "enabled", "proxies", "providers"]);
const ROUTE_KEYS = new Set([
  "proxy",
  "allowedOrigins",
  "maxConcurrent",
  "minIntervalMs",
  "timeoutMs",
  "maxQueueWaitMs",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function intIn(name: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`invalid ${name}`);
  }
  return v;
}

function resolveProxy(name: string, raw: unknown, env: NodeJS.ProcessEnv): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ConfigError(`invalid proxy "${name}"`);
  }
  if (raw.includes("{") || raw.includes("}")) {
    const missing: string[] = [];
    const out = raw.replace(ENV_TOKEN, (_m, varName: string) => {
      const val = env[varName];
      if (val === undefined || val === "") {
        missing.push(varName);
        return "";
      }
      return val;
    });
    if (missing.length > 0) throw new ConfigError(`missing env for proxy "${name}"`);
    if (out.includes("{") || out.includes("}")) {
      throw new ConfigError(`invalid proxy "${name}"`);
    }
    return assertProxyUrl(name, out);
  }
  return assertProxyUrl(name, raw);
}

function assertProxyUrl(name: string, urlText: string): string {
  let u: URL;
  try {
    u = new URL(urlText);
  } catch {
    throw new ConfigError(`invalid proxy "${name}"`);
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!PROXY_SCHEMES.has(scheme)) throw new ConfigError(`invalid proxy "${name}"`);
  if (!u.hostname) throw new ConfigError(`invalid proxy "${name}"`);
  if (u.pathname !== "" && u.pathname !== "/") throw new ConfigError(`invalid proxy "${name}"`);
  if (u.search !== "" || u.hash !== "") throw new ConfigError(`invalid proxy "${name}"`);
  return urlText;
}

function assertOrigin(provider: string, raw: unknown): string {
  if (typeof raw !== "string") throw new ConfigError(`invalid origin for "${provider}"`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`invalid origin for "${provider}"`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ConfigError(`invalid origin for "${provider}"`);
  }
  if (u.username !== "" || u.password !== "") throw new ConfigError(`invalid origin for "${provider}"`);
  if (!u.hostname) throw new ConfigError(`invalid origin for "${provider}"`);
  if (u.pathname !== "" && u.pathname !== "/") throw new ConfigError(`invalid origin for "${provider}"`);
  if (u.search !== "" || u.hash !== "") throw new ConfigError(`invalid origin for "${provider}"`);
  return u.origin;
}

/** Validates an already-parsed JSONC object; never includes URLs or original text in errors. */
export function validateDocument(doc: unknown, env: NodeJS.ProcessEnv): CodeSocksConfig {
  if (!isRecord(doc)) throw new ConfigError("invalid config document");
  for (const k of Object.keys(doc)) {
    if (!TOP_KEYS.has(k)) throw new ConfigError(`unknown field "${k}"`);
  }
  const enabled = doc["enabled"] === undefined ? true : doc["enabled"];
  if (typeof enabled !== "boolean") throw new ConfigError("invalid enabled");
  if (doc["$schema"] !== undefined && typeof doc["$schema"] !== "string") {
    throw new ConfigError("invalid $schema");
  }
  if (!isRecord(doc["proxies"])) throw new ConfigError("invalid proxies");
  if (!isRecord(doc["providers"])) throw new ConfigError("invalid providers");
  const proxies: Record<string, string> = Object.create(null);
  for (const [name, raw] of Object.entries(doc["proxies"])) {
    proxies[name] = resolveProxy(name, raw, env);
  }
  const providers: Record<string, Route> = Object.create(null);
  for (const [id, raw] of Object.entries(doc["providers"])) {
    if (!isRecord(raw)) throw new ConfigError(`invalid provider "${id}"`);
    for (const k of Object.keys(raw)) {
      if (!ROUTE_KEYS.has(k)) throw new ConfigError(`unknown field "${id}.${k}"`);
    }
    const proxy = raw["proxy"];
    if (typeof proxy !== "string" || !Object.hasOwn(proxies, proxy)) {
      throw new ConfigError(`unknown proxy for "${id}"`);
    }
    const origins = raw["allowedOrigins"];
    if (!Array.isArray(origins) || origins.length === 0) {
      throw new ConfigError(`invalid allowedOrigins for "${id}"`);
    }
    providers[id] = {
      proxy,
      allowedOrigins: origins.map((o) => assertOrigin(id, o)),
      maxConcurrent: raw["maxConcurrent"] === undefined ? 2 : intIn(`${id}.maxConcurrent`, raw["maxConcurrent"], 1, 64),
      minIntervalMs: raw["minIntervalMs"] === undefined ? 0 : intIn(`${id}.minIntervalMs`, raw["minIntervalMs"], 0, 60_000),
      timeoutMs: raw["timeoutMs"] === undefined ? 120_000 : intIn(`${id}.timeoutMs`, raw["timeoutMs"], 1, 3_600_000),
      maxQueueWaitMs: raw["maxQueueWaitMs"] === undefined ? 120_000 : intIn(`${id}.maxQueueWaitMs`, raw["maxQueueWaitMs"], 1, 3_600_000),
    };
  }
  return { enabled, proxies, providers };
}

/**
 * Converts JSONC to CodeSocksConfig with defaults.
 * Accepts comments and trailing commas; rejects syntax errors and unknown fields.
 */
export function parseConfig(text: string, env: NodeJS.ProcessEnv = {}): CodeSocksConfig {
  let reserved = false;
  visit(text, { onObjectProperty: (name) => { if (name === "__proto__") reserved = true; } });
  if (reserved) throw new ConfigError("reserved dictionary key");
  const errors: import("jsonc-parser").ParseError[] = [];
  const doc = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (errors.length > 0) {
    const code = printParseErrorCode(errors[0]!.error);
    throw new ConfigError(`invalid JSONC (${code})`);
  }
  return validateDocument(doc, env);
}
