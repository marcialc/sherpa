import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { IndexDatabase, IndexStatement } from "../store";

export class SqliteIndexDatabase implements IndexDatabase {
  readonly sql = new DatabaseSync(":memory:");
  constructor() {
    this.sql.exec("PRAGMA foreign_keys=ON");
    this.sql.exec(
      readFileSync(
        new URL("../../../../apps/worker/migrations/0001_repository_index.sql", import.meta.url),
        "utf8",
      ),
    );
  }
  prepare(sql: string): IndexStatement {
    const statement = this.sql.prepare(sql);
    const build = (values: (string | number | null)[]): IndexStatement => ({
      bind: (...next) => build(next),
      first: <T>() => Promise.resolve((statement.get(...values) ?? null) as T | null),
      all: <T>() => Promise.resolve({ results: statement.all(...values) as T[] }),
      run: () => Promise.resolve({ meta: { changes: Number(statement.run(...values).changes) } }),
    });
    return build([]);
  }
  async batch(statements: IndexStatement[]): Promise<unknown[]> {
    this.sql.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sql.exec("COMMIT");
      return results;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }
}
