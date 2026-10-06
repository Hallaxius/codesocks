import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ConfigLocation } from "./types.js";
import { ConfigError } from "./config-validator.js";

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveAgainst(dir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(dir, p);
}

/**
 * Precedência determinística (sem mesclagem):
 * 1. options.configPath (relativo a directory) — deve existir.
 * 2. $CODESOCKS_CONFIG — deve existir.
 * 3. Par sibling mais próximo: codesocks.jsonc ao lado de opencode.json/jsonc,
 *    direto ou dentro de .opencode/, subindo de directory até a raiz.
 * 4. Global: dirname($OPENCODE_CONFIG) / $OPENCODE_CONFIG_DIR /
 *    $XDG_CONFIG_HOME/opencode / <home>/.config/opencode.
 * 5. Ausente => undefined (chamador usa configuração desativada).
 */
export function findConfigPath(options: ConfigLocation): string | undefined {
  const env = options.env ?? process.env;
  const dir = resolve(options.directory);

  if (options.configPath) {
    const p = resolveAgainst(dir, options.configPath);
    if (!isFile(p)) throw new ConfigError("explicit config not found");
    return p;
  }

  const fromEnv = (env["CODESOCKS_CONFIG"] ?? "").trim();
  if (fromEnv !== "") {
    const p = resolveAgainst(dir, fromEnv);
    if (!isFile(p)) throw new ConfigError("explicit config not found");
    return p;
  }

  let current: string | undefined = dir;
  while (current) {
    const directOpencode =
      isFile(join(current, "opencode.json")) || isFile(join(current, "opencode.jsonc"));
    if (directOpencode && isFile(join(current, "codesocks.jsonc"))) {
      return join(current, "codesocks.jsonc");
    }
    const nestedOpencode =
      isFile(join(current, ".opencode", "opencode.json")) ||
      isFile(join(current, ".opencode", "opencode.jsonc"));
    if (nestedOpencode && isFile(join(current, ".opencode", "codesocks.jsonc"))) {
      return join(current, ".opencode", "codesocks.jsonc");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const candidates: string[] = [];
  const openCfg = (env["OPENCODE_CONFIG"] ?? "").trim();
  if (openCfg !== "") {
    const abs = resolveAgainst(dir, openCfg);
    candidates.push(/\.jsonc?$/i.test(abs) ? dirname(abs) : abs);
  } else if ((env["OPENCODE_CONFIG_DIR"] ?? "").trim() !== "") {
    candidates.push(resolveAgainst(dir, env["OPENCODE_CONFIG_DIR"]!.trim()));
  } else if ((env["XDG_CONFIG_HOME"] ?? "").trim() !== "") {
    candidates.push(join(resolveAgainst(dir, env["XDG_CONFIG_HOME"]!.trim()), "opencode"));
  } else {
    const home = options.home ?? env["HOME"] ?? safeHome();
    if (home) candidates.push(join(home, ".config", "opencode"));
  }
  for (const base of candidates) {
    const p = join(base, "codesocks.jsonc");
    if (isFile(p)) return p;
  }
  return undefined;
}

function safeHome(): string | undefined {
  try {
    const h = homedir();
    return h === "" ? undefined : h;
  } catch {
    return undefined;
  }
}
