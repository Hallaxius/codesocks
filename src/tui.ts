import { Plugin } from "@opencode/plugin/tui";
import { CodeSocksRpc } from "./rpc.js";
import type { ProxyStatus } from "./types.js";

export default Plugin.define({
  id: "codesocks-tui",
  setup(ctx) {
    const rpc = ctx.client.rpc(CodeSocksRpc);
    let busy = false;
    const scope = () => {
      const route = ctx.location ? undefined : ctx.ui.router.current();
      const sessionLocation = route?.type === "session" ? ctx.data.session.get(route.sessionID)?.location : undefined;
      return { location: ctx.location ?? sessionLocation ?? ctx.data.location.default() };
    };
    const reload = async (options: ReturnType<typeof scope>) => {
      await rpc.reload({}, options);
      ctx.ui.toast.show({ title: "CodeSocks", message: "Configuration reloaded. Active streams are unchanged.", variant: "success" });
    };
    // Slash autocomplete and the palette use non-base modes in OpenCode V2.
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
      id: "codesocks.proxy", title: "CodeSocks: choose provider proxy", group: "CodeSocks",
      palette: true, slash: { name: "codesocks" },
      async run() {
        if (busy) return;
        busy = true;
        try {
          const options = scope();
          const status = await rpc.status({}, options) as ProxyStatus;
          if (!status.providers.length) {
            ctx.ui.toast.show({ message: "CodeSocks has no configured provider routes.", variant: "info" }); return;
          }
          const choice = await ctx.ui.dialog.select<{ providerID?: string }>({
            title: "CodeSocks · Provider",
            options: [...status.providers.map((provider) => ({ title: provider.id, value: { providerID: provider.id },
              description: `${provider.proxy} · rotation ${provider.rotation ? "on" : "off"} · failures ${provider.consecutiveFailures}/${provider.failureThreshold}${provider.exhausted ? ` · pool exhausted (${Math.ceil(provider.retryInMs / 1000)}s)` : ""}` })),
              { title: "Reload configuration", value: {}, description: "Read the server-side codesocks.jsonc without interrupting streams" }],
          });
          if (choice === undefined) return;
          if (choice.providerID === undefined) { await reload(options); return; }
          const providerID = choice.providerID;
          const provider = status.providers.find((entry) => entry.id === providerID)!;
          const proxy = await ctx.ui.dialog.select({
            title: `CodeSocks · ${providerID}`, current: provider.proxy,
            options: status.proxies.map((name) => {
              const cooldown = provider.pool.find((entry) => entry.proxy === name)?.cooldownRemainingMs ?? 0;
              return { title: name, value: name, description: cooldown > 0
                ? `Cooldown ${Math.ceil(cooldown / 1000)}s · manual selection resets it`
                : name === provider.proxy ? "Selected proxy" : "Use for subsequent requests" };
            }),
          });
          if (proxy === undefined) return;
          const mode = await ctx.ui.dialog.select({ title: "CodeSocks · Apply selection", options: [
            { title: "Use temporarily", value: "temporary", description: "Until configuration/plugin reload" },
            { title: "Save as default", value: "save", description: "Edit the selected codesocks.jsonc on the connected server; preserve comments and env references" },
          ] });
          if (mode === undefined) return;
          await rpc.select({ providerID, proxy, ...(mode === "save" ? { persist: true } : {}) }, options);
          ctx.ui.toast.show({ title: "CodeSocks", message: mode === "save" ? "Default saved and configuration reloaded." : "Temporary proxy selected for subsequent requests.", variant: "success" });
        } catch {
          ctx.ui.toast.show({ title: "CodeSocks", message: "Could not change proxy. Check that CodeSocks is enabled on the connected server.", variant: "error" });
        } finally { busy = false; }
      },
    }, {
      id: "codesocks.reload", title: "CodeSocks: reload configuration", group: "CodeSocks", palette: true, slash: { name: "codesocks-reload" },
      async run() {
        if (busy) return; busy = true;
        try { await reload(scope()); }
        catch { ctx.ui.toast.show({ title: "CodeSocks", message: "Reload failed. Previous routing retained.", variant: "error" }); }
        finally { busy = false; }
      },
    }] }));
  },
});
