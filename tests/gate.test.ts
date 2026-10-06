import { expect, test } from "bun:test";
import { Gate, retryAfterMs } from "../src/gate.js";
import type { Route } from "../src/types.js";
const route: Route = { proxy: "a", allowedOrigins: ["https://example.com"], maxConcurrent: 1, minIntervalMs: 0, timeoutMs: 1000, maxQueueWaitMs: 40 };
test("Retry-After seconds, dates and invalid values have safe delays", () => {
  expect(retryAfterMs("1.5", 0)).toBe(1500);
  expect(retryAfterMs("Thu, 01 Jan 1970 00:00:03 GMT", 1000)).toBe(2000);
  expect(retryAfterMs("Thu, 01 Jan 1970 00:00:00 GMT", 1000)).toBe(0);
  expect(retryAfterMs("broken", 0)).toBe(1000);
});
test("gate holds concurrency through streaming until explicitly released", async () => {
  const gate = new Gate(route); const signal = new AbortController().signal;
  try {
    const release = await gate.acquire(signal);
    let entered = false; const pending = gate.acquire(signal).then((next) => { entered = true; return next; });
    await Bun.sleep(10); expect(entered).toBe(false); release();
    const next = await pending; expect(entered).toBe(true); next();
  } finally { gate.close(); }
});
test("cancelled queued request never acquires a slot", async () => {
  const gate = new Gate(route); const first = await gate.acquire(new AbortController().signal);
  const controller = new AbortController(); const pending = gate.acquire(controller.signal);
  controller.abort(); await expect(pending).rejects.toThrow(); first(); gate.close();
});
test("cooldown never silently shortens a provider Retry-After", async () => {
  const gate = new Gate(route); gate.cooldown("60");
  await expect(gate.acquire(new AbortController().signal)).rejects.toThrow("queue"); gate.close();
});
