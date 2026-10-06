import { Plugin } from "@opencode/plugin";
import { loadConfig } from "./config.js";
import { createRelay } from "./relay.js";

export default Plugin.define({
  id: "codesocks",
  async setup(ctx) {
    const option = ctx.options.configPath;
    if (option !== undefined && typeof option !== "string") throw Error("codesocks: configPath must be a string");
    for (const key of Object.keys(ctx.options)) if (key !== "configPath") throw Error("codesocks: unknown plugin option");
    const { config } = await loadConfig({ directory: ctx.location.directory, ...(option ? { configPath: option } : {}) });
    if (!config.enabled || !Object.keys(config.providers).length) return;
    const relay = await createRelay(config);
    const registrations: { dispose(): Promise<void> }[] = [];
    let closed = false;
    const cleanup = async () => {
      if (closed) return; closed = true;
      const results = await Promise.allSettled(registrations.reverse().map((entry) => entry.dispose()));
      await relay.close();
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "codesocks: hook cleanup failed");
    };
    try {
      registrations.push(await ctx.provider.transform((editor) => {
        for (const id of Object.keys(config.providers)) editor.update(id, (provider) => {
          provider.settings = { ...provider.settings, transport: "http" };
        });
      }));
      for (const providerID of Object.keys(config.providers)) {
        registrations.push(await ctx.session.hook("http.request", (event) => {
          event.request = relay.rewrite(event.request, providerID);
        }, { providerID }));
        registrations.push(await ctx.session.hook("experimental.ws.handshake", () => {
          throw Error("codesocks: WebSocket transport is not supported; use HTTP for this provider");
        }, { providerID }));
      }
      return cleanup;
    } catch (error) { await cleanup(); throw error; }
  },
});
