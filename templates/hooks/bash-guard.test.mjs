import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBashGuard, swallowsTestExitCode } from "./bash-guard.mjs";

const run = (command, extra = {}) =>
  evaluateBashGuard({ ...extra, tool_input: { command, ...(extra.tool_input ?? {}) } });

test("blocks direct gh pr merge and gh api merge", () => {
  assert.ok(run("gh pr merge 42 --squash"));
  assert.ok(run("gh api -X PUT repos/o/r/pulls/42/merge"));
  assert.equal(run("gh pr view 42"), null);
  assert.equal(run("gh api repos/o/r/pulls/42"), null);
});

test("blocks bypassing git hooks and bare force push", () => {
  assert.ok(run("git commit -n -m 'wip'"));
  assert.ok(run("git commit --no-verify -m 'wip'"));
  assert.ok(run("git config core.hooksPath /tmp/empty"));
  assert.ok(run("git push --force origin feat"));
  assert.ok(run("git push -f origin feat"));
  assert.ok(run("git push origin +feat"));
  assert.equal(run("git push --force-with-lease origin feat"), null);
  assert.equal(run("git push -n origin feat"), null);
  assert.equal(run("git commit -m 'mention --no-verify in message'"), null);
});

test("blocks wide pkill/killall but allows narrow pid/path kill", () => {
  assert.ok(run("pkill node"));
  assert.ok(run("pkill -f next"));
  assert.ok(run("killall python3"));
  assert.equal(run("pkill -f /tmp/my-worktree/dev-server.mjs"), null);
  assert.equal(run("kill 12345"), null);
});

test("blocks swallowing test exit codes unless pipefail or PIPESTATUS is used", () => {
  assert.equal(swallowsTestExitCode("vitest run foo.test.ts | tail -n 20"), true);
  assert.equal(swallowsTestExitCode("pnpm test | grep FAIL"), true);
  assert.equal(swallowsTestExitCode("set -o pipefail; vitest run foo.test.ts | tail -n 20"), false);
  assert.equal(swallowsTestExitCode("vitest run foo.test.ts | tail -n 20; echo ${PIPESTATUS[0]}"), false);
  assert.equal(swallowsTestExitCode("vitest run foo.test.ts > /tmp/t.log 2>&1; echo exit=$?"), false);
});

test("ignores commands inside heredoc body", () => {
  const cmd = "cat <<'EOF' > /tmp/note.md\ngh pr merge 1\ngit push --force\nEOF";
  assert.equal(run(cmd), null);
});

test("subagent discipline: blocks spawning agents, full suite tests, sleep loops, and >290s timeout", () => {
  const sub = { agent_id: "sub-123" };
  assert.ok(run("claude -p 'do something'", sub));
  assert.ok(run("codex exec 'fix bug'", sub));
  assert.ok(run("bash skills/beanstack/scripts/dispatch.sh codex t1 p.md --model gpt-6.2-sol", sub));
  assert.ok(run("vitest run", sub));
  assert.ok(run("pnpm test", sub));
  assert.ok(run("pytest", sub));
  assert.ok(run("while true; do sleep 5; done", sub));
  assert.ok(run("echo hi", { ...sub, tool_input: { timeout: 300_000 } }));

  // Targeted tests, short timeouts, and coordinator commands are allowed.
  assert.equal(run("vitest run src/foo.test.ts", sub), null);
  assert.equal(run("pnpm test -- --affected", sub), null);
  assert.equal(run("pytest tests/test_auth.py", sub), null);
  assert.equal(run("claude --version", sub), null);
  assert.equal(run("echo hi", { ...sub, tool_input: { timeout: 120_000 } }), null);
  assert.equal(run("pnpm test"), null);
});
