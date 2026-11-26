import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// 子进程上限：挂住时 SIGKILL，不拖住整个 guards 作业（test-timeout-floor-guard）。
const BOUND = { timeout: 120_000, killSignal: "SIGKILL" };

const script = fileURLToPath(new URL("./dispatch.sh", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "dispatch-test-"));
const prompt = join(dir, "task.md");
writeFileSync(prompt, "do the thing");

function run(args, env = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    ...BOUND,
    env: { ...process.env, DISPATCH_OUT_DIR: dir, DISPATCH_DRY_RUN: "1", ...env }
  });
}

test("missing --model is rejected with exit 2", () => {
  const r = run(["grok", "t1", prompt]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--model is required/);
});

test("unknown channel is rejected", () => {
  const r = run(["gemini", "t1", prompt, "--model", "x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown channel/);
});

test("missing DISPATCH_OUT_DIR is rejected", () => {
  const r = run(["grok", "t1", prompt, "--model", "x"], { DISPATCH_OUT_DIR: "" });
  assert.equal(r.status, 2);
});

test("unsafe task names are rejected", () => {
  const r = run(["grok", "../evil", prompt, "--model", "x"]);
  assert.equal(r.status, 2);
});

test("each channel passes the explicit model and no hardcoded default", () => {
  for (const channel of ["codex", "codex-review", "grok", "devin", "cursor", "agy"]) {
    const r = run([channel, `t-${channel}`, prompt, "--model", "roster-model-id", "--effort", "high"]);
    assert.equal(r.status, 0, `${channel}: ${r.stderr}`);
    assert.match(r.stdout, /roster-model-id/, channel);
    assert.doesNotMatch(r.stdout, /gpt-6-astra|grok-4\.6|swe-2|gemini-3|cursor-grok/, channel);
  }
});

test("grok passes effort only when given; devin defaults to dangerous mode (headless accept-edits silently rejects edits)", () => {
  const grok = run(["grok", "g", prompt, "--model", "m"]);
  assert.doesNotMatch(grok.stdout, /--reasoning-effort/);
  const devin = run(["devin", "d", prompt, "--model", "m"]);
  assert.match(devin.stdout, /^dangerous$/m);
  const devinAE = run(["devin", "d2", prompt, "--model", "m", "--mode", "accept-edits"]);
  assert.match(devinAE.stdout, /^accept-edits$/m);
});

test("--model cli-default omits every model flag so the CLI picks its own latest default", () => {
  for (const channel of ["codex", "codex-review", "grok", "devin", "cursor", "agy"]) {
    const r = run([channel, `c-${channel}`, prompt, "--model", "cli-default"]);
    assert.equal(r.status, 0, `${channel}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /cli-default/, channel);
    assert.doesNotMatch(r.stdout, /^(-m|--model)$/m, channel);
    assert.doesNotMatch(r.stdout, /review_model/, channel);
  }
});

test("codex and codex-review add --dangerously-bypass-hook-trust only when BEANSTACK_CODEX_TRUST_HOOKS=1; a bash-guard file in the repo never enables it", () => {
  // codex exec 默认要求逐条信任钩子；这个参数等于替人确认信任，只能由调用方显式开启，不能靠仓库里有没有某个文件判断
  // （任何仓库放一个同名空文件就能冒充受信）。自建临时仓库，不依赖宿主仓库：技能导出到别的项目后这条也要能跑。
  const repoRoot = mkdtempSync(join(tmpdir(), "dispatch-hook-repo-"));
  assert.equal(spawnSync("git", ["init", "-q", repoRoot], BOUND).status, 0);
  mkdirSync(join(repoRoot, ".claude/hooks"), { recursive: true });
  writeFileSync(join(repoRoot, ".claude/hooks/bash-guard.mjs"), "");
  for (const ch of ["codex", "codex-review"]) {
    // 默认不加；反例：仓库里有 bash-guard 文件、没设变量，仍不加。
    for (const wd of [dir, repoRoot]) {
      const off = run([ch, `h0-${ch}`, prompt, "--model", "m", "--workdir", wd], { BEANSTACK_CODEX_TRUST_HOOKS: "" });
      assert.equal(off.status, 0, off.stderr);
      assert.doesNotMatch(off.stdout, /bypass-hook-trust/, `${ch}: 没设变量不开免信任（workdir=${wd}）`);
    }
    // 变量不是 1 也不加。
    const no = run([ch, `h1-${ch}`, prompt, "--model", "m", "--workdir", repoRoot], { BEANSTACK_CODEX_TRUST_HOOKS: "0" });
    assert.doesNotMatch(no.stdout, /bypass-hook-trust/, ch);
    // 设了变量才加，且是 exec 级参数：出现在 codex-review 的 review 子命令之前。
    const r = run([ch, `h-${ch}`, prompt, "--model", "m", "--workdir", dir], { BEANSTACK_CODEX_TRUST_HOOKS: "1" });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split("\n");
    assert.ok(lines.includes("--dangerously-bypass-hook-trust"), ch);
    if (ch === "codex-review") assert.ok(lines.indexOf("--dangerously-bypass-hook-trust") < lines.indexOf("review"), "flag before review subcommand");
  }
  for (const ch of ["grok", "devin", "cursor", "agy"]) {
    const r = run([ch, `h-${ch}`, prompt, "--model", "m", "--workdir", repoRoot], { BEANSTACK_CODEX_TRUST_HOOKS: "1" });
    assert.doesNotMatch(r.stdout, /bypass-hook-trust/, ch);
  }
});

test("codex-review compares against origin/main by default and BEANSTACK_BASE_REF overrides the base", () => {
  const def = run(["codex-review", "b1", prompt, "--model", "m"], { BEANSTACK_BASE_REF: "" });
  assert.equal(def.status, 0, def.stderr);
  const dl = def.stdout.split("\n");
  assert.equal(dl[dl.indexOf("--base") + 1], "origin/main");
  const custom = run(["codex-review", "b2", prompt, "--model", "m"], { BEANSTACK_BASE_REF: "origin/master" });
  const cl = custom.stdout.split("\n");
  assert.equal(cl[cl.indexOf("--base") + 1], "origin/master");
  assert.ok(cl.indexOf("review") < cl.indexOf("--base"));
});

test("agy keeps the -p= form", () => {
  const r = run(["agy", "a", prompt, "--model", "m"]);
  assert.match(r.stdout, /^-p=do the thing$/m);
});

test("agy print timeout follows --timeout instead of a fixed 30m", () => {
  // 写死 30m 时，--timeout 7200 的 Carbon 前端任务在第 30 分钟被 agy 自己截断（只交半截）。
  const r = run(["agy", "a", prompt, "--model", "m", "--timeout", "7200"]);
  assert.match(r.stdout, /^--print-timeout$/m);
  assert.match(r.stdout, /^7140s$/m);
  assert.doesNotMatch(r.stdout, /^30m$/m);
});

test("agy --conversation resumes a previous conversation", () => {
  const r = run(["agy", "a", prompt, "--model", "m", "--conversation", "d926db8f"]);
  assert.match(r.stdout, /^--conversation$/m);
  assert.match(r.stdout, /^d926db8f$/m);
});

// ---------- v4：推理档默认、后台脱管、额度识别、派工账本 ----------
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";

const channelsScript = fileURLToPath(new URL("./channels.sh", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假 CLI：按 FAKE_MODE 决定行为；codex 的事件流走 stdout，grok 的结果走 stdout。
function makeBin() {
  const bin = mkdtempSync(join(tmpdir(), "dispatch-bin-"));
  const body = `#!/bin/bash
case "\${FAKE_MODE:-ok}" in
  ok) echo '{"type":"done"}'; exit 0 ;;
  stubborn) trap '' ALRM; sleep "\${FAKE_SLEEP:-8}"; exit 0 ;;
  slow) sleep "\${FAKE_SLEEP:-3}"; exit 0 ;;
  fail) echo "boom: something else broke" >&2; exit 1 ;;
  quota-stderr) echo "\${FAKE_MSG}" >&2; exit 1 ;;
  quota-events) echo "{\\"type\\":\\"error\\",\\"message\\":\\"\${FAKE_MSG}\\"}"; exit 1 ;;
  events-file) cat "\${FAKE_EVENTS}"; exit "\${FAKE_EXIT:-1}" ;;
  envdump) echo "claudecode=\${CLAUDECODE-unset}"; exit 0 ;;
