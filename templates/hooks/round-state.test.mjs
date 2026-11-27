import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectMode, detectSwitches } from "./round-state.mjs";

const HOOK = new URL("./round-state.mjs", import.meta.url).pathname;

function runHook(subcmd, payload, env = {}) {
  return execFileSync("node", [HOOK, subcmd], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDECODE: "1", ...env },
  });
}

test("detectMode & detectSwitches honor explicit commands and ignore negation/questions", () => {
  assert.equal(detectMode("切换到均衡模式"), "balanced");
  assert.equal(detectMode("省 Claude 模式"), "saver");
  assert.equal(detectMode("切回默认模式"), "default");
  assert.equal(detectMode("不要切到均衡模式"), null);
  assert.equal(detectMode("均衡模式下怎么派工？"), null);

  assert.deepEqual(detectSwitches("可以用 gpt fast，也可以用 gemini"), {
    gptFast: true,
    geminiAllowed: true,
  });
  assert.deepEqual(detectSwitches("grok 不用 fast，不用 astra"), {
    grokFast: false,
    astraAllowed: false,
    astraExplicit: true,
  });
  assert.deepEqual(detectSwitches("如果模式下用 gemini 怎么办？"), {});
});

test("prompt persists mode + requests and session-start re-injects after compact", () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-round-"));
  try {
    const env = { CLAUDE_PROJECT_DIR: dir, BEANSTACK_STATE_DIR: join(dir, ".claude/state") };
    const promptOut = JSON.parse(
      runHook(
        "prompt",
        { session_id: "s1", prompt: "切到均衡模式，可以用 gemini，帮我把导出失败提示加上" },
        env,
      ),
    );
    assert.match(promptOut.hookSpecificOutput.additionalContext, /模式：均衡（用户指定）/);
    assert.match(promptOut.hookSpecificOutput.additionalContext, /Gemini：可用/);
    assert.match(promptOut.hookSpecificOutput.additionalContext, /中文/);

    const compactOut = JSON.parse(
      runHook("session-start", { session_id: "s1", source: "compact" }, env),
    );
    assert.match(compactOut.hookSpecificOutput.additionalContext, /推进契约/);
    assert.match(compactOut.hookSpecificOutput.additionalContext, /模式：均衡/);

    const reqOut = JSON.parse(
      runHook("session-requests", { session_id: "s1", source: "compact" }, env),
    );
    assert.match(reqOut.hookSpecificOutput.additionalContext, /帮我把导出失败提示加上/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-edit reminds on UI edit and 3+ coordinator product edits", () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-edit-"));
  try {
    const env = { CLAUDE_PROJECT_DIR: dir, BEANSTACK_STATE_DIR: join(dir, ".claude/state") };
    const uiOut = JSON.parse(
      runHook("post-edit", { tool_input: { file_path: join(dir, "src/App.tsx") } }, env),
    );
    assert.match(uiOut.hookSpecificOutput.additionalContext, /Claude Design/);
    assert.match(uiOut.hookSpecificOutput.additionalContext, /bs-verify/);

    runHook("post-edit", { tool_input: { file_path: join(dir, "src/a.ts") } }, env);
    const thirdOut = JSON.parse(
      runHook("post-edit", { tool_input: { file_path: join(dir, "src/b.ts") } }, env),
    );
    assert.match(thirdOut.hookSpecificOutput.additionalContext, /协调器已连续直接修改多个产品文件/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-agent / post-agent write ledger and subagent-stop blocks unclosed playwright-cli once", () => {
  const dir = mkdtempSync(join(tmpdir(), "bs-sub-"));
  try {
    const stateDir = join(dir, ".claude/state");
    const env = { CLAUDE_PROJECT_DIR: dir, BEANSTACK_STATE_DIR: stateDir };
    runHook(
      "pre-agent",
      {
        session_id: "s1",
        tool_use_id: "tu1",
        tool_input: { subagent_type: "bs-verify", model: "sonnet", effort: "high", run_in_background: true },
      },
      env,
    );
    runHook(
      "post-agent",
      {
        session_id: "s1",
        tool_use_id: "tu1",
        tool_input: { subagent_type: "bs-verify", run_in_background: true },
        tool_response: { agentId: "ag1", isAsync: true },
      },
      env,
    );

    const transcript = join(dir, "sub.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "playwright-cli open http://localhost:3000" } }] },
      }) + "\n",
    );

    const block1 = JSON.parse(
      runHook("subagent-stop", { agent_id: "ag1", agent_type: "bs-verify", agent_transcript_path: transcript }, env),
    );
    assert.equal(block1.decision, "block");
    assert.match(block1.reason, /playwright-cli/);

    // Second stop allows exit and records end in ledger.
    const second = runHook(
      "subagent-stop",
      { agent_id: "ag1", agent_type: "bs-verify", agent_transcript_path: transcript },
      env,
    );
    assert.equal(second.trim(), "");
    const ledger = readFileSync(join(stateDir, "dispatch-ledger.jsonl"), "utf8");
    assert.match(ledger, /"event":"start"/);
    assert.match(ledger, /"event":"link"/);
    assert.match(ledger, /"event":"end"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
