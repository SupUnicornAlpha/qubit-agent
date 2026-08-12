import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("0097_unique_mcp_server_scope", () => {
  test("deduplicates global/project rows and prevents recurrence", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mcp_server_config (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project_id TEXT,
        transport TEXT NOT NULL,
        enabled INTEGER NOT NULL
      );
      INSERT INTO mcp_server_config VALUES
        ('global-old', 'financex', NULL, 'stdio', 1),
        ('global-new', 'financex', NULL, 'stdio', 0),
        ('project-old', 'math', 'p1', 'http', 1),
        ('project-new', 'math', 'p1', 'http', 0);
    `);

    const migration = readFileSync(
      join(import.meta.dir, "..", "migrations", "0097_unique_mcp_server_scope.sql"),
      "utf8"
    );
    db.exec(migration);

    expect(
      db.query<{ id: string }, []>("SELECT id FROM mcp_server_config ORDER BY id").all()
    ).toEqual([{ id: "global-old" }, { id: "project-old" }]);
    expect(() =>
      db.exec("INSERT INTO mcp_server_config VALUES ('dup', 'financex', NULL, 'stdio', 1)")
    ).toThrow();
    expect(() =>
      db.exec("INSERT INTO mcp_server_config VALUES ('dup2', 'math', 'p1', 'http', 1)")
    ).toThrow();
    db.close();
  });
});
