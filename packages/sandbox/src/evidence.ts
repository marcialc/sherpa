/** Fixed service code: model source is data until Bubblewrap has established isolation. */
export const EVIDENCE_RUNNER = String.raw`
import json, os, pathlib, re, shutil, subprocess, sys, tempfile
payload = json.loads(sys.argv[1])
git_dir = "/workspace/sherpa/git"
mount = "/workspace/sherpa/evidence"
def git_output(args, limit):
    child = subprocess.Popen(["git", "--git-dir=" + git_dir, "-c", "core.hooksPath=/dev/null"] + args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        value = child.stdout.read(limit + 1)
        if len(value) > limit:
            raise RuntimeError("SNAPSHOT_SIZE_LIMIT")
        if child.wait(timeout=3) != 0:
            raise RuntimeError("SNAPSHOT_READ_FAILED")
        return value
    finally:
        if child.poll() is None: child.kill()
        child.wait()
def main():
    if not re.fullmatch(r"[a-f0-9]{40}", payload["head"]):
        raise RuntimeError("INVALID_SNAPSHOT")
    if payload["mode"] not in ("scanner", "reproduction"):
        raise RuntimeError("INVALID_EVIDENCE_MODE")
    entries = git_output(["ls-tree", "-r", "-l", "-z", payload["head"]], 262144).split(b"\0")
    selected = set(payload.get("paths", [])) if payload["mode"] == "scanner" else None
    with tempfile.TemporaryDirectory(prefix="sherpa-evidence-") as scratch:
        snapshot = pathlib.Path(scratch) / "source"
        snapshot.mkdir()
        total = 0
        count = 0
        omitted = 0
        for row in entries:
            if not row: continue
            meta, path_bytes = row.split(b"\t", 1)
            mode, kind, sha, size_bytes = meta.split()
            path = path_bytes.decode("utf-8", errors="strict")
            if selected is not None and path not in selected: continue
            if mode not in (b"100644", b"100755") or kind != b"blob":
                omitted += 1
                continue
            if path.startswith("/") or any(part in ("", ".", "..", ".git") for part in path.split("/")):
                raise RuntimeError("INVALID_SNAPSHOT_PATH")
            size = int(size_bytes)
            count += 1
            total += size
            if size > 262144 or total > 16777216 or count > 1000:
                raise RuntimeError("SNAPSHOT_SIZE_LIMIT")
            target = snapshot / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git_output(["cat-file", "blob", sha.decode("ascii")], size))
            target.chmod(0o555 if mode == b"100755" else 0o444)
        if payload["mode"] == "scanner":
            # Snapshot contains only selected JS/TS/Python files: no HEAD ignore/rule config.
            if not count: raise RuntimeError("NO_REGULAR_SCAN_FILES")
            argv = ["/opt/sherpa/semgrep/bin/semgrep", "scan", "--oss-only", "--config=/opt/sherpa/semgrep-rules.yml", "--json", "--quiet", "--metrics=off", "--disable-version-check", "--disable-nosem", "--no-git-ignore", "--no-rewrite-rule-ids", "--jobs=1", "--timeout=2", "--timeout-threshold=1", "--max-memory=512", "--max-target-bytes=262144", "."]
        else:
            language = payload["language"]
            if language not in ("javascript", "python"):
                raise RuntimeError("INVALID_REPRODUCTION_LANGUAGE")
            suffix = ".cjs" if language == "javascript" else ".py"
            fd, filename = tempfile.mkstemp(prefix=".sherpa-reproduction-", suffix=suffix, dir=snapshot)
            with os.fdopen(fd, "w") as handle: handle.write(payload["source"])
            script = mount + "/" + pathlib.Path(filename).name
            if language == "javascript":
                argv = ["node", "--jitless", "--max-old-space-size=128", script]
            else:
                argv = ["python3", "-I", "-c", "import runpy,sys; sys.path.insert(0,sys.argv[1]); runpy.run_path(sys.argv[2],run_name='__main__')", mount, script]
            print(json.dumps({"hypothesis": payload["hypothesis"], "snapshot": payload["head"], "omittedNonRegularFiles": omitted}), flush=True)
        # /tmp is bounded and disposable; the complete snapshot and host root remain read-only.
        # No fallback if any namespace/mount/resource primitive is unavailable.
        isolation = ["bwrap", "--unshare-user", "--disable-userns", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--size", "1048576", "--tmpfs", "/workspace/sherpa", "--ro-bind", str(snapshot), mount, "--remount-ro", "/workspace/sherpa", "--size", "67108864", "--tmpfs", "/tmp", "--dir", "/tmp/sherpa-home", "--proc", "/proc", "--dev", "/dev", "--chdir", mount, "--"]
        return subprocess.call(isolation + argv)
try:
    sys.exit(main())
except (OSError, ValueError, RuntimeError) as error:
    print(str(error) if re.fullmatch(r"[A-Z_]+", str(error)) else "EVIDENCE_SETUP_FAILED", file=sys.stderr)
    sys.exit(70)
`;
