import type { Route, RotationDiagnostics } from "./types.js";

export interface Selection { proxy: string; generation: number }

/** Provider-local circuit breaker. Old failures cannot undo a newer selection. */
export class ProxyRotation {
  private active: string;
  private generation = 0;
  private failures = 0;
  private readonly unavailable = new Map<string, number>();
  private readonly pool: string[];
  constructor(private readonly route: Route) {
    this.active = route.proxy;
    this.pool = [route.proxy, ...(route.rotation?.proxies ?? [])];
  }
  get proxy(): string { return this.active; }
  get enabled(): boolean { return this.route.rotation?.enabled ?? false; }
  diagnostics(now = Date.now()): RotationDiagnostics {
    const names = this.pool.includes(this.active) ? this.pool : [this.active, ...this.pool];
    const pool = names.map((proxy) => ({ proxy, cooldownRemainingMs: Math.max(0, (this.unavailable.get(proxy) ?? 0) - now) }));
    const exhausted = this.enabled && pool.every((entry) => entry.cooldownRemainingMs > 0);
    return { pool, exhausted, retryInMs: exhausted ? Math.min(...pool.map((entry) => entry.cooldownRemainingMs)) : 0,
      consecutiveFailures: this.failures, failureThreshold: this.route.rotation?.failureThreshold ?? 1 };
  }
  succeeded(selection: Selection): void {
    if (selection.generation === this.generation && selection.proxy === this.active) this.failures = 0;
  }
  select(now = Date.now()): Selection | undefined {
    if (this.enabled && (this.unavailable.get(this.active) ?? 0) > now) {
      const next = this.pool.find((name) => (this.unavailable.get(name) ?? 0) <= now);
      if (next === undefined) return;
      this.active = next; this.generation++; this.failures = 0;
    }
    return { proxy: this.active, generation: this.generation };
  }
  manual(proxy: string): void {
    this.active = proxy; this.generation++; this.failures = 0; this.unavailable.delete(proxy);
  }
  failed(selection: Selection, now = Date.now()): void {
    if (!this.enabled || selection.generation !== this.generation || selection.proxy !== this.active) return;
    if (++this.failures < (this.route.rotation!.failureThreshold ?? 1)) return;
    this.exclude(selection, this.route.rotation!.cooldownMs, now);
  }
  rateLimited(selection: Selection, retryMs: number, now = Date.now()): void {
    if (!this.enabled || !this.route.rotation?.rotateOnRateLimit || selection.generation !== this.generation || selection.proxy !== this.active) return;
    this.exclude(selection, Math.max(this.route.rotation.cooldownMs, retryMs), now);
  }
  private exclude(selection: Selection, cooldownMs: number, now: number): void {
    this.failures = 0;
    this.unavailable.set(selection.proxy, now + cooldownMs);
    const index = this.pool.indexOf(selection.proxy);
    for (let step = 1; step <= this.pool.length; step++) {
      const next = this.pool[(index + step) % this.pool.length]!;
      if ((this.unavailable.get(next) ?? 0) > now) continue;
      this.active = next; this.generation++; return;
    }
  }
}