esac
`;
  for (const n of ["codex", "grok"]) {
    writeFileSync(join(bin, n), body);
    chmodSync(join(bin, n), 0o755);
    // macOS 首次执行新写出的可执行文件要排队等 syspolicyd 检查，负载下可达数秒；
    // 在计时之外先执行一次，后续 waitDone 的上限只量启动器本身。
    spawnSync(join(bin, n), [], { env: { ...process.env, FAKE_MODE: "ok" }, stdio: "ignore", ...BOUND });
  }
  return bin;
}
const bin = makeBin();

function runReal(args, env = {}, opts = {}) {
  const out = mkdtempSync(join(tmpdir(), "dispatch-out-"));
  const ledger = env.BEANSTACK_LEDGER ?? join(out, "ledger.jsonl");
  const r = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    ...BOUND,
    cwd: opts.cwd ?? out,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DISPATCH_OUT_DIR: out,
      DISPATCH_DRY_RUN: "",
      BEANSTACK_LEDGER: ledger,
      ...env
    }
  });
  return { r, out, ledger };
}

// 只是失败时的上限：.done 一出现就返回。守卫并行跑、负载高时真实启动 bash 子进程会拖过 8 秒。
async function waitDone(out, name, ms = 30_000) {
  const f = join(out, `${name}.done`);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // 文件存在但内容还是空时不算完成：只认 exit= 开头的非空内容（启动器自己是原子写，这里再防一道）。
    if (existsSync(f)) {
      const text = readFileSync(f, "utf8").trim();
      if (text.startsWith("exit=")) return text;
    }
    await sleep(50);
  }
  throw new Error(`.done not written for ${name}`);
}
const readLedger = (f) =>
  readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("no --effort: codex and codex-review carry no reasoning-effort override; with --effort they do", () => {
  for (const ch of ["codex", "codex-review"]) {
    const none = run([ch, "e1", prompt, "--model", "m"]);
    assert.equal(none.status, 0, none.stderr);
    assert.doesNotMatch(none.stdout, /model_reasoning_effort/, ch);
    const high = run([ch, "e2", prompt, "--model", "m", "--effort", "high"]);
    assert.match(high.stdout, /^model_reasoning_effort="high"$/m, ch);
  }
});

test("launcher returns immediately even when the caller pipes its output", () => {
  const out = mkdtempSync(join(tmpdir(), "dispatch-out-"));
  // 用 /bin/bash（脚本 shebang 指定的系统解释器）而不是 PATH 里的 bash：开发机 PATH 的 bash 常是 Homebrew 的非系统二进制，
  // 全机负载下它每次启动要排队数秒（实测 p50 约 200ms、最长近 3s，/bin/bash 恒为 2-3ms），
  // 这段启动时间会算进下面 2.5s 的判据里，与启动器是否脱管无关。判据本身不变。
  const t0 = Date.now();
  const r = spawnSync(
    "/bin/bash",
    ["-c", `/bin/bash "${script}" grok slowpipe "${prompt}" --model m | tail -n 2`],
    {
      encoding: "utf8",
      ...BOUND,
      cwd: out,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DISPATCH_OUT_DIR: out, DISPATCH_DRY_RUN: "", FAKE_MODE: "slow", FAKE_SLEEP: "20", BEANSTACK_LEDGER: join(out, "l.jsonl") }
    }
  );
  assert.ok(Date.now() - t0 < 10_000, `blocked ${Date.now() - t0}ms`);
  assert.match(r.stdout, /\[dispatch\]/);
});

const quotaCases = [
  ["codex", "quota-stderr", "You've hit your usage limit. Try again later."],
  ["codex", "quota-events", "usage_limit_reached"],
  ["grok", "quota-stderr", "Error: Rate limit exceeded, please retry later"],
  ["grok", "quota-stderr", "You have exceeded your quota for this billing period"]
];
for (const [ch, mode, msg] of quotaCases) {
  test(`${ch} ${mode} "${msg.slice(0, 30)}" -> .done carries reason=quota`, async () => {
    const { r, out } = runReal([ch, "q", prompt, "--model", "m"], { FAKE_MODE: mode, FAKE_MSG: msg });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await waitDone(out, "q"), "exit=1 reason=quota");
  });
}

test("ordinary failure keeps plain exit=N; success is exit=0", async () => {
  const bad = runReal(["codex", "f", prompt, "--model", "m"], { FAKE_MODE: "fail" });
  assert.equal(await waitDone(bad.out, "f"), "exit=1");
  const ok = runReal(["grok", "s", prompt, "--model", "m"], { FAKE_MODE: "ok" });
  assert.equal(await waitDone(ok.out, "s"), "exit=0");
});

test("ledger: start and end rows with fixed fields", async () => {
  const { out, ledger } = runReal(["codex", "L1", prompt, "--model", "mx", "--effort", "high"], { FAKE_MODE: "quota-stderr", FAKE_MSG: "usage_limit_reached" });
  await waitDone(out, "L1");
  await sleep(200);
  const rows = readLedger(ledger);
  assert.equal(rows.length, 2);
  const [s, e] = rows;
  assert.deepEqual(Object.keys(s).sort(), ["channel", "effort", "event", "exit", "fast", "model", "reason", "source", "task", "ts"]);
  assert.equal(s.source, "dispatch");
  assert.equal(s.event, "start");
  assert.equal(s.channel, "codex");
  assert.equal(s.task, "L1");
  assert.equal(s.model, "mx");
  assert.equal(s.effort, "high");
  assert.equal(s.exit, null);
  assert.equal(s.reason, null);
  assert.match(s.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal(e.event, "end");
  assert.equal(e.exit, 1);
  assert.equal(e.reason, "quota");
});

test("ledger: effort is null when not given; normal end has reason null", async () => {
  const { out, ledger } = runReal(["grok", "L2", prompt, "--model", "m"], { FAKE_MODE: "ok" });
  await waitDone(out, "L2");
  await sleep(200);
  const [s, e] = readLedger(ledger);
  assert.equal(s.effort, null);
  assert.equal(e.exit, 0);
  assert.equal(e.reason, null);
});

test("ledger: no BEANSTACK_LEDGER and no repo -> <out dir>/dispatch-ledger.jsonl", async () => {
  const plain = mkdtempSync(join(tmpdir(), "dispatch-norepo-"));
  const b = runReal(["grok", "L4", prompt, "--model", "m"], { FAKE_MODE: "ok", BEANSTACK_LEDGER: "" }, { cwd: plain });
  await waitDone(b.out, "L4");
  await sleep(200);
  assert.ok(existsSync(join(b.out, "dispatch-ledger.jsonl")));
});

test("dry run writes no ledger", () => {
  const out = mkdtempSync(join(tmpdir(), "dispatch-out-"));
  const l = join(out, "l.jsonl");
  run(["grok", "dry", prompt, "--model", "m"], { BEANSTACK_LEDGER: l, DISPATCH_OUT_DIR: out });
  assert.equal(existsSync(l), false);
});

test("channels.sh --ledger summarises both sources, counts quota and bad lines", () => {
  const f = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.jsonl");
  const rows = [
    { ts: "2026-10-01T00:00:00Z", source: "dispatch", event: "start", channel: "codex", task: "a", model: "m1", effort: "high", exit: null, reason: null },
    { ts: "2026-10-01T00:01:00Z", source: "dispatch", event: "end", channel: "codex", task: "a", model: "m1", effort: "high", exit: 1, reason: "quota" },
    { ts: "2026-10-01T00:02:00Z", source: "dispatch", event: "start", channel: "codex", task: "b", model: "m1", effort: "high", exit: null, reason: null },
    { ts: "2026-10-01T00:03:00Z", source: "dispatch", event: "end", channel: "codex", task: "b", model: "m1", effort: "high", exit: 0, reason: null },
    { ts: "2026-10-01T00:04:00Z", source: "claude-agent", event: "start", role: "bb-review", model: "opus", effort: "high", description: "x" },
    { ts: "2026-10-01T00:05:00Z", source: "claude-agent", event: "start", role: "bb-explore", model: "haiku", effort: null, description: "y" }
  ];
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n{not json\n");
  const r = spawnSync("bash", [channelsScript, "--ledger", f], { encoding: "utf8", ...BOUND });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dispatch\s+codex\s+m1\s+high\s+2\b/);
  assert.match(r.stdout, /claude-agent\s+bb-review\s+opus\s+high\s+1\b/);
  assert.match(r.stdout, /claude-agent\s+bb-explore\s+haiku\s+-\s+1\b/);
  assert.match(r.stdout, /额度耗尽\D*1\b/);
  assert.match(r.stdout, /跳过\D*1\b/);
});

// ---------- R2：--ledger 默认只统计本轮、外部 CLI 不继承 CLAUDECODE ----------

test("R2-9 channels.sh --ledger 默认从 round.json 的 roundStart 起统计，--all 统计全部", () => {
  const d = mkdtempSync(join(tmpdir(), "ledger-round-"));
  const f = join(d, "dispatch-ledger.jsonl");
  const rows = [
    { ts: "2026-09-01T00:00:00Z", source: "dispatch", event: "start", channel: "codex", task: "old", model: "m-old", effort: "high", exit: null, reason: null },
    { ts: "2026-09-01T00:01:00Z", source: "dispatch", event: "end", channel: "codex", task: "old", model: "m-old", effort: "high", exit: 1, reason: "quota" },
    { ts: "2026-10-01T00:05:00Z", source: "dispatch", event: "start", channel: "grok", task: "new", model: "m-new", effort: null, exit: null, reason: null },
    { ts: "2026-10-01T00:06:00.500Z", source: "claude-agent", event: "start", role: "bb-exec", model: "sonnet", effort: "medium", description: "x" }
  ];
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(d, "round.json"), JSON.stringify({ roundStart: "2026-10-01T00:00:00.000Z" }));

  const cur = spawnSync("bash", [channelsScript, "--ledger", f], { encoding: "utf8", ...BOUND });
  assert.equal(cur.status, 0, cur.stderr);
  assert.match(cur.stdout, /m-new/);
  assert.match(cur.stdout, /bb-exec/);
  assert.doesNotMatch(cur.stdout, /m-old/);
  assert.match(cur.stdout, /额度耗尽\D*0\b/);
  assert.match(cur.stdout, /本轮/);

  for (const args of [["--ledger", "--all", f], ["--ledger", f, "--all"]]) {
    const all = spawnSync("bash", [channelsScript, ...args], { encoding: "utf8", ...BOUND });
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /m-old/, args.join(" "));
    assert.match(all.stdout, /m-new/, args.join(" "));
    assert.match(all.stdout, /额度耗尽\D*1\b/, args.join(" "));
    assert.match(all.stdout, /全部/, args.join(" "));
  }
});

test("R2-9 没有 round.json（或没有 roundStart）时 --ledger 统计全部", () => {
  const d = mkdtempSync(join(tmpdir(), "ledger-noround-"));
  const f = join(d, "dispatch-ledger.jsonl");
  writeFileSync(f, JSON.stringify({ ts: "2020-01-01T00:00:00Z", source: "dispatch", event: "start", channel: "codex", task: "a", model: "m-ancient", effort: null, exit: null, reason: null }) + "\n");
  assert.match(spawnSync("bash", [channelsScript, "--ledger", f], { encoding: "utf8", ...BOUND }).stdout, /m-ancient/);
  writeFileSync(join(d, "round.json"), "{not json");
  assert.match(spawnSync("bash", [channelsScript, "--ledger", f], { encoding: "utf8", ...BOUND }).stdout, /m-ancient/);
});

test("R2-10 外部 CLI 一律用 env -u CLAUDECODE 启动（dry-run 输出可验证）", () => {
  for (const channel of ["codex", "codex-review", "grok", "devin", "cursor", "agy"]) {
    const r = run([channel, `u-${channel}`, prompt, "--model", "m"]);
    assert.equal(r.status, 0, `${channel}: ${r.stderr}`);
    const lines = r.stdout.split("\n");
    assert.deepEqual(lines.slice(0, 3), ["env", "-u", "CLAUDECODE"], channel);
    assert.ok(["codex", "grok", "devin", "agent", "agy"].includes(lines[3]), `${channel}: ${lines[3]}`);
  }
});

test("R2-10 真实启动：子进程看不到父进程的 CLAUDECODE", async () => {
  const { out } = runReal(["grok", "envdump", prompt, "--model", "m"], { FAKE_MODE: "envdump", CLAUDECODE: "1" });
  assert.equal(await waitDone(out, "envdump"), "exit=0");
  assert.equal(readFileSync(join(out, "envdump.result.md"), "utf8").trim(), "claudecode=unset");
});

// ---------- 可见性：启动行带档位、--wait 阻塞等待并回传退出码 ----------
test("start line carries effort=<e>, or effort=cli-default when not given", () => {
  const withE = runReal(["grok", "v1", prompt, "--model", "mm", "--effort", "high"], { FAKE_MODE: "ok" });
  assert.match(withE.r.stdout, /^\[dispatch\] grok v1 model=mm effort=high pid=/m);
  const without = runReal(["grok", "v2", prompt, "--model", "mm"], { FAKE_MODE: "ok" });
  assert.match(without.r.stdout, /^\[dispatch\] grok v2 model=mm effort=cli-default pid=/m);
});

test("--wait success: prints summary line and exits 0", () => {
  const { r, out } = runReal(["grok", "w1", prompt, "--model", "mm", "--effort", "low", "--wait"], { FAKE_MODE: "ok" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^\\[dispatch\\] grok w1 model=mm effort=low 完成：exit=0 结果：${out}/w1\\.result\\.md$`, "m"));
});

