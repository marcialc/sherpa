export type LockedPackage = { name: string; version: string };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const namePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Only exact npm coordinates; no lockfile URLs, registry credentials or source code leave Workers. */
export function npmLockPackages(source: string): {
  packages: LockedPackage[];
  incomplete: boolean;
} {
  const lock: unknown = JSON.parse(source);
  if (!object(lock) || ![2, 3].includes(Number(lock.lockfileVersion)) || !object(lock.packages))
    throw new Error("OSV_UNSUPPORTED_LOCKFILE");
  const packages: LockedPackage[] = [];
  const seen = new Set<string>();
  let incomplete = false;
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!object(entry)) {
      incomplete = true;
      continue;
    }
    if (entry.link === true) continue;
    if (
      entry.resolved !== undefined &&
      (typeof entry.resolved !== "string" ||
        !/^https:\/\/(?:registry\.npmjs\.org|registry\.yarnpkg\.com)\//.test(entry.resolved))
    ) {
      incomplete = true;
      continue;
    }
    const installedName = path.split("node_modules/").at(-1);
    const name = typeof entry.name === "string" ? entry.name : installedName;
    const version = entry.version;
    if (
      !path.includes("node_modules/") ||
      typeof name !== "string" ||
      name.length > 214 ||
      !namePattern.test(name) ||
      typeof version !== "string" ||
      version.length > 100 ||
      !versionPattern.test(version)
    ) {
      incomplete = true;
      continue;
    }
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (packages.length >= 500) {
      incomplete = true;
      continue;
    }
    packages.push({ name, version });
  }
  return { packages, incomplete };
}

export async function queryOsv(
  packages: LockedPackage[],
  fetcher: typeof fetch = fetch,
): Promise<{ matches: unknown[]; incomplete: boolean }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    const response = await fetcher("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      redirect: "error",
      signal: abort.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        queries: packages.map(({ name, version }) => ({
          package: { name, ecosystem: "npm" },
          version,
        })),
      }),
    });
    if (!response.ok || !response.body) throw new Error("OSV_UNAVAILABLE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 262144) throw new Error("OSV_RESPONSE_LIMIT");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(joined));
    if (!object(value) || !Array.isArray(value.results) || value.results.length !== packages.length)
      throw new Error("OSV_INVALID_RESPONSE");
    const matches: unknown[] = [];
    let incomplete = false;
    for (let index = 0; index < packages.length; index++) {
      const result: unknown = value.results[index];
      if (!object(result) || (result.vulns !== undefined && !Array.isArray(result.vulns)))
        throw new Error("OSV_INVALID_RESPONSE");
      incomplete ||= Boolean(result.next_page_token);
      const ids: string[] = [];
      for (const vuln of (result.vulns as unknown[] | undefined) ?? []) {
        if (
          !object(vuln) ||
          typeof vuln.id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(vuln.id)
        )
          throw new Error("OSV_INVALID_RESPONSE");
        if (ids.length >= 100) {
          incomplete = true;
          continue;
        }
        ids.push(vuln.id);
      }
      if (ids.length) matches.push({ ...packages[index], advisoryIds: ids });
    }
    return { matches, incomplete };
  } catch (error) {
    if (abort.signal.aborted) throw new Error("OSV_TIMEOUT", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
