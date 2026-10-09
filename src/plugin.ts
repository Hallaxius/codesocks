import { Plugin } from "@opencode/plugin";
import { loadConfig } from "./config.js";
import { createRelay } from "./relay.js";
import { CodeSocksRpc } from "./rpc.js";
import { saveProxy } from "./config-write.js";

export default Plugin.define({
  id: "codesocks",
  async setup(ctx) {
    const option = ctx.options.configPath;
    if (option !== undefined && typeof option !== "string") throw Error("codesocks: configPath must be a string");
    for (const key of Object.keys(ctx.options)) if (key !== "configPath") throw Error("codesocks: unknown plugin option");
    const location = { directory: ctx.location.directory, ...(option ? { configPath: option } : {}) };
    let { config, path } = await loadConfig(location);
    const relay = await createRelay(config);
    const registrations: { dispose(): Promise<void> }[] = [];
    let closed = false;
    let pending = Promise.resolve();
    const serialize = <T>(work: () => Promise<T>): Promise<T> => {
      const result = pending.then(() => { if (closed) throw Error("codesocks: plugin closed"); return work(); });
      pending = result.then(() => {}, () => {}); return result;
    };
    const hooked = new Set<string>();
    const registerHooks = async (ids: string[]) => {
      const staged: { dispose(): Promise<void> }[] = [];
      const added: string[] = [];
      try {
        for (const providerID of ids) {
          if (hooked.has(providerID)) continue;
          staged.push(await ctx.session.hook("http.request", (event) => {
            event.request = relay.rewrite(event.request, providerID);
          }, { providerID }));
          staged.push(await ctx.session.hook("experimental.ws.handshake", () => {
            if (config.enabled && Object.hasOwn(config.providers, providerID))
              throw Error("codesocks: WebSocket transport is not supported; use HTTP for this provider");
          }, { providerID }));
          added.push(providerID);
        }
      } catch (error) { await Promise.allSettled(staged.map((entry) => entry.dispose())); throw error; }
      registrations.push(...staged); for (const id of added) hooked.add(id);
    };
    const reload = async () => {
      // Pin discovery after setup: deletion must not silently switch to a different file or direct egress.
      const next = await loadConfig(path ? { ...location, configPath: path } : location);
      await registerHooks(Object.keys(next.config.providers));
      const previous = config;
      config = next.config;
      try { await ctx.provider.reload(); relay.update(config); path = next.path; }
      catch (error) { config = previous; await ctx.provider.reload(); throw error; }
      return relay.status();
    };
    const cleanup = async () => {
      if (closed) return; closed = true;
      await pending;
      const results = await Promise.allSettled(registrations.reverse().map((entry) => entry.dispose()));
      await relay.close();
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "codesocks: hook cleanup failed");
    };
    try {
      registrations.push(await ctx.rpc.register(CodeSocksRpc, {
        status: async () => relay.status(),
        reload: async (_input, context) => {
          try { return await serialize(reload); }
          catch { return context.error("reload_failed", "codesocks: reload failed; previous routing retained", {}); }
        },
        select: async (input, context) => {
          const { providerID, proxy, persist } = input as { providerID: string; proxy: string; persist?: boolean };
          try { return await serialize(async () => {
            if (persist) {
              if (!path) throw Error("codesocks: no selected config file");
              await saveProxy(path, providerID, proxy); return reload();
            }
            relay.selectProxy(providerID, proxy); return relay.status();
          }); }
          catch { return context.error("invalid_selection", "codesocks: invalid proxy selection", {}); }
        },
      }));
      registrations.push(await ctx.provider.transform((editor) => {
        for (const id of config.enabled ? Object.keys(config.providers) : []) editor.update(id, (provider) => {
          provider.settings = { ...provider.settings, transport: "http" };
        });
      }));
      await registerHooks(Object.keys(config.providers));
      return cleanup;
    } catch (error) { await cleanup(); throw error; }
  },
});
