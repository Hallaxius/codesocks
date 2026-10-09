import { expect, test } from "bun:test";
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { Plugin } from "@opencode/plugin";
import server from "../index.js";

test("TUI commands remain available in autocomplete and modal palette modes", async () => {
  const { default: tui } = await import("../src/tui.js");
  let layer!: { mode?: string; commands: { id: string; palette?: boolean; slash?: { name: string } }[] };
  const context = {
    client: { rpc: () => ({}) },
    keymap: { layer: (factory: () => typeof layer) => { layer = factory(); } },
  } as unknown as TuiPlugin.Context;
  await tui.setup(context);
  // V2 defaults unspecified layers to base; autocomplete/modal filter them out.
  expect(layer.mode).toBe("global");
  expect(layer.commands.map((command) => command.slash?.name)).toEqual(["codesocks", "codesocks-reload"]);
  expect(layer.commands.every((command) => command.palette)).toBe(true);
});

test("V2 host loads both local entrypoints under Node", async () => {
  const script = `(async () => {
    const { Host } = await import('@opencode/plugin/host');
    const entries = Host.resolve({ directory: process.cwd() });
    if (!entries.server || !entries.tui) throw Error('missing entrypoint');
    const server = await Host.load(entries.server);
    const tui = await Host.load(entries.tui);
    console.log(JSON.stringify([server.default.id, tui.default.id]));
  })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("node", ["-e", script], { cwd: join(import.meta.dir, ".."), timeout: 10000 }, (error, stdout, stderr) => {
      if (error) reject(Error(`${error.message}\n${stderr}`)); else resolve(stdout);
    });
  });
  expect(JSON.parse(stdout)).toEqual(["codesocks", "codesocks-tui"]);
});

test("server RPC selects a configured proxy and returns names only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codesocks-rpc-"));
  let methods: { status(): Promise<unknown>; select(input: unknown, context: { error: (...args: unknown[]) => unknown }): Promise<unknown> } | undefined;
  const context = {
    location: { directory }, options: { configPath: "codesocks.jsonc" },
    provider: { transform: async () => ({ dispose: async () => {} }) },
    session: { hook: async () => ({ dispose: async () => {} }) },
    rpc: { register: async (_definition: unknown, handlers: typeof methods) => { methods = handlers; return { dispose: async () => {} }; } },
  } as unknown as Plugin.Context;
  let cleanup: Awaited<ReturnType<typeof server.setup>>;
  try {
    await writeFile(join(directory, "codesocks.jsonc"), JSON.stringify({ proxies: {
      a: "http://private:secret@localhost:1", b: "http://localhost:2",
    }, providers: { p: { proxy: "a", allowedOrigins: ["https://example.com"] } } }));
    cleanup = await server.setup(context);
    expect(methods).toBeDefined();
    const status = await methods!.select({ providerID: "p", proxy: "b" }, { error: () => { throw Error("rejected"); } });
    expect(status).toMatchObject({ proxies: ["a", "b"], providers: [{ id: "p", proxy: "b", rotation: false, exhausted: false }] });
    expect(JSON.stringify(await methods!.status())).not.toContain("secret");
    await expect(methods!.select({ providerID: "p", proxy: "missing" }, { error: () => { throw Error("rejected"); } })).rejects.toThrow("rejected");
  } finally { await cleanup!?.(); await rm(directory, { recursive: true, force: true }); }
});

for (const choice of ["b", undefined]) test(`TUI provider and proxy selection ${choice ?? "cancel"}`, async () => {
  const { default: tui } = await import("../src/tui.js");
  let active = "a"; let calls = 0;
  let run: (() => Promise<void>) | undefined;
  const dialogs: unknown[] = [];
  const location = { directory: "/project" };
  const rpc = {
    status: async (_input: unknown, options: unknown) => {
      expect(options).toEqual({ location });
      return { proxies: ["a", "b"], providers: [{ id: "p", proxy: active, rotation: false, pool: [], consecutiveFailures: 0, failureThreshold: 1, exhausted: false, retryInMs: 0 }] };
    },
    select: async (input: { providerID: string; proxy: string }, options: unknown) => {
      expect(options).toEqual({ location }); expect(input.providerID).toBe("p");
      active = input.proxy; calls++;
    },
  };
  const context = {
    client: { rpc: () => rpc }, location,
    keymap: { layer: (factory: () => { commands: { run: () => Promise<void> }[] }) => { run = factory().commands[0]!.run; } },
    ui: { dialog: { select: async (options: unknown) => { dialogs.push(options); return dialogs.length === 1 ? { providerID: "p" } : dialogs.length === 2 ? choice : "temporary"; } },
      toast: { show: () => {} } },
  } as unknown as TuiPlugin.Context;
  await tui.setup(context); await run!();
   expect(dialogs).toHaveLength(choice === undefined ? 2 : 3);
  expect(active).toBe(choice ?? "a"); expect(calls).toBe(choice === undefined ? 0 : 1);
});

test("global TUI uses the open session location instead of the launch directory", async () => {
  const { default: tui } = await import("../src/tui.js");
  let run!: () => Promise<void>; let selected: unknown;
  const context = {
    client: { rpc: () => ({ status: async (_input: unknown, options: unknown) => {
      selected = options; return { proxies: [], providers: [] };
    } }) },
    data: { session: { get: () => ({ location: { directory: "/worktree" } }) },
      location: { default: () => ({ directory: "/launch" }) } },
    keymap: { layer: (factory: () => { commands: { run: () => Promise<void> }[] }) => { run = factory().commands[0]!.run; } },
    ui: { router: { current: () => ({ type: "session", sessionID: "session" }) }, toast: { show: () => {} } },
  } as unknown as TuiPlugin.Context;
  await tui.setup(context); await run();
  expect(selected).toEqual({ location: { directory: "/worktree" } });
});
