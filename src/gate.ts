import type { Route } from "./types.js";
export function retryAfterMs(value: string | undefined, now = Date.now()): number {
  if (!value) return 1000;
  if (/^\d+(\.\d+)?$/.test(value.trim())) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 1000;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  detach: () => void;
}

export class Gate {
  private active = 0;
  private nextStart = 0;
  private blockedUntil = 0;
  private queue: Waiter[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private readonly route: Route) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (this.closed || signal.aborted) return Promise.reject(new Error("codesocks: request cancelled"));
    if (this.queue.length >= 256) return Promise.reject(new Error("codesocks: queue full"));
    return new Promise((resolve, reject) => {
      const remove = (error: Error) => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1); waiter.detach(); reject(error); this.pump();
      };
      const abort = () => remove(new Error("codesocks: request cancelled"));
      const deadline = setTimeout(() => remove(new Error("codesocks: queue wait exceeded")), this.route.maxQueueWaitMs);
      const waiter: Waiter = { resolve, reject, detach: () => {
        clearTimeout(deadline); signal.removeEventListener("abort", abort);
      } };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(waiter); this.pump();
    });
  }

  cooldown(value?: string): void {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + retryAfterMs(value));
    this.pump();
  }

  private pump(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.closed || !this.queue.length || this.active >= this.route.maxConcurrent) return;
    const delay = Math.max(this.nextStart, this.blockedUntil) - Date.now();
    if (delay > 0) { this.timer = setTimeout(() => this.pump(), Math.min(delay, 2147483647)); return; }
    const waiter = this.queue.shift()!; waiter.detach(); this.active++;
    this.nextStart = Date.now() + this.route.minIntervalMs;
    let released = false;
    waiter.resolve(() => { if (released) return; released = true; this.active--; this.pump(); });
    this.pump();
  }

  close(): void {
    this.closed = true; clearTimeout(this.timer);
    for (const waiter of this.queue.splice(0)) {
      waiter.detach(); waiter.reject(new Error("codesocks: request cancelled"));
    }
  }
}
