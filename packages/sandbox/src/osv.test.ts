import { describe, expect, it, vi } from "vitest";
import { npmLockPackages, queryOsv } from "./osv";

describe("trusted OSV evidence transport", () => {
  it("deduplicates exact npm coordinates and excludes URLs, malformed versions and custom sources", () => {
    const parsed = npmLockPackages(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "private-project" },
          "node_modules/@scope/a": { version: "1.2.3" },
          "node_modules/parent/node_modules/@scope/a": { version: "1.2.3" },
          "node_modules/url": { version: "https://secret@evil.invalid/x" },
          "node_modules/alias": { name: "real-package", version: "2.0.0" },
          "node_modules/custom": {
            version: "1.0.0",
            resolved: "https://secret@evil.invalid/pkg.tgz",
          },
          "node_modules/link": { link: true },
        },
      }),
    );
    expect(parsed).toEqual({
      packages: [
        { name: "@scope/a", version: "1.2.3" },
        { name: "real-package", version: "2.0.0" },
      ],
      incomplete: true,
    });
    expect(() => npmLockPackages('{"lockfileVersion":1}')).toThrow("OSV_UNSUPPORTED_LOCKFILE");
  });
  it("caps coordinate count and marks partial coverage", () => {
    const packages = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [
        `node_modules/package-${index}`,
        { version: "1.0.0" },
      ]),
    );
    const result = npmLockPackages(JSON.stringify({ lockfileVersion: 2, packages }));
    expect(result.packages).toHaveLength(500);
    expect(result.incomplete).toBe(true);
  });
  it("posts only coordinates to the fixed host with no credential and no redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        results: [{ vulns: [{ id: "GHSA-abc-def-ghi" }], next_page_token: "more" }],
      }),
    );
    const result = await queryOsv([{ name: "lodash", version: "4.17.15" }], fetcher);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.osv.dev/v1/querybatch");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(init!.headers).get("authorization")).toBeNull();
    expect(JSON.parse(init!.body as string)).toEqual({
      queries: [{ package: { name: "lodash", ecosystem: "npm" }, version: "4.17.15" }],
    });
    expect(result).toEqual({
      matches: [{ name: "lodash", version: "4.17.15", advisoryIds: ["GHSA-abc-def-ghi"] }],
      incomplete: true,
    });
  });
  it.each([302, 307])("rejects HTTP %i without following the redirect", async (status) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status, headers: { location: "https://other.example/query" } }),
    );
    await expect(queryOsv([{ name: "x", version: "1.0.0" }], fetcher)).rejects.toThrow(
      "OSV_UNAVAILABLE",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe("manual");
  });

  it("rejects malformed and oversized responses while canceling the stream", async () => {
    const packages = [{ name: "x", version: "1.0.0" }];
    await expect(queryOsv(packages, async () => Response.json({ results: [] }))).rejects.toThrow(
      "OSV_INVALID_RESPONSE",
    );
    await expect(
      queryOsv(packages, async () => Response.json({ results: [{ vulns: [{ id: "<script>" }] }] })),
    ).rejects.toThrow("OSV_INVALID_RESPONSE");
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(300000));
      },
      cancel,
    });
    await expect(queryOsv(packages, async () => new Response(body))).rejects.toThrow(
      "OSV_RESPONSE_LIMIT",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