test("--wait failure: exit code equals the CLI's exit code", () => {
  const { r } = runReal(["codex", "w2", prompt, "--model", "mm", "--wait"], { FAKE_MODE: "fail" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /完成：exit=1 /);
});

test("--wait quota: summary carries reason=quota, exit stays the CLI's exit", () => {
  const { r } = runReal(["grok", "w3", prompt, "--model", "mm", "--wait"], { FAKE_MODE: "quota-stderr", FAKE_MSG: "Rate limit exceeded" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /完成：exit=1 reason=quota /);
  assert.match(r.stdout, /^reason=quota$/m);
});

test("--wait times out with exit 124 and an explanation", () => {
  const t0 = Date.now();
  const { r } = runReal(["grok", "w4", prompt, "--model", "mm", "--timeout", "1", "--wait"], { FAKE_MODE: "stubborn", FAKE_SLEEP: "8", DISPATCH_WAIT_GRACE: "1" });
  assert.equal(r.status, 124);
  assert.match(r.stderr, /超时/);
  assert.ok(Date.now() - t0 < 20000);
});

test("--wait with dry run does not block", () => {
  const r = run(["grok", "w5", prompt, "--model", "m", "--wait"]);
  assert.equal(r.status, 0, r.stderr);
});

// .done 非原子写的回归：写入端是 printf > .done 时，--wait 可能在文件刚创建、还没写入内容时就读到空串，
// 退出码解析失败按 1，reason=quota 丢失（高负载下实测红过）。
test("--wait ignores an empty .done that appears before the content is written (no lost exit code / reason)", async () => {
  const out = mkdtempSync(join(tmpdir(), "dispatch-out-"));
  const child = spawn("bash", [script, "grok", "w7", prompt, "--model", "mm", "--delay", "2", "--wait"], {
    cwd: out,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DISPATCH_OUT_DIR: out, DISPATCH_DRY_RUN: "", FAKE_MODE: "quota-stderr", FAKE_MSG: "Rate limit exceeded", BEANSTACK_LEDGER: join(out, "l.jsonl") },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
    killSignal: "SIGKILL"
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const closed = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  // 启动器写完 .pid 就说明它已经 rm 过旧 .done、后台任务还在 --delay 里；此时放一个空 .done，模拟写入端「文件已创建、内容未落盘」的瞬间。
  const pidFile = join(out, "w7.pid");
  const end = Date.now() + 30_000;
  while (!existsSync(pidFile) && Date.now() < end) await sleep(20);
  assert.ok(existsSync(pidFile), "launcher did not write .pid");
  writeFileSync(join(out, "w7.done"), "");
  const code = await closed;
  assert.equal(code, 1);
  assert.match(stdout, /完成：exit=1 reason=quota /);
  assert.match(stdout, /^reason=quota$/m);
});

test("dispatch.sh writes .done only through the atomic write_done helper (tmp file + mv), never by direct redirect", () => {
  const src = readFileSync(script, "utf8");
  assert.doesNotMatch(src, />\s*"\$out\/\$name\.done"/, "direct redirect into .done");
  assert.match(src, /mv -f "\$tmp" "\$out\/\$name\.done"/);
});

test("finished tasks leave no .done.tmp.* files behind", async () => {
  const { out } = runReal(["grok", "w8", prompt, "--model", "mm", "--wait"], { FAKE_MODE: "ok" });
  assert.equal(await waitDone(out, "w8"), "exit=0");
  assert.deepEqual(readdirSync(out).filter((f) => f.includes(".done.tmp.")), []);
});

// ---------- reason 分类：只看错误事件与 stderr，新增 capacity ----------
const evLine = (o) => JSON.stringify(o);
const cmdOut = (text) => evLine({ type: "item.completed", item: { type: "command_execution", aggregated_output: text } });
const capacityTail = [
  evLine({ type: "error", message: "Selected model is at capacity. Please try a different model." }),
  evLine({ type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } })
];
function eventsFixture(lines) {
  const f = join(mkdtempSync(join(tmpdir(), "dispatch-ev-")), "events.jsonl");
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

test("codex-review: quota-looking text in command output + final at-capacity error -> reason=capacity", async () => {
  const f = eventsFixture([
    cmdOut("# 样例: You've hit your usage limit\n# usage_limit_reached\n# 429 quota rate limit"),
    evLine({ type: "item.completed", item: { type: "agent_message", text: "usage_limit_reached is the sample" } }),
    ...capacityTail
  ]);
  const { out, ledger } = runReal(["codex-review", "c1", prompt, "--model", "m"], { FAKE_MODE: "events-file", FAKE_EVENTS: f });
  assert.equal(await waitDone(out, "c1"), "exit=1 reason=capacity");
  await sleep(200);
  assert.equal(readLedger(ledger).at(-1).reason, "capacity");
});

test("codex: real quota text in an error event -> reason=quota (quota wins over capacity)", async () => {
  const f = eventsFixture([
    evLine({ type: "error", message: "You've hit your usage limit. Try again later." }),
    evLine({ type: "turn.failed", error: { message: "You've hit your usage limit; server overloaded" } })
  ]);
  const { out } = runReal(["codex", "c2", prompt, "--model", "m"], { FAKE_MODE: "events-file", FAKE_EVENTS: f });
  assert.equal(await waitDone(out, "c2"), "exit=1 reason=quota");
});

test("codex: command output with 429/quota words but successful exit -> no reason", async () => {
  const f = eventsFixture([cmdOut("HTTP 429 quota usage_limit_reached at capacity"), evLine({ type: "turn.completed" })]);
  const { out } = runReal(["codex", "c3", prompt, "--model", "m"], { FAKE_MODE: "events-file", FAKE_EVENTS: f, FAKE_EXIT: "0" });
  assert.equal(await waitDone(out, "c3"), "exit=0");
});

test("codex: failure whose only quota text sits in command output -> plain exit=1", async () => {
  const f = eventsFixture([cmdOut("usage_limit_reached"), evLine({ type: "error", message: "boom" })]);
  const { out } = runReal(["codex", "c4", prompt, "--model", "m"], { FAKE_MODE: "events-file", FAKE_EVENTS: f });
  assert.equal(await waitDone(out, "c4"), "exit=1");
});

test("codex: unparsable events file falls back to stderr only", async () => {
  const f = join(mkdtempSync(join(tmpdir(), "dispatch-ev-")), "events.jsonl");
  writeFileSync(f, "not json usage_limit_reached\n{broken\n");
  const { out } = runReal(["codex", "c5", prompt, "--model", "m"], { FAKE_MODE: "events-file", FAKE_EVENTS: f });
  assert.equal(await waitDone(out, "c5"), "exit=1");
});

test("grok: stderr 503 / overloaded -> reason=capacity; stdout body is never scanned", async () => {
  const a = runReal(["grok", "g1", prompt, "--model", "m"], { FAKE_MODE: "quota-stderr", FAKE_MSG: "HTTP 503 Service Unavailable" });
  assert.equal(await waitDone(a.out, "g1"), "exit=1 reason=capacity");
  const b = runReal(["grok", "g2", prompt, "--model", "m"], { FAKE_MODE: "quota-stderr", FAKE_MSG: "model overloaded, retry" });
  assert.equal(await waitDone(b.out, "g2"), "exit=1 reason=capacity");
  const f = eventsFixture(["quota rate limit 429 usage limit"]);
  const c = runReal(["grok", "g3", prompt, "--model", "m"], { FAKE_MODE: "events-file", FAKE_EVENTS: f });
  assert.equal(await waitDone(c.out, "g3"), "exit=1");
});

test("grok: ordinary stderr logs with quota-ish words or port 15030 do not trigger a reason", async () => {
  const { out } = runReal(["grok", "g4", prompt, "--model", "m"], { FAKE_MODE: "quota-stderr", FAKE_MSG: "loading quota config from :15030, rate limiter ready" });
  assert.equal(await waitDone(out, "g4"), "exit=1");
});

test("--wait capacity: summary carries reason=capacity", () => {
  const { r } = runReal(["grok", "w6", prompt, "--model", "mm", "--wait"], { FAKE_MODE: "quota-stderr", FAKE_MSG: "503 server is busy" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /完成：exit=1 reason=capacity /);
  assert.match(r.stdout, /^reason=capacity$/m);
});

// ---------- fast：codex 走服务档，其它通道由模型 ID 决定 ----------

test("--fast: codex and codex-review add service_tier=priority; absent otherwise", () => {
  for (const ch of ["codex", "codex-review"]) {
    const on = run([ch, "f1", prompt, "--model", "m", "--effort", "high", "--fast"]);
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /^service_tier="priority"$/m, ch);
    const off = run([ch, "f2", prompt, "--model", "m"]);
    assert.doesNotMatch(off.stdout, /service_tier/, ch);
  }
});

test("--fast on other channels exits 2 and points to the model ID", () => {
  for (const ch of ["grok", "devin", "cursor", "agy"]) {
    const r = run([ch, "f3", prompt, "--model", "m", "--fast"]);
    assert.equal(r.status, 2, ch);
    assert.match(r.stderr, /--fast/, ch);
    assert.match(r.stderr, /模型 ID/, ch);
  }
});

test("fast shows in the start line and --wait summary only when on; ledger carries fast", async () => {
  const on = runReal(["codex", "F1", prompt, "--model", "m", "--effort", "high", "--fast", "--wait"], { FAKE_MODE: "ok" });
  assert.equal(on.r.status, 0, on.r.stderr);
  const lines = on.r.stdout.split("\n").filter((l) => l.startsWith("[dispatch]"));
  assert.equal(lines.length, 2);
  for (const l of lines) assert.match(l, /effort=high fast=on/);
  await sleep(200);
  assert.deepEqual(readLedger(on.ledger).map((r) => r.fast), [true, true]);

  const off = runReal(["codex", "F2", prompt, "--model", "m", "--effort", "high", "--wait"], { FAKE_MODE: "ok" });
  assert.doesNotMatch(off.r.stdout, /fast=/);
  await sleep(200);
  assert.deepEqual(readLedger(off.ledger).map((r) => r.fast), [false, false]);
});

// ---------- R3：--ledger 的本轮起点校验与 --since ----------

function ledgerFixture(roundJson) {
  const d = mkdtempSync(join(tmpdir(), "ledger-since-"));
  const f = join(d, "dispatch-ledger.jsonl");
  const rows = [
    { ts: "2026-09-01T00:00:00Z", source: "dispatch", event: "start", channel: "codex", task: "a", model: "m-old", effort: null },
    { ts: "2026-10-01T00:05:00Z", source: "dispatch", event: "start", channel: "grok", task: "b", model: "m-mid", effort: null },
    { ts: "2026-10-02T09:00:00Z", source: "dispatch", event: "start", channel: "grok", task: "c", model: "m-new", effort: null }
  ];
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (roundJson !== undefined) writeFileSync(join(d, "round.json"), roundJson);
  return { d, f };
}
const ledger = (args, env = {}) => spawnSync("bash", [channelsScript, "--ledger", ...args], { encoding: "utf8", env: { ...process.env, ...env }, ...BOUND });

test("R3-1 round.json 的 roundStart 是 1970 年（无效起点）时不当作本轮：写明已忽略，统计全部", () => {
  const { f } = ledgerFixture(JSON.stringify({ roundStart: "1970-01-01T00:00:00.000Z" }));
  const r = ledger([f]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /1970/);
  assert.match(r.stdout, /统计范围：全部/);
  assert.match(r.stdout, /忽略/);
  assert.match(r.stdout, /m-old/);
});

test("R3-2 --since 接 ISO 时间，覆盖 round.json，只统计该时间之后", () => {
  const { f } = ledgerFixture(JSON.stringify({ roundStart: "2026-09-01T00:00:00.000Z" }));
  const r = ledger([f, "--since", "2026-10-01T12:00:00Z"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /统计范围：自 2026-10-01T12:00:00.000Z（--since）/);
  assert.match(r.stdout, /m-new/);
  assert.doesNotMatch(r.stdout, /m-mid|m-old/);
  // 参数顺序无关，也支持 --since=值
  const r2 = ledger(["--since=2026-10-01T12:00:00Z", f]);
  assert.match(r2.stdout, /m-new/);
  assert.doesNotMatch(r2.stdout, /m-mid/);
});

test("R3-3 --since today 取本地当天零点", () => {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const d = mkdtempSync(join(tmpdir(), "ledger-today-"));
  const f = join(d, "dispatch-ledger.jsonl");
  const rows = [
    { ts: new Date(Date.parse(midnight) - 3600_000).toISOString(), source: "dispatch", event: "start", channel: "codex", task: "a", model: "m-yesterday", effort: null },
    { ts: new Date(Date.parse(midnight) + 60_000).toISOString(), source: "dispatch", event: "start", channel: "codex", task: "b", model: "m-today", effort: null }
  ];
  writeFileSync(f, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const r = ledger([f, "--since", "today"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /m-today/);
  assert.doesNotMatch(r.stdout, /m-yesterday/);
  assert.match(r.stdout, /（--since）/);
});

test("R3-4 --since 值无效或缺失、与 --all 同用：退出 2 并说明", () => {
  const { f } = ledgerFixture();
  for (const args of [[f, "--since", "not-a-date"], [f, "--since"], [f, "--since", "--all"], [f, "--all", "--since", "today"]]) {
    const r = ledger(args);
    assert.equal(r.status, 2, `${args.join(" ")} -> ${r.status} ${r.stdout}`);
    assert.match(r.stderr, /--since|--all/);
  }
});

test("R3-5 round.json 在 BEANSTACK_STATE_DIR 而账本在别处时，仍按状态目录的 roundStart 统计", () => {
  const { f } = ledgerFixture();
  const sd = mkdtempSync(join(tmpdir(), "ledger-statedir-"));
  writeFileSync(join(sd, "round.json"), JSON.stringify({ roundStart: "2026-10-02T00:00:00.000Z" }));
  const r = ledger([f], { BEANSTACK_STATE_DIR: sd });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /本轮（自 2026-10-02T00:00:00.000Z）/);
  assert.match(r.stdout, /m-new/);
  assert.doesNotMatch(r.stdout, /m-mid/);
});

// ---------- 状态栏修复轮：--model cli-default 在账本里写解析后的实际模型 ----------

function codexHome(config) {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  if (config !== null) writeFileSync(join(home, "config.toml"), config);
  return home;
}

const CODEX_CONFIG = `model = "gpt-6.1-sol"  # 注释
model_reasoning_effort = "high"
sandbox_mode = "danger-full-access"

[profiles.x]
model = "profile-model"
model_reasoning_effort = "low"
`;

test("cli-default：codex 账本 start/end 的 model 与 effort 取 CODEX_HOME/config.toml 顶层值，另有 model_arg，不读 [段] 里的值", async () => {
  const { out, ledger } = runReal(["codex", "D1", prompt, "--model", "cli-default"], { FAKE_MODE: "ok", CODEX_HOME: codexHome(CODEX_CONFIG) });
  await waitDone(out, "D1");
  await sleep(200);
  const rows = readLedger(ledger);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.model, "gpt-6.1-sol");
    assert.equal(row.effort, "high");
    assert.equal(row.model_arg, "cli-default");
  }
});

test("cli-default：显式传的 --effort 优先；codex-review 同样解析", async () => {
  const { out, ledger } = runReal(["codex-review", "D2", prompt, "--model", "cli-default", "--effort", "xhigh"], { FAKE_MODE: "ok", CODEX_HOME: codexHome(CODEX_CONFIG) });
  await waitDone(out, "D2");
  await sleep(200);
  const [s] = readLedger(ledger);
  assert.equal(s.model, "gpt-6.1-sol");
  assert.equal(s.effort, "xhigh");
  assert.equal(s.model_arg, "cli-default");
});

test("cli-default：config.toml 不存在或没有顶层 model 时写 cli-default；grok 写 grok-cli-default", async () => {
  const a = runReal(["codex", "D3", prompt, "--model", "cli-default"], { FAKE_MODE: "ok", CODEX_HOME: codexHome(null) });
  await waitDone(a.out, "D3");
  const b = runReal(["codex", "D4", prompt, "--model", "cli-default"], { FAKE_MODE: "ok", CODEX_HOME: codexHome('sandbox_mode = "x"\n[a]\nmodel = "inner"\n') });
  await waitDone(b.out, "D4");
  const c = runReal(["grok", "D5", prompt, "--model", "cli-default"], { FAKE_MODE: "ok" });
  await waitDone(c.out, "D5");
  await sleep(200);
  const [sa] = readLedger(a.ledger);
  const [sb] = readLedger(b.ledger);
  const [sc] = readLedger(c.ledger);
  assert.deepEqual([sa.model, sa.effort, sa.model_arg], ["cli-default", null, "cli-default"]);
  assert.deepEqual([sb.model, sb.effort], ["cli-default", null]);
  assert.deepEqual([sc.model, sc.model_arg], ["grok-cli-default", "cli-default"]);
});

test("cli-default：传给 CLI 的参数不变（仍不传模型），显式模型的账本行没有 model_arg", async () => {
  const r = run(["codex", "D6", prompt, "--model", "cli-default"], { CODEX_HOME: codexHome(CODEX_CONFIG) });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /gpt-6\.1-sol|cli-default/);
  assert.doesNotMatch(r.stdout, /^-m$/m);
  const { out, ledger } = runReal(["codex", "D7", prompt, "--model", "mx", "--effort", "high"], { FAKE_MODE: "ok", CODEX_HOME: codexHome(CODEX_CONFIG) });
  await waitDone(out, "D7");
  await sleep(200);
  const [s] = readLedger(ledger);
  assert.equal(s.model, "mx");
  assert.ok(!("model_arg" in s));
});

// ---------- claude-api：用独立的 API 额度起一个无头 claude 子进程 ----------
function keyFile(content = "sk-ant-test-SECRET-123\n") {
  const d = mkdtempSync(join(tmpdir(), "dispatch-key-"));
  const f = join(d, "claude-api.key");
  writeFileSync(f, content);
  chmodSync(f, 0o600);
  return f;
}
// 假 claude：报告收到的鉴权环境，按 --output-format json 的形状输出。
const fakeClaudeBin = (() => {
  const d = mkdtempSync(join(tmpdir(), "dispatch-claude-"));
  writeFileSync(join(d, "claude"), `#!/bin/bash
key="\${ANTHROPIC_API_KEY-unset}"; oauth="\${CLAUDE_CODE_OAUTH_TOKEN-unset}"; cc="\${CLAUDECODE-unset}"
if [[ "\${FAKE_MODE:-ok}" == fail ]]; then echo "API Error: 429 rate_limit_error" >&2; exit 1; fi
if [[ "\${FAKE_MODE:-ok}" == credit ]]; then printf '{"type":"result","is_error":true,"result":"Credit balance is too low to access the Anthropic API.","total_cost_usd":0}\\n'; exit 1; fi
printf '{"type":"result","is_error":false,"result":"key=%s oauth=%s cc=%s","total_cost_usd":0.0123}\\n' "$key" "$oauth" "$cc"
`);
  chmodSync(join(d, "claude"), 0o755);
  spawnSync(join(d, "claude"), [], { stdio: "ignore", ...BOUND });
  return d;
})();

test("claude-api：密钥文件缺失或为空时退出 2，并提示文件位置", () => {
  const missing = run(["claude-api", "A1", prompt, "--model", "haiku"], { BEANSTACK_API_KEY_FILE: "/nonexistent/claude-api.key" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /\/nonexistent\/claude-api\.key/);
  const empty = run(["claude-api", "A1", prompt, "--model", "haiku"], { BEANSTACK_API_KEY_FILE: keyFile("  \n") });
  assert.equal(empty.status, 2);
});

test("claude-api：命令行带模型、权限模式、预算上限，去掉会话与订阅凭据变量，命令里不出现密钥", () => {
  const r = run(["claude-api", "A2", prompt, "--model", "haiku", "--effort", "high"], { BEANSTACK_API_KEY_FILE: keyFile() });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n");
  for (const want of ["claude", "-p", "--model", "haiku", "--effort", "high", "--output-format", "json", "--permission-mode", "bypassPermissions", "--max-budget-usd", "5"]) {
    assert.ok(lines.includes(want), want);
  }
  for (const v of ["CLAUDECODE", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_SESSION_ID"]) {
    assert.ok(r.stdout.includes(`-u\n${v}\n`), v);
  }
  assert.doesNotMatch(r.stdout, /SECRET/);
  const custom = run(["claude-api", "A3", prompt, "--model", "m", "--budget", "12.5", "--mode", "acceptEdits"], { BEANSTACK_API_KEY_FILE: keyFile() });
  assert.match(custom.stdout, /^12\.5$/m);
  assert.match(custom.stdout, /^acceptEdits$/m);
  assert.equal(run(["grok", "A4", prompt, "--model", "m", "--budget", "3"]).status, 2);
  assert.equal(run(["claude-api", "A5", prompt, "--model", "m", "--budget", "abc"], { BEANSTACK_API_KEY_FILE: keyFile() }).status, 2);
});

test("claude-api：子进程只拿到 API 密钥，结果写进 result.md，花费写进 .done 和账本", async () => {
  const { out, ledger } = runReal(["claude-api", "A6", prompt, "--model", "haiku"], {
    BEANSTACK_API_KEY_FILE: keyFile(),
    PATH: `${fakeClaudeBin}:${process.env.PATH}`,
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-should-not-leak",
    CLAUDECODE: "1"
  });
  assert.match(await waitDone(out, "A6"), /^exit=0 cost_usd=0\.0123$/);
  assert.equal(readFileSync(join(out, "A6.result.md"), "utf8").trim(), "key=sk-ant-test-SECRET-123 oauth=unset cc=unset");
  await sleep(200);
  const end = readLedger(ledger).find((r) => r.event === "end");
  assert.equal(end.cost_usd, 0.0123);
  assert.doesNotMatch(readFileSync(ledger, "utf8"), /SECRET/);
});

test("claude-api：429 归为 quota", async () => {
  const { out } = runReal(["claude-api", "A7", prompt, "--model", "haiku"], {
    BEANSTACK_API_KEY_FILE: keyFile(), PATH: `${fakeClaudeBin}:${process.env.PATH}`, FAKE_MODE: "fail"
  });
  assert.match(await waitDone(out, "A7"), /^exit=1 reason=quota$/);
});

test("claude-api：API 余额不足（结果 JSON 里的 is_error 文本）归为 quota", async () => {
  const { out } = runReal(["claude-api", "A8", prompt, "--model", "haiku"], {
    BEANSTACK_API_KEY_FILE: keyFile(), PATH: `${fakeClaudeBin}:${process.env.PATH}`, FAKE_MODE: "credit"
  });
  assert.match(await waitDone(out, "A8"), /^exit=1 reason=quota cost_usd=0$/);
});

// ---- cloud 通道：把整块任务派到 Claude Code 云端会话（claude --cloud），结果经 claude/dispatch-<任务名> 分支取回 ----

test("cloud DRY_RUN：伪终端里执行 claude --cloud，任务书末尾追加分支与结果文件约定，等待命令查 ls-remote", () => {
  for (const flavor of ["bsd", "util-linux"]) {
    const r = run(["cloud", "cl1", prompt, "--model", "cli-default"], { DISPATCH_SCRIPT_FLAVOR: flavor });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^script$/m, flavor);
    assert.match(r.stdout, /claude --cloud|^--cloud$/m, flavor);
    assert.match(r.stdout, /do the thing/, flavor);
    assert.match(r.stdout, /claude\/dispatch-cl1/, flavor);
    assert.match(r.stdout, /\.dispatch\/cl1\.result\.md/, flavor);
    assert.match(r.stdout, /不开 PR/, flavor);
    assert.match(r.stdout, /ls-remote origin refs\/heads\/claude\/dispatch-cl1\*/, flavor);
    assert.match(r.stdout, /(^|\$')dispatch-cl1(\n|\\n)/m, flavor);
    assert.match(r.stdout, /平台分配的/, flavor);
    assert.doesNotMatch(r.stdout, /cli-default/, flavor);
  }
  const bsd = run(["cloud", "cl2", prompt, "--model", "cli-default"], { DISPATCH_SCRIPT_FLAVOR: "bsd" });
  assert.deepEqual(bsd.stdout.split("\n").slice(0, 5), ["env", "-u", "CLAUDECODE", "script", "-q"]);
  const linux = run(["cloud", "cl3", prompt, "--model", "cli-default"], { DISPATCH_SCRIPT_FLAVOR: "util-linux" });
  assert.ok(linux.stdout.split("\n").includes("-c"));
});

test("cloud 不接受 --fast / --budget，退出 2", () => {
  for (const extra of [["--fast"], ["--budget", "3"]]) {
    const r = run(["cloud", "cl4", prompt, "--model", "cli-default", ...extra]);
    assert.equal(r.status, 2, extra.join(" "));
    assert.doesNotMatch(r.stderr, /unknown channel/, extra.join(" "));
  }
});

test("Orca 后端已移除：--via / --agent / --isolate / --keep 与 claude 通道都退出 2", () => {
  for (const extra of [["--via", "orca"], ["--via", "headless"], ["--agent", "bb-core"], ["--isolate"], ["--keep"]]) {
    const r = run(["grok", "t-gone", prompt, "--model", "m", ...extra]);
    assert.equal(r.status, 2, extra.join(" "));
    assert.match(r.stderr, new RegExp(`unknown option: ${extra[0]}`), extra.join(" "));
    assert.equal(r.stdout, "", extra.join(" "));
  }
  const claude = run(["claude", "t-gone", prompt, "--model", "opus"]);
  assert.equal(claude.status, 2);
  assert.match(claude.stderr, /unknown channel: claude/);
  assert.equal(claude.stdout, "");
});

function gitIn(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", ...BOUND });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

test("cloud 派发前要求 HEAD 已在 origin 的某个分支上，否则退出 2 且不调用 claude", () => {
  const repo = mkdtempSync(join(tmpdir(), "dispatch-cloud-norem-"));
  gitIn(repo, "init", "-q");
  gitIn(repo, "commit", "--allow-empty", "-q", "-m", "x");
  const marker = join(repo, "claude-called");
  const cbin = mkdtempSync(join(tmpdir(), "dispatch-cloud-bin-"));
  writeFileSync(join(cbin, "claude"), `#!/bin/bash\ntouch "${marker}"\n`);
  chmodSync(join(cbin, "claude"), 0o755);
  const { r } = runReal(["cloud", "cl5", prompt, "--model", "cli-default", "--workdir", repo], { PATH: `${cbin}:${process.env.PATH}` });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /推送/);
  assert.equal(existsSync(marker), false);
});

const cloudRecord =
  "Script started on 2026-11-18\r\n\u001b[?25l\u001b[2K\u001b[1GDispatching cloud session...\r\n" +
  "\u001b[32m✔\u001b[39m Created\r\n\u001b]8;;https://claude.ai/code/session_01AbCdEf\u0007View: \u001b[4mhttps://claude.ai/code/session_01AbCdEf?foo=bar\u001b[24m\u001b]8;;\u0007\r\n" +
  "Resume with: claude --teleport session_01AbCdEf\r\n\u001b[?25h";

test("cloud 会话链接解析：去掉终端控制序列后取出 https://claude.ai/code/session_…", () => {
  const f = join(dir, "cloud-record.txt");
  writeFileSync(f, cloudRecord);
  const r = spawnSync("bash", [script, "--parse-cloud-session", f], { encoding: "utf8", ...BOUND });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "https://claude.ai/code/session_01AbCdEf?foo=bar");
  const empty = join(dir, "cloud-record-empty.txt");
  writeFileSync(empty, "Error: nope\r\n");
  assert.equal(spawnSync("bash", [script, "--parse-cloud-session", empty], { encoding: "utf8", ...BOUND }).status, 1);
});

// 端到端：假 claude 打印带控制序列的链接；push 模式下它像云端会话那样往 origin 推 claude/dispatch-<名> 分支。
function cloudFixture(fakeBody) {
  const root = mkdtempSync(join(tmpdir(), "dispatch-cloud-e2e-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const cloudClone = join(root, "cloud");
  assert.equal(spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], BOUND).status, 0);
  gitIn(root, "clone", "-q", origin, work);
  gitIn(work, "checkout", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "a");
  gitIn(work, "add", "a.txt");
  gitIn(work, "commit", "-q", "-m", "init");
  gitIn(work, "push", "-q", "origin", "main");
  gitIn(root, "clone", "-q", origin, cloudClone);
  const cbin = join(root, "bin");
  mkdirSync(cbin);
  writeFileSync(join(cbin, "claude"), `#!/bin/bash\n${fakeBody}\n`);
  chmodSync(join(cbin, "claude"), 0o755);
  return { work, cloudClone, cbin };
}
const fakeLink = `printf 'Dispatching\\r\\n\\033[1mView: https://claude.ai/code/session_01Zz?x=1\\033[0m\\r\\nResume with: claude --teleport session_01Zz\\r\\n'`;
const fakePush = (name, body, branch = `claude/dispatch-${name}`) =>
  `cd "$FAKE_CLOUD" && git checkout -q -b ${branch} && mkdir -p .dispatch && ${body} && git add -A && ` +
  `git -c user.name=t -c user.email=t@example.com commit -q -m r && git push -q origin ${branch}`;

test("cloud 端到端：平台给分支加随机后缀也能取回，实际分支名写进 .branch，描述以 dispatch-<任务名> 开头", () => {
  const branch = "claude/dispatch-cl10-cscirz";
  const { work, cloudClone, cbin } = cloudFixture(
    `printf '%s' "$2" > "$FAKE_CLOUD/../desc.txt"\n${fakeLink}\n${fakePush("cl10", `printf '带后缀\\n' > .dispatch/cl10.result.md`, branch)}`
  );
  const { r, out } = runReal(
    ["cloud", "cl10", prompt, "--model", "cli-default", "--workdir", work, "--wait", "--timeout", "20"],
    { PATH: `${cbin}:${process.env.PATH}`, FAKE_CLOUD: cloudClone, DISPATCH_CLOUD_POLL: "1" }
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(out, "cl10.branch"), "utf8"), `${branch}\n`);
  assert.match(r.stdout, /claude\/dispatch-cl10-cscirz/);
  assert.equal(readFileSync(join(out, "cl10.result.md"), "utf8"), "带后缀\n");
  assert.equal(readFileSync(join(out, "cl10.done"), "utf8").trim(), "exit=0");
  assert.match(readFileSync(join(cloudClone, "..", "desc.txt"), "utf8"), /^dispatch-cl10\n/);
});

test("cloud 派发前已存在的同前缀旧分支不被误认；新分支一出现就取新的", () => {
  const { work, cloudClone, cbin } = cloudFixture(fakeLink + "\n" + fakePush("cl11", `printf '新\\n' > .dispatch/cl11.result.md`, "claude/dispatch-cl11-new1"));
  gitIn(cloudClone, "checkout", "-q", "-b", "claude/dispatch-cl11-old");
  mkdirSync(join(cloudClone, ".dispatch"));
  writeFileSync(join(cloudClone, ".dispatch/cl11.result.md"), "旧\n");
  gitIn(cloudClone, "add", "-A");
  gitIn(cloudClone, "commit", "-q", "-m", "old");
  gitIn(cloudClone, "push", "-q", "origin", "claude/dispatch-cl11-old");
  gitIn(cloudClone, "checkout", "-q", "main");
  const { r, out } = runReal(
    ["cloud", "cl11", prompt, "--model", "cli-default", "--workdir", work, "--wait", "--timeout", "20"],
    { PATH: `${cbin}:${process.env.PATH}`, FAKE_CLOUD: cloudClone, DISPATCH_CLOUD_POLL: "1" }
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(out, "cl11.branch"), "utf8"), "claude/dispatch-cl11-new1\n");
  assert.equal(readFileSync(join(out, "cl11.result.md"), "utf8"), "新\n");
});

test("cloud 派发前只有旧的同前缀分支、云端没有推新分支：不把旧分支当结果，等到超时 124", () => {
  const { work, cloudClone, cbin } = cloudFixture(fakeLink);
  gitIn(cloudClone, "push", "-q", "origin", "main:refs/heads/claude/dispatch-cl12-old");
  const { r, out } = runReal(
    ["cloud", "cl12", prompt, "--model", "cli-default", "--workdir", work, "--wait", "--timeout", "2"],
    { PATH: `${cbin}:${process.env.PATH}`, DISPATCH_CLOUD_POLL: "1" }
  );
  assert.equal(r.status, 124, r.stdout + r.stderr);
  assert.equal(existsSync(join(out, "cl12.branch")), false);
});

test("cloud 端到端：解析链接写 .session，--wait 等到分支出现后取回结果，.done exit=0，账本 kind=cloud", () => {
  const { work, cloudClone, cbin } = cloudFixture(`${fakeLink}\n${fakePush("cl6", `printf '云端交付\\n' > .dispatch/cl6.result.md`)}`);
  const { r, out, ledger } = runReal(
    ["cloud", "cl6", prompt, "--model", "cli-default", "--workdir", work, "--wait", "--timeout", "20"],
    { PATH: `${cbin}:${process.env.PATH}`, FAKE_CLOUD: cloudClone, DISPATCH_CLOUD_POLL: "1" }
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /云端会话：https:\/\/claude\.ai\/code\/session_01Zz\?x=1/);
  assert.equal(readFileSync(join(out, "cl6.session"), "utf8"), "https://claude.ai/code/session_01Zz?x=1\n");
  assert.equal(readFileSync(join(out, "cl6.result.md"), "utf8"), "云端交付\n");
  assert.equal(readFileSync(join(out, "cl6.done"), "utf8").trim(), "exit=0");
  const rows = readLedger(ledger);
  assert.deepEqual(rows.map((x) => [x.event, x.channel, x.exit]), [["start", "cloud", null], ["end", "cloud", 0]]);
});

test("cloud --wait：分支出现但没有结果文件 -> exit=1", () => {
  const { work, cloudClone, cbin } = cloudFixture(`${fakeLink}\n${fakePush("cl7", `printf 'x' > .dispatch/other.txt`)}`);
  const { r, out } = runReal(
    ["cloud", "cl7", prompt, "--model", "cli-default", "--workdir", work, "--wait", "--timeout", "20"],
    { PATH: `${cbin}:${process.env.PATH}`, FAKE_CLOUD: cloudClone, DISPATCH_CLOUD_POLL: "1" }
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(readFileSync(join(out, "cl7.done"), "utf8").trim(), "exit=1");
  assert.equal(existsSync(join(out, "cl7.result.md")), false);
});

test("cloud --wait 超时：退出 124，.done 写 reason=timeout，链接仍留在 .session", () => {
  const { work, cbin } = cloudFixture(fakeLink);
  const { r, out } = runReal(
    ["cloud", "cl8", prompt, "--model", "cli-default", "--workdir", work, "--wait", "--timeout", "2"],
    { PATH: `${cbin}:${process.env.PATH}`, DISPATCH_CLOUD_POLL: "1" }
  );
  assert.equal(r.status, 124, r.stdout + r.stderr);
  assert.equal(readFileSync(join(out, "cl8.done"), "utf8").trim(), "exit=124 reason=timeout");
  assert.match(r.stdout, /session_01Zz/);
  assert.match(readFileSync(join(out, "cl8.session"), "utf8"), /session_01Zz/);
});

test("cloud 解析不到会话链接：退出 1，.done 写 exit=1，.stderr 留记录内容", () => {
  const { work, cbin } = cloudFixture(`echo "Error: cloud is unavailable"`);
  const { r, out } = runReal(
    ["cloud", "cl9", prompt, "--model", "cli-default", "--workdir", work],
    { PATH: `${cbin}:${process.env.PATH}` }
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(readFileSync(join(out, "cl9.done"), "utf8").trim(), "exit=1");
  assert.match(readFileSync(join(out, "cl9.stderr"), "utf8"), /cloud is unavailable/);
});
