/** A fixed supervisor, never a model-provided script. It bounds output before SDK buffering. */
export const SUPERVISOR = String.raw`
import json, os, selectors, signal, subprocess, sys, time, resource, ctypes
spec = json.loads(os.environ.pop("SHERPA_COMMAND_SPEC"))
limit = min(int(spec.get("maxBytes", 32768)), 524288)
timeout = min(float(spec.get("timeoutMs", 20000)) / 1000, 180)
env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp/sherpa-home", "CI": "true", "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1", "GIT_LITERAL_PATHSPECS": "1", "COREPACK_ENABLE_PROJECT_SPEC": "0", "COREPACK_ENABLE_NETWORK": "0", "npm_config_ignore_scripts": "true", "npm_config_ignore_pnpmfile": "true", "npm_config_audit": "false", "npm_config_fund": "false", "npm_config_userconfig": "/dev/null", "YARN_IGNORE_PATH": "1"}
for key in ("SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO"):
    if key in os.environ: env[key] = os.environ[key]
def child_setup():
    resource.setrlimit(resource.RLIMIT_FSIZE, (268435456, 268435456))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    if spec.get("evidence"):
        resource.setrlimit(resource.RLIMIT_FSIZE, (16777216, 16777216))
        memory = 1073741824 if spec["evidence"] == "reproduction" else 2147483648
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        cpu = max(1, int(timeout) + 1)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    if spec.get("untrusted"):
        # Prevent setuid binaries from restoring privilege after the UID drop.
        if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:
            raise RuntimeError("NO_NEW_PRIVILEGES_UNAVAILABLE")
        processes = 32 if spec.get("evidence") else 128
        resource.setrlimit(resource.RLIMIT_NPROC, (processes, processes))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.setgroups([])
        os.setgid(65534)
        os.setuid(65534)
process = subprocess.Popen(spec["argv"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=spec.get("cwd", "/"), env=env, start_new_session=True, preexec_fn=child_setup)
selector = selectors.DefaultSelector()
selector.register(process.stdout, selectors.EVENT_READ, "stdout")
selector.register(process.stderr, selectors.EVENT_READ, "stderr")
output = bytearray()
errors = bytearray()
truncated = False
timed_out = False
started = time.monotonic()
try:
    while selector.get_map():
        if time.monotonic() - started > timeout:
            timed_out = True
            break
        for key, _ in selector.select(0.05):
            chunk = os.read(key.fd, 8192)
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            remaining = limit - len(output) - len(errors)
            target = output if key.data == "stdout" else errors
            target.extend(chunk[:remaining])
            if len(chunk) > remaining:
                truncated = True
                break
        if truncated: break
    if not truncated and not timed_out:
        try: process.wait(timeout=max(0.01, timeout - (time.monotonic() - started)))
        except subprocess.TimeoutExpired: timed_out = True
finally:
    # Kill descendants even if the direct child exits or its output pipe is closed.
    try: os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    process.wait(timeout=5)
    selector.close()
print(json.dumps({"output": output.decode("utf-8", errors="replace"), "stderr": errors.decode("utf-8", errors="replace"), "exitCode": process.returncode, "truncated": truncated, "timedOut": timed_out}))
`;

export type CommandSpec = {
  argv: string[];
  cwd?: string;
  maxBytes: number;
  timeoutMs: number;
  untrusted?: boolean;
  evidence?: "reproduction" | "scanner";
};
export type CommandResult = {
  output: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
};
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export const SUPERVISOR_COMMAND = `python3 -I -c ${shellQuote(SUPERVISOR)}`;
