export interface Rotation {
  enabled: boolean;
  proxies: string[];
  cooldownMs: number;
  failureThreshold?: number;
  rotateOnRateLimit?: boolean;
}

export interface Route {
  proxy: string;
  rotation?: Rotation;
  allowedOrigins: string[];
  maxConcurrent: number;
  minIntervalMs: number;
  timeoutMs: number;
  maxQueueWaitMs: number;
}

/** Public status deliberately contains names only, never proxy URLs. */
export interface ProxyStatus {
  proxies: string[];
  providers: ({ id: string; proxy: string; rotation: boolean } & RotationDiagnostics)[];
}

export interface RotationDiagnostics {
  consecutiveFailures: number;
  failureThreshold: number;
  exhausted: boolean;
  retryInMs: number;
  pool: { proxy: string; cooldownRemainingMs: number }[];
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
