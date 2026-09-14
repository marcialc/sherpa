import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { EVIDENCE_RUNNER } from "./evidence";
import { SUPERVISOR, type CommandResult } from "./runner";

const image = process.env.SHERPA_TEST_DOCKER_IMAGE;
const bootstrap = String.raw`
import json, os, pathlib, subprocess, sys
spec = json.load(sys.stdin)
repo = pathlib.Path("/tmp/fixture")
repo.mkdir()
(repo / "math.js").write_text("module.exports.twice = n => n + 1;\n")
(repo / "danger.py").write_text("import pickle\ndef parse(data):\n    return pickle.loads(data)\n")
(repo / ".semgrep.yml").write_text("invalid hostile rule config")
(repo / ".semgrepignore").write_text("**\n")
def git(*args):
    return subprocess.check_output(["git"] + list(args), cwd=repo, stderr=subprocess.DEVNULL).decode().strip()
git("init")
git("config", "user.name", "Test")
git("config", "user.email", "test@example.invalid")
git("add", ".")
git("commit", "-m", "fixture")
head = git("rev-parse", "HEAD")
git("clone", "--bare", str(repo), "/workspace/sherpa/git")
if spec["mode"] == "semgrep-direct":
    # Trusted fixed fixture: exercises the real shipped binary/rules without executing repository code.
    result = subprocess.run(["/opt/sherpa/semgrep/bin/semgrep", "scan", "--config=/opt/sherpa/semgrep-rules.yml", "--json", "--quiet", "--metrics=off", "--disable-version-check", "--disable-nosem", "--no-git-ignore", "--no-rewrite-rule-ids", str(repo / "danger.py")], capture_output=True, text=True, timeout=30, cwd="/tmp")
    print(json.dumps({"output": result.stdout, "stderr": result.stderr, "exitCode": result.returncode}))
else:
    payload = {"mode": "reproduction", "head": head, "source": spec["source"], "language": spec.get("language", "python"), "hypothesis": "read-only/no-network regression observation"}
    if spec["mode"] == "scanner": payload = {"mode": "scanner", "head": head, "paths": ["danger.py"]}
    command = {"argv": ["python3", "-I", "-c", spec["evidence"], json.dumps(payload)], "maxBytes": 32768, "timeoutMs": 15000 if spec["mode"] != "scanner" else 60000, "untrusted": True, "evidence": "scanner" if spec["mode"] == "scanner" else "reproduction"}
    result = subprocess.run(["python3", "-I", "-c", spec["supervisor"]], input=json.dumps(command), capture_output=True, text=True, timeout=70)
    if result.returncode != 0: raise RuntimeError(result.stderr)
    print(result.stdout)
`;

function run(mode: string, source = "", language = "python"): CommandResult {
  const args = ["run", "--rm", "--network", "none", "--platform", "linux/amd64"];
  if (process.env.SHERPA_TEST_USERNS === "1") args.push("--security-opt", "seccomp=unconfined");
  args.push("--entrypoint", "python3", "-i", image!, "-I", "-c", bootstrap);
  const result = spawnSync("docker", args, {
    input: JSON.stringify({
      mode,
      source,
      language,
      supervisor: SUPERVISOR,
      evidence: EVIDENCE_RUNNER,
    }),
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 262144,
  });
  if (result.error || result.status !== 0) throw new Error(String(result.error ?? result.stderr));
  const parsed = JSON.parse(result.stdout) as CommandResult;
  return parsed;
}

describe.runIf(Boolean(image))("pinned scanner image acceptance", () => {
  it("runs real Semgrep rules on a vulnerable fixture", () => {
    const result = run("semgrep-direct");
    expect(result.exitCode, result.stderr).toBe(0);
    const matches = JSON.parse(result.output).results as { check_id: string }[];
    expect(matches.some((match) => match.check_id === "sherpa.python.unsafe-deserialization")).toBe(
      true,
    );
  }, 90000);
  it("runs the complete immutable scanner path or explicitly refuses unavailable isolation", () => {
    const result = run("scanner");
    if (result.exitCode !== 0) {
      expect(result.stderr).toMatch(/bwrap:.*(?:namespace|Operation not permitted)/s);
      expect(result.output).not.toContain('"results"');
    } else {
      expect(result.truncated).toBe(false);
      expect(JSON.parse(result.output).results).toHaveLength(1);
    }
  }, 90000);
  it("keeps execution offline, hides Git, protects the snapshot, and provides disposable scratch", () => {
    const source = String.raw`import os, pathlib, socket
p = pathlib.Path("math.js")
assert "n + 1" in p.read_text()
try:
    p.write_text("tampered")
    raise AssertionError("snapshot writable")
except OSError: pass
assert not pathlib.Path("/workspace/sherpa/git").exists()
assert not os.getenv("SHERPA_TEST_SECRET")
pathlib.Path("/tmp/probe").write_text("scratch")
s = socket.socket()
s.settimeout(0.1)
try:
    s.connect(("1.1.1.1", 443))
    raise AssertionError("network available")
except OSError: pass
print("ISOLATION_PROVEN")
`;
    const result = run("reproduction", source);
    if (result.exitCode !== 0) {
      expect(result.stderr).toMatch(/bwrap:.*(?:namespace|Operation not permitted)/s);
      expect(result.output).not.toContain("ISOLATION_PROVEN");
    } else {
      expect(result.output).toContain("ISOLATION_PROVEN");
      expect(result.truncated).toBe(false);
    }
  }, 90000);
  it("executes CommonJS against the immutable module under the memory limit", () => {
    const result = run(
      "reproduction",
      "const actual = require('./math.js').twice(4); console.log(JSON.stringify({actual, expected:8}));",
      "javascript",
    );
    if (result.exitCode !== 0)
      expect(result.stderr).toMatch(/bwrap:.*(?:namespace|Operation not permitted)/s);
    else expect(result.output).toContain('"actual":5,"expected":8');
  }, 90000);
});
