import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const parent = process.env.OPENCODE_TEST_TMP ?? join(tmpdir(), "opencode");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "codesocks-smoke-"));
let upstreamHits = 0, proxyHits = 0;
const upstream = createServer(async (req, res) => {
  for await (const _chunk of req) {};
  upstreamHits++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "chatcmpl-codesocks", object: "chat.completion.chunk", created: 0, model: "mock" };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "CODESOCKS_SMOKE_OK" }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
const proxy = createServer((req, res) => {
  proxyHits++;
  const hop = request(req.url, { method: req.method, headers: req.headers }, (reply) => {
    res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
  });
  hop.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(hop);
});
const listen = (server) => new Promise((done) => server.listen(0, "127.0.0.1", done));
const close = (server) => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); });
try {
  await listen(upstream); await listen(proxy);
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const proxyURL = `http://127.0.0.1:${proxy.address().port}`;
  await writeFile(join(directory, "opencode.jsonc"), JSON.stringify({
    model: "codesocks-smoke/mock",
    plugins: [{ package: pathToFileURL(root).href }],
    providers: { "codesocks-smoke": {
      name: "CodeSocks isolated mock", env: ["CODESOCKS_SMOKE_KEY"],
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `${origin}/v1` },
      models: { mock: { name: "Mock", limit: { context: 32000, output: 1000 } } },
    } },
  }));
  await writeFile(join(directory, "codesocks.jsonc"), JSON.stringify({
    proxies: { smoke: proxyURL },
    providers: { "codesocks-smoke": { proxy: "smoke", allowedOrigins: [origin] } },
  }));
  const env = { ...process.env, HOME: directory, USERPROFILE: directory,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"),
    CODESOCKS_SMOKE_KEY: "local-test-only", NO_PROXY: "*" };
  for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "CODESOCKS_CONFIG", "PWD", "INIT_CWD"]) delete env[key];
  const binary = process.env.OPENCODE_TEST_BINARY ?? "opencode";
  const child = spawn(binary, ["run", "--standalone", "--print-logs", "--log-level", "debug", "--model", "codesocks-smoke/mock", "--format", "json", "Return the test marker"], { cwd: directory, env });
  child.stdin.end(); // The CLI reads piped stdin before sending even when a message is supplied.
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const timer = setTimeout(() => child.kill(), Number(process.env.OPENCODE_TEST_TIMEOUT ?? 120000));
  const code = await new Promise((done, reject) => { child.on("error", reject); child.on("close", done); });
  clearTimeout(timer);
  if (code !== 0 || !output.includes("CODESOCKS_SMOKE_OK") || proxyHits === 0 || upstreamHits !== proxyHits) {
    throw new Error(`Smoke failed: exit=${code} proxy=${proxyHits} upstream=${upstreamHits}\n${output}\n${errors}`);
  }
  console.log(JSON.stringify({ result: "PASS", binary, proxyHits, upstreamHits, marker: "CODESOCKS_SMOKE_OK" }));
} finally {
  await close(proxy); await close(upstream);
  await rm(directory, { recursive: true, force: true });
}
