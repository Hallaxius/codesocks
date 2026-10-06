import { readFile } from "node:fs/promises";
import type { CodeSocksConfig, ConfigLocation, LoadedConfig } from "./types.js";
import { ConfigError, parseConfig } from "./config-validator.js";
import { findConfigPath } from "./config-discovery.js";

export { ConfigError, parseConfig };
export type { CodeSocksConfig, ConfigLocation, LoadedConfig };

const DISABLED: CodeSocksConfig = { enabled: false, proxies: {}, providers: {} };

/**
 * Carrega codesocks.jsonc seguindo a precedência de findConfigPath.
 * Ausência automática => desativado com mapas vazios; arquivo selecionado
 * malformado => falha fechada (lança ConfigError).
 */
export async function loadConfig(options: ConfigLocation): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const path = findConfigPath(options);
  if (!path) return { config: { ...DISABLED, proxies: {}, providers: {} } };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ConfigError("cannot read selected config");
  }
  return { path, config: parseConfig(text, env) };
}
