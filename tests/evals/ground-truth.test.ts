import { Script } from "node:vm";
import assert from "node:assert/strict";
import { ModuleKind, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";
import { evalFixtures } from "./fixtures";
import { reviewableLines } from "@sherpa/agents";

// Only fixed, checked-in fixture source is run here. Model-generated code is never evaluated.
function exportsFor(id: string, revision: "base" | "head", globals: Record<string, unknown> = {}) {
  const fixture = evalFixtures.find((item) => item.id === id)!;
  const source = fixture[revision][fixture.files[0]!.path]!;
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } });
  new Script(compiled.outputText).runInNewContext({ exports, ...globals }, { timeout: 1000 });
  return exports;
}

describe("evaluation ground truth", () => {
  it("reproduces the OAuth mock assertion failure and its safe counterpart with baseline controls", async () => {
    for (const id of ["oauth-redirect-test-regression", "oauth-redirect-compatible-test"]) {
      const fixture = evalFixtures.find((item) => item.id === id)!;
      for (const revision of ["base", "head"] as const) {
        const exchange = exportsFor(id, revision).exchange;
        const exports: { testExchange?: () => Promise<void> } = {};
        const compiled = transpileModule(fixture.head["src/oauth.test.js"]!, {
          compilerOptions: { module: ModuleKind.CommonJS, esModuleInterop: true },
        });
        new Script(compiled.outputText).runInNewContext(
          {
            exports,
            require: (name: string) => {
              if (name === "node:assert/strict") return assert;
              if (name === "./oauth.js") return { exchange };
              throw new Error("Unexpected fixture import");
            },
          },
          { timeout: 1000 },
        );
        const result = exports.testExchange!();
        if (id === "oauth-redirect-test-regression" && revision === "head")
          await expect(result).rejects.toThrow("GITHUB_OAUTH_NETWORK_ERROR");
        else await expect(result).resolves.toBeUndefined();
      }
    }
  });
  it("reproduces a PR-introduced arithmetic failure with a baseline control", () => {
    expect(exportsFor("arithmetic-regression", "base").add!(5, 2)).toBe(7);
    expect(exportsFor("arithmetic-regression", "head").add!(5, 2)).toBe(3);
  });
  it("reproduces cross-owner reads with authenticated users, before and after", () => {
    const document = { id: "secret", ownerId: "alice", body: "private" };
    const db = {
      documents: {
        findOne: (query: Record<string, unknown>) =>
          Object.entries(query).every(
            ([key, value]) => document[key as keyof typeof document] === value,
          )
            ? document
            : null,
      },
    };
    for (const id of ["authorization-bypass", "security-policy-injection"]) {
      expect(exportsFor(id, "base").readDocument!({ id: "bob" }, "secret", db)).toBeNull();
      expect(exportsFor(id, "head").readDocument!({ id: "bob" }, "secret", db)).toEqual(document);
    }
  });
  it("demonstrates a caller rejecting the allegedly dangerous input", () => {
    const ratio = exportsFor("caller-validation", "head").ratio!;
    const source = evalFixtures.find((item) => item.id === "caller-validation")!.head[
      "src/route.js"
    ]!;
    const context: Record<string, unknown> = { ratio };
    new Script(source + "\nthis.result = route;").runInNewContext(context, { timeout: 1000 });
    const route = context.result as (req: unknown) => unknown;
    expect(() => route({ total: 10, count: 0 })).toThrow("400");
    expect(route({ total: "10", count: 2 })).toBe(5);
  });
  it("keeps ORM values in a parameter object, not interpolated SQL", async () => {
    let captured: unknown;
    const db = {
      user: {
        findMany: (query: unknown) => {
          captured = query;
          return [];
        },
      },
    };
    await exportsFor("orm-parameterization", "head").lookup!(db, "' OR 1=1 --");
    expect(captured).toEqual({ where: { name: "' OR 1=1 --" } });
  });
  it("proves an empty-array crash is unchanged by the PR", () => {
    for (const revision of ["base", "head"] as const) {
      expect(() => exportsFor("unrelated-existing-defect", revision).summary!([])).toThrow();
    }
  });
  it("proves the new nullable-profile helper actually throws", () => {
    expect(() => exportsFor("new-file-null-bug", "head").displayName!({ name: null })).toThrow();
  });
  it("proves the advertised string contract still returns undefined at runtime", () => {
    expect(exportsFor("api-nullability-regression", "head").getId!({})).toBeUndefined();
  });
  it("catches rejected fetches at the unchanged controller boundary", async () => {
    const load = exportsFor("error-handler-mitigation", "head").load!;
    const source = evalFixtures.find((item) => item.id === "error-handler-mitigation")!.head[
      "src/controller.js"
    ]!;
    const context: Record<string, unknown> = { load };
    new Script(source + "\nthis.result = controller;").runInNewContext(context, { timeout: 1000 });
    const controller = context.result as (value: unknown) => Promise<unknown>;
    expect(await controller({ fetch: () => Promise.reject(new Error("offline")) })).toEqual({
      status: 503,
      retry: true,
    });
  });
  it("labels only valid changed lines and preserves a mix of true and false-positive cases", () => {
    expect(evalFixtures.filter((item) => item.expected.length).length).toBeGreaterThanOrEqual(4);
    expect(evalFixtures.filter((item) => !item.expected.length).length).toBeGreaterThanOrEqual(5);
    for (const fixture of evalFixtures) {
      for (const bug of fixture.expected) {
        const file = fixture.files.find((item) => item.path === bug.path)!;
        expect(
          bug.lines.every((line) => reviewableLines(file).some((item) => item.line === line)),
        ).toBe(true);
      }
    }
  });
});
