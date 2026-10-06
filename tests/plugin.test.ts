import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import plugin from "../index.js";

test("entrypoint is a native V2 plugin definition", () => {
  expect(plugin.id).toBe("codesocks"); expect(typeof plugin.setup).toBe("function");
});

test("V2 setup scopes HTTP and websocket hooks and disposes registrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codesocks-plugin-"));
  const hooks: { name: string; provider?: string; callback: (event: { request: Request }) => void }[] = [];
  let disposed = 0;
  let transform: ((editor: { update: (id: string, callback: (provider: { settings: Record<string, unknown> }) => void) => void }) => void) | undefined;
  try {
    await writeFile(join(directory, "codesocks.jsonc"), JSON.stringify({
      proxies: { local: "socks5h://127.0.0.1:1080" },
      providers: { openai: { proxy: "local", allowedOrigins: ["https://api.openai.com"] } },
    }));
    const context = {
      location: { directory }, options: { configPath: "codesocks.jsonc" },
      provider: { transform: async (callback: typeof transform) => { transform = callback; return { dispose: async () => { disposed++; } }; } },
      session: { hook: async (name: string, callback: (event: { request: Request }) => void, options: { providerID: string }) => {
        hooks.push({ name, callback, provider: options.providerID }); return { dispose: async () => { disposed++; } };
      } },
    } as unknown as Plugin.Context;
    const cleanup = await plugin.setup(context);
    expect(hooks.map((hook) => [hook.name, hook.provider])).toEqual([
      ["http.request", "openai"], ["experimental.ws.handshake", "openai"],
    ]);
    const provider: { settings: Record<string, unknown> } = { settings: { custom: "preserve" } };
    transform!({ update: (id, callback) => { expect(id).toBe("openai"); callback(provider); } });
    expect(provider.settings).toEqual({ custom: "preserve", transport: "http" });
    const event = { request: new Request("https://api.openai.com/v1/responses") };
    hooks[0]!.callback(event); expect(new URL(event.request.url).hostname).toBe("127.0.0.1");
    expect(() => hooks[1]!.callback(event)).toThrow("WebSocket");
    await cleanup?.(); expect(disposed).toBe(3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
