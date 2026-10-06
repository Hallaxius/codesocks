import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "codesocks-"));
}

const validProxy = "socks5h://127.0.0.1:1080";
function validText(proxy = validProxy): string {
  return JSON.stringify({
    proxies: { local: proxy },
    providers: {
      openai: { proxy: "local", allowedOrigins: ["https://api.openai.com"] },
    },
  });
}

// parseConfig: defaults
describe("parseConfig", () => {
  test("applies enabled true and numeric defaults", async () => {
    const { parseConfig } = await import("../src/config.js");
    const cfg = parseConfig(validText());
    expect(cfg.enabled).toBe(true);
    expect(cfg.proxies).toEqual({ local: validProxy });
    const route = cfg.providers["openai"]!;
    expect(route).toEqual({
      proxy: "local",
      allowedOrigins: ["https://api.openai.com"],
      maxConcurrent: 2,
      minIntervalMs: 0,
      timeoutMs: 120_000,
      maxQueueWaitMs: 120_000,
    });
  });

  test("allows comments and trailing commas", async () => {
    const { parseConfig } = await import("../src/config.js");
    const text = `{
      // minimal config comment
      "proxies": { "local": "${validProxy}", },
      "providers": { "p": { "proxy": "local", "allowedOrigins": ["https://a.example"], }, },
    }`;
    expect(parseConfig(text).enabled).toBe(true);
  });

  test("rejects malformed JSON fail-closed without echoing text", async () => {
    const { parseConfig } = await import("../src/config.js");
    const bad = `{"proxies": { "local": "SECRET-XYZ-123", `;
    let msg = "";
    try {
      parseConfig(bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("SECRET-XYZ-123");
  });

  test("rejects unknown fields", async () => {
    const { parseConfig } = await import("../src/config.js");
    expect(() =>
      parseConfig(JSON.stringify({ proxies: {}, providers: {}, extra: 1 })),
    ).toThrow();
    expect(() =>
      parseConfig(
        JSON.stringify({
          proxies: { local: validProxy },
          providers: {
            p: {
              proxy: "local",
              allowedOrigins: ["https://a.example"],
              bogus: 1,
            },
          },
        }),
      ),
    ).toThrow();
  });

  test("validates proxy scheme and rejects path/query/hash and PAC", async () => {
    const { parseConfig } = await import("../src/config.js");
    for (const bad of [
      "ftp://127.0.0.1:1080",
      "file:///proxy.pac",
      "http://127.0.0.1:8080/some/path",
      "http://127.0.0.1:8080/?q=1",
      "http://127.0.0.1:8080/#frag",
      "https://proxy.example/proxy.pac",
    ]) {
      expect(() => parseConfig(validText(bad)), bad).toThrow();
    }
    for (const good of [
      "http://127.0.0.1:8080",
      "https://user:pass@127.0.0.1:8080",
      "socks5h://127.0.0.1:1080",
      "socks5://127.0.0.1:1080/",
    ]) {
      expect(parseConfig(validText(good)).proxies["local"]).toBe(good);
    }
  });

  test("substitutes {env:NAME} only in proxy URLs, missing env fails", async () => {
    const { parseConfig } = await import("../src/config.js");
    const cfg = parseConfig(
      JSON.stringify({
        proxies: { local: "socks5h://{env:U}:{env:P}@127.0.0.1:1080" },
        providers: {
          p: { proxy: "local", allowedOrigins: ["https://a.example"] },
        },
      }),
      { U: "u1", P: "p1" },
    );
    expect(cfg.proxies["local"]).toBe("socks5h://u1:p1@127.0.0.1:1080");
    expect(() =>
      parseConfig(
        JSON.stringify({
          proxies: { local: "socks5h://{env:MISSING}@127.0.0.1:1080" },
          providers: {
            p: { proxy: "local", allowedOrigins: ["https://a.example"] },
          },
        }),
        {},
      ),
    ).toThrow();
    // no interpolation of the full text: the provider name is not expanded
    const literal = parseConfig(
      JSON.stringify({
        proxies: { local: validProxy },
        providers: {
          "{env:U}": { proxy: "local", allowedOrigins: ["https://a.example"] },
        },
      }),
      { U: "x" },
    );
    expect(Object.keys(literal.providers)).toEqual(["{env:U}"]);
  });

  test("never leaks proxy URL in errors", async () => {
    const { parseConfig } = await import("../src/config.js");
    const secretUrl = "http://super:SECRET-ABC-999@127.0.0.1:8080/evil-path";
    let msg = "";
    try {
      parseConfig(validText(secretUrl));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("SECRET-ABC-999");
    expect(msg).not.toContain(secretUrl);
  });

  test("validates allowedOrigins nonempty exact http(s) origins", async () => {
    const { parseConfig } = await import("../src/config.js");
    const mk = (origins: string[]) =>
      JSON.stringify({
        proxies: { local: validProxy },
        providers: { p: { proxy: "local", allowedOrigins: origins } },
      });
    expect(() => parseConfig(mk([]))).toThrow();
    for (const bad of [
      "https://a.example/path",
      "https://a.example/?q=1",
      "ftp://a.example",
      "not-a-url",
      "https://a.example:bad",
    ]) {
      expect(() => parseConfig(mk([bad])), bad).toThrow();
    }
    expect(
      parseConfig(mk(["https://a.example", "http://127.0.0.1:3000"])).providers[
        "p"
      ]!.allowedOrigins,
    ).toEqual(["https://a.example", "http://127.0.0.1:3000"]);
  });

  test("validates integer ranges and unknown proxy reference", async () => {
    const { parseConfig } = await import("../src/config.js");
    const mkProvider = (over: Record<string, unknown>) =>
      JSON.stringify({
        proxies: { local: validProxy },
        providers: {
          p: { proxy: "local", allowedOrigins: ["https://a.example"], ...over },
        },
      });
    expect(() => parseConfig(mkProvider({ maxConcurrent: 0 }))).toThrow();
    expect(() => parseConfig(mkProvider({ maxConcurrent: 65 }))).toThrow();
    expect(() => parseConfig(mkProvider({ minIntervalMs: -1 }))).toThrow();
    expect(() => parseConfig(mkProvider({ timeoutMs: 0 }))).toThrow();
    expect(() =>
      parseConfig(
        JSON.stringify({
          proxies: { local: validProxy },
          providers: {
            p: { proxy: "ghost", allowedOrigins: ["https://a.example"] },
          },
        }),
      ),
    ).toThrow();
  });
});

// loadConfig: discovery
describe("loadConfig discovery", () => {
  test("explicit configPath must exist", async () => {
    const { loadConfig } = await import("../src/config.js");
    const dir = tmp();
    await expect(
      loadConfig({ directory: dir, configPath: "missing.jsonc", env: {} }),
    ).rejects.toThrow();
  });

  test("missing auto config returns disabled empty maps", async () => {
    const { loadConfig } = await import("../src/config.js");
    const dir = tmp();
    const loaded = await loadConfig({
      directory: dir,
      env: {},
      home: tmp(),
    });
    expect(loaded.path).toBeUndefined();
    expect(loaded.config).toEqual({ enabled: false, proxies: {}, providers: {} });
  });

  test("malformed selected file fails closed", async () => {
    const { loadConfig } = await import("../src/config.js");
    const dir = tmp();
    writeFileSync(join(dir, "codesocks.jsonc"), "{ not json");
    writeFileSync(join(dir, "opencode.json"), "{}");
    await expect(loadConfig({ directory: dir, env: {}, home: tmp() })).rejects.toThrow();
  });

  test("discovers sibling next to opencode.json and prefers closest", async () => {
    const { loadConfig } = await import("../src/config.js");
    const root = tmp();
    const sub = join(root, "sub");
    mkdirSync(sub);
    writeFileSync(join(root, "opencode.json"), "{}");
    writeFileSync(join(root, "codesocks.jsonc"), validText());
    writeFileSync(join(sub, "opencode.json"), "{}");
    const innerProxy = "http://127.0.0.1:8081";
    writeFileSync(join(sub, "codesocks.jsonc"), validText(innerProxy));
    const loaded = await loadConfig({ directory: sub, env: {}, home: tmp() });
    expect(loaded.path).toBe(join(sub, "codesocks.jsonc"));
    expect(loaded.config.proxies["local"]).toBe(innerProxy);
  });

  test("discovers sibling inside .opencode directory", async () => {
    const { loadConfig } = await import("../src/config.js");
    const root = tmp();
    mkdirSync(join(root, ".opencode"));
    writeFileSync(join(root, ".opencode", "opencode.json"), "{}");
    writeFileSync(join(root, ".opencode", "codesocks.jsonc"), validText());
    const loaded = await loadConfig({ directory: root, env: {}, home: tmp() });
    expect(loaded.path).toBe(join(root, ".opencode", "codesocks.jsonc"));
  });

  test("CODESOCKS_CONFIG env and global dir are honored with precedence", async () => {
    const { loadConfig } = await import("../src/config.js");
    const dir = tmp();
    const explicit = join(tmp(), "explicit.jsonc");
    writeFileSync(explicit, validText("http://127.0.0.1:8082"));
    const viaEnv = await loadConfig({
      directory: dir,
      env: { CODESOCKS_CONFIG: explicit },
      home: tmp(),
    });
    expect(viaEnv.path).toBe(explicit);

    const home = tmp();
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".config", "opencode", "codesocks.jsonc"),
      validText("http://127.0.0.1:8083"),
    );
    const viaGlobal = await loadConfig({ directory: dir, env: {}, home });
    expect(viaGlobal.path).toBe(
      join(home, ".config", "opencode", "codesocks.jsonc"),
    );
  });
});
