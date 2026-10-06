import { test, expect } from "bun:test";
import { parseConfig } from "../src/config.js";

test("origin allowlist normalizes host case, default ports and root slash", () => {
  const config = parseConfig(JSON.stringify({ proxies: { p: "http://127.0.0.1:8080" }, providers: {
    a: { proxy: "p", allowedOrigins: ["https://API.EXAMPLE.COM:443/"] },
  } }));
  expect(config.providers.a!.allowedOrigins).toEqual(["https://api.example.com"]);
});

test("inherited object properties cannot masquerade as configured proxies", () => {
  expect(() => parseConfig(JSON.stringify({ proxies: {}, providers: {
    a: { proxy: "constructor", allowedOrigins: ["https://api.example.com"] },
  } }))).toThrow("unknown proxy");
});

test("prototype mutation keys are rejected before JSONC object construction", () => {
  expect(() => parseConfig('{"proxies":{"__proto__":"http://127.0.0.1:8080"},"providers":{}}')).toThrow("reserved");
});
