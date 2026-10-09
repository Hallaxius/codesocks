import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";
import { ProxyRotation } from "../src/rotation.js";
import server from "../src/plugin.js";
import type { Plugin } from "@opencode/plugin";
import { saveProxy } from "../src/config-write.js";

const document = (threshold = 2) => ({ proxies: { a: "http://{env:TEST_USER}@localhost:1", b: "http://localhost:2" },
  providers: { p: { proxy: "a", allowedOrigins: ["https://example.com"], rotation: { enabled: true, proxies: ["b"], failureThreshold: threshold, cooldownMs: 100 } } } });

test("consecutive failures reset after a complete success and status reports cooldown/exhaustion", () => {
  const config = parseConfig(JSON.stringify(document()), { TEST_USER: "secret" });
  const state = new ProxyRotation(config.providers.p!);
  state.failed(state.select(0)!, 0); expect(state.proxy).toBe("a");
  expect(state.diagnostics(0).consecutiveFailures).toBe(1);
  state.succeeded(state.select(1)!);
  state.failed(state.select(2)!, 2); expect(state.proxy).toBe("a");
  state.failed(state.select(3)!, 3); expect(state.proxy).toBe("b");
  state.failed(state.select(4)!, 4); state.failed(state.select(5)!, 5);
  expect(state.diagnostics(6)).toMatchObject({ exhausted: true, retryInMs: 97,
    pool: [{ proxy: "a", cooldownRemainingMs: 97 }, { proxy: "b", cooldownRemainingMs: 99 }] });
  expect(state.diagnostics(103).exhausted).toBe(false);
});

for (const threshold of [0, 65, 1.5, null, "2"]) test(`rejects threshold ${threshold}`, () => {
  expect(() => parseConfig(JSON.stringify(document(threshold as number)), { TEST_USER: "secret" })).toThrow();
});

test("saving a new primary preserves comments within the fallback array", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codesocks-comments-")); const path = join(directory, "codesocks.jsonc");
  try {
    await writeFile(path, `{
      "proxies": { "a": "http://localhost:1", "b": "http://localhost:2" },
      "providers": { "p": { "proxy": "a", "allowedOrigins": ["https://example.com"],
        "rotation": { "proxies": [
          // keep the backup explanation
          "b" // keep this inline comment too
        ] }
      } }
    }`);
    await saveProxy(path, "p", "b");
    const saved = await readFile(path, "utf8");
    expect(saved).toContain("// keep the backup explanation"); expect(saved).toContain("// keep this inline comment too");
    expect(parseConfig(saved).providers.p).toMatchObject({ proxy: "b", rotation: { proxies: ["a"] } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("saving refuses an existing writer lock without changing the document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codesocks-lock-")); const path = join(directory, "codesocks.jsonc");
  const content = JSON.stringify({ proxies: { a: "http://localhost:1", b: "http://localhost:2" }, providers: { p: { proxy: "a", allowedOrigins: ["https://example.com"] } } });
  try {
    await writeFile(path, content); await writeFile(`${path}.codesocks-lock`, "another writer");
    await expect(saveProxy(path, "p", "b")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(content);
    expect(await readFile(`${path}.codesocks-lock`, "utf8")).toBe("another writer");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("RPC save preserves comments/env and reload rejects invalid edits without replacing live selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codesocks-improve-"));
  const path = join(directory, "codesocks.jsonc");
  const priorEnv = process.env.TEST_USER; process.env.TEST_USER = "secret";
  let methods!: { select(input: unknown, context: unknown): Promise<unknown>; reload(input: unknown, context: unknown): Promise<unknown>;
    status(): Promise<import("../src/types.js").ProxyStatus> };
  let reloads = 0; let cleanup: Awaited<ReturnType<typeof server.setup>>;
  const context = { location: { directory }, options: { configPath: "codesocks.jsonc" },
    rpc: { register: async (_: unknown, handlers: typeof methods) => { methods = handlers; return { dispose: async () => {} }; } },
    provider: { transform: async () => ({ dispose: async () => {} }), reload: async () => { reloads++; } },
    session: { hook: async () => ({ dispose: async () => {} }) },
  } as unknown as Plugin.Context;
  const errorContext = { error: () => { throw Error("sanitized rejection"); } };
  try {
    await writeFile(path, "// retain this comment\n" + JSON.stringify(document(), null, 2));
    cleanup = await server.setup(context);
    await methods.select({ providerID: "p", proxy: "b", persist: true }, errorContext);
    const saved = await readFile(path, "utf8");
    expect(saved).toContain("// retain this comment"); expect(saved).toContain("{env:TEST_USER}"); expect(saved).not.toContain("secret");
    expect(parseConfig(saved, process.env).providers.p).toMatchObject({ proxy: "b", rotation: { proxies: ["a"] } });
    await writeFile(path, "{ invalid secret");
    await expect(methods.reload({}, errorContext)).rejects.toThrow("sanitized rejection");
    expect((await methods.status()).providers[0]!.proxy).toBe("b");
    const next = document(); next.providers.p.rotation.failureThreshold = 3;
    await writeFile(path, JSON.stringify(next));
    await methods.reload({}, errorContext);
    expect((await methods.status()).providers[0]).toMatchObject({ proxy: "a", failureThreshold: 3 });
    expect(reloads).toBeGreaterThan(0);
  } finally { await cleanup!?.(); if (priorEnv === undefined) delete process.env.TEST_USER; else process.env.TEST_USER = priorEnv;
    await rm(directory, { recursive: true, force: true }); }
});

test("an initially disabled plugin can reload and register a new provider without restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codesocks-disabled-")); const path = join(directory, "codesocks.jsonc");
  let methods!: { reload(input: unknown, context: unknown): Promise<unknown>; status(): Promise<import("../src/types.js").ProxyStatus> };
  const hooks: string[] = []; let cleanup: Awaited<ReturnType<typeof server.setup>>;
  const ctx = { location: { directory }, options: { configPath: "codesocks.jsonc" },
    rpc: { register: async (_: unknown, handlers: typeof methods) => { methods = handlers; return { dispose: async () => {} }; } },
    provider: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    session: { hook: async (_name: string, _callback: unknown, scope: { providerID: string }) => { hooks.push(scope.providerID); return { dispose: async () => {} }; } },
  } as unknown as Plugin.Context;
  try {
    await writeFile(path, JSON.stringify({ enabled: false, proxies: {}, providers: {} }));
    cleanup = await server.setup(ctx); expect((await methods.status()).providers).toEqual([]);
    await writeFile(path, JSON.stringify({ proxies: { a: "http://localhost:1" }, providers: { added: { proxy: "a", allowedOrigins: ["https://example.com"] } } }));
    await methods.reload({}, { error: () => { throw Error("rejected"); } });
    expect(hooks).toEqual(["added", "added"]); expect((await methods.status()).providers[0]!.id).toBe("added");
    await rm(path); await expect(methods.reload({}, { error: () => { throw Error("rejected"); } })).rejects.toThrow("rejected");
    expect((await methods.status()).providers[0]!.id).toBe("added");
  } finally { await cleanup!?.(); await rm(directory, { recursive: true, force: true }); }
});
