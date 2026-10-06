export interface Route {
  proxy: string;
  allowedOrigins: string[];
  maxConcurrent: number;
  minIntervalMs: number;
  timeoutMs: number;
  maxQueueWaitMs: number;
}

export interface CodeSocksConfig {
  enabled: boolean;
  proxies: Record<string, string>;
  providers: Record<string, Route>;
}

export interface ConfigLocation {
  directory: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface LoadedConfig {
  path?: string;
  config: CodeSocksConfig;
}
