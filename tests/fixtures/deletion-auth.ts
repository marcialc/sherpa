import type { ChangedFile } from "@sherpa/schemas";

/** Real behavioral regression: removing one guard leaves no added lines to anchor. */
export const deletionAuthBefore = [
  "function debit(user, account) {",
  "  if (!user || user.id !== account.ownerId) throw new Error('FORBIDDEN');",
  "  account.balance -= 10;",
  "  return account.balance;",
  "}",
].join("\n");
export const deletionAuthAfter = [
  "function debit(user, account) {",
  "  account.balance -= 10;",
  "  return account.balance;",
  "}",
].join("\n");
export const deletionAuthFile: ChangedFile = {
  path: "src/billing.js",
  status: "modified",
  additions: 0,
  deletions: 1,
  patch: [
    "@@ -1,5 +1,4 @@",
    " function debit(user, account) {",
    "-  if (!user || user.id !== account.ownerId) throw new Error('FORBIDDEN');",
    "   account.balance -= 10;",
    "   return account.balance;",
    " }",
  ].join("\n"),
};
