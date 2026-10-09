import { expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin/tui";
import tui from "../src/tui.js";

for (const mode of ["save", undefined]) test(`TUI persistence ${mode ?? "cancel"} and cooldown diagnostics`, async () => {
  let run!: () => Promise<void>; let step = 0; let input: unknown;
  const dialogs: { options: { description?: string }[] }[] = [];
  const ctx = { location: { directory: "/project" }, client: { rpc: () => ({
    status: async () => ({ proxies: ["a", "b"], providers: [{ id: "p", proxy: "b", rotation: true,
      consecutiveFailures: 1, failureThreshold: 2, exhausted: true, retryInMs: 5000,
      pool: [{ proxy: "a", cooldownRemainingMs: 5000 }, { proxy: "b", cooldownRemainingMs: 10000 }] }] }),
    select: async (value: unknown) => { input = value; },
  }) }, keymap: { layer: (factory: () => { commands: { run(): Promise<void> }[] }) => { run = factory().commands[0]!.run; } },
    ui: { dialog: { select: async (dialog: typeof dialogs[number]) => { dialogs.push(dialog); return [{ providerID: "p" }, "a", mode][step++]; } }, toast: { show: () => {} } },
  } as unknown as Plugin.Context;
  await tui.setup(ctx); await run();
  expect(dialogs[0]!.options[0]!.description).toContain("exhausted");
  expect(dialogs[1]!.options[0]!.description).toContain("5s");
  expect(input).toEqual(mode === "save" ? { providerID: "p", proxy: "a", persist: true } : undefined);
});

test("TUI reload command calls the connected location", async () => {
  let run!: () => Promise<void>; let received: unknown;
  const location = { directory: "/remote" };
  const ctx = { location, client: { rpc: () => ({ reload: async (_: unknown, options: unknown) => { received = options; } }) },
    keymap: { layer: (factory: () => { commands: { id: string; run(): Promise<void> }[] }) => { run = factory().commands.find((command) => command.id === "codesocks.reload")!.run; } },
    ui: { toast: { show: () => {} } },
  } as unknown as Plugin.Context;
  await tui.setup(ctx); await run(); expect(received).toEqual({ location });
});
