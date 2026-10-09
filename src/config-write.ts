import { open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { applyEdits, modify } from "jsonc-parser";
import { parseConfig } from "./config.js";

/** Edit the selected server-side document, never serialize resolved credentials. */
export async function saveProxy(path: string, providerID: string, proxy: string): Promise<void> {
  const target = await realpath(path);
  const lock = `${target}.codesocks-lock`;
  const handle = await open(lock, "wx", 0o600);
  const temporary = `${target}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    const original = await readFile(target, "utf8");
    const config = parseConfig(original, process.env);
    const route = config.providers[providerID];
    if (!route || !Object.hasOwn(config.proxies, proxy)) throw Error("codesocks: invalid selection");
    const formattingOptions = { insertSpaces: true, tabSize: 2, eol: original.includes("\r\n") ? "\r\n" : "\n" };
    let updated = applyEdits(original, modify(original, ["providers", providerID, "proxy"], proxy, { formattingOptions }));
    if (route.rotation && route.proxy !== proxy) {
      const index = route.rotation.proxies.indexOf(proxy);
      // Swap only the string token, not the whole array (which would erase its comments).
      updated = applyEdits(updated, modify(updated, ["providers", providerID, "rotation", "proxies", index < 0 ? route.rotation.proxies.length : index], route.proxy, { formattingOptions }));
    }
    parseConfig(updated, process.env);
    const metadata = await stat(target);
    const file = await open(temporary, "wx", metadata.mode & 0o777);
    try { await file.writeFile(updated, "utf8"); await file.sync(); } finally { await file.close(); }
    if (await readFile(target, "utf8") !== original) throw Error("codesocks: config changed while saving");
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
    await handle.close(); await unlink(lock);
  }
}
