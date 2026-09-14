import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  deletionAuthAfter,
  deletionAuthBefore,
  deletionAuthFile,
} from "../../../tests/fixtures/deletion-auth";
import { addedLines, reviewableLines } from "./findings";

describe("deletion regression anchors", () => {
  it("preserves evidence for a real authorization bypass with zero added lines", () => {
    const before = runInNewContext(`${deletionAuthBefore}\ndebit;`) as (
      user: null,
      account: { ownerId: string; balance: number },
    ) => number;
    const after = runInNewContext(`${deletionAuthAfter}\ndebit;`) as typeof before;
    const account = { ownerId: "victim", balance: 100 };
    expect(() => before(null, account)).toThrow("FORBIDDEN");
    expect(after(null, account)).toBe(90);
    expect(addedLines(deletionAuthFile)).toEqual([]);
    const anchor = reviewableLines(deletionAuthFile).find((line) => line.line === 2);
    expect(anchor).toEqual({
      line: 2,
      text: "  account.balance -= 10;",
      kind: "deletion-context",
      hunk: { oldStart: 1, oldCount: 5, newStart: 1, newCount: 4 },
      removedLines: [
        {
          line: 2,
          text: "  if (!user || user.id !== account.ownerId) throw new Error('FORBIDDEN');",
        },
      ],
    });
    expect(deletionAuthAfter.split("\n")[anchor!.line - 1]).toBe(anchor!.text);
    expect(deletionAuthBefore.split("\n")[anchor!.removedLines[0]!.line - 1]).toBe(
      anchor!.removedLines[0]!.text,
    );
  });

  it("does not admit unchanged lines from a separate hunk without removals", () => {
    const file = {
      ...deletionAuthFile,
      patch: `${deletionAuthFile.patch}\n@@ -20 +19,2 @@\n unrelated();\n+newOperation();`,
    };
    expect(reviewableLines(file).find((line) => line.line === 19)).toBeUndefined();
    expect(reviewableLines(file).find((line) => line.line === 20)).toMatchObject({
      kind: "added",
      removedLines: [],
    });
    expect(addedLines(file)).toEqual([{ line: 20, text: "newOperation();" }]);
  });

  it.each([
    "@@ -1,5 +1,4 @@\n function debit(user, account) {\n-  guard();",
    "@@ -1 +1 @@\n-old\n+new\n@@ -1 +1 @@\n-old\n+new",
    "@@ -1 +1 @@\n context();\n unexpected();",
  ])("rejects incomplete or ambiguous hunks: %s", (patch) => {
    expect(reviewableLines({ ...deletionAuthFile, patch })).toEqual([]);
    expect(addedLines({ ...deletionAuthFile, patch })).toEqual([]);
  });

  it("leaves entirely deleted files without an invented RIGHT location", () => {
    expect(
      reviewableLines({
        ...deletionAuthFile,
        status: "removed",
        patch: "@@ -1 +0,0 @@\n-onlyLine();",
      }),
    ).toEqual([]);
  });
});
