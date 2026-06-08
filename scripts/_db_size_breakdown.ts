import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB_PATH = join(
  process.env.HOME!,
  "Library/Application Support/app.qubit.agent/db/core.sqlite",
);

const db = new Database(DB_PATH, { readonly: true });

const tables = db
  .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((r: any) => r.name) as string[];

console.log("table_size_breakdown (top 30 by approximate bytes)\n");

type Row = { name: string; rows: number; bytes: number };
const rows: Row[] = [];
for (const t of tables) {
  try {
    const count = (db.query(`SELECT COUNT(*) AS c FROM "${t}"`).get() as any).c as number;
    if (count === 0) {
      rows.push({ name: t, rows: 0, bytes: 0 });
      continue;
    }
    // approximate bytes per table via SUM(length of all TEXT/BLOB columns + numeric ~8)
    const cols = db.query(`PRAGMA table_info("${t}")`).all() as any[];
    const exprParts = cols
      .map((c) => {
        const ty = (c.type || "").toUpperCase();
        if (ty.includes("BLOB") || ty.includes("TEXT") || ty.includes("JSON")) {
          return `COALESCE(length("${c.name}"),0)`;
        }
        return `8`;
      })
      .join(" + ");
    const expr = exprParts.length > 0 ? exprParts : "0";
    const bytes = (db.query(`SELECT SUM(${expr}) AS b FROM "${t}"`).get() as any).b ?? 0;
    rows.push({ name: t, rows: count, bytes });
  } catch (e: any) {
    console.warn(`skip ${t}: ${e.message}`);
  }
}

rows.sort((a, b) => b.bytes - a.bytes);
const total = rows.reduce((s, r) => s + r.bytes, 0);
console.log(`approx total bytes (sum of row content): ${(total / 1024 / 1024 / 1024).toFixed(2)} GB\n`);

console.log("name".padEnd(40), "rows".padStart(8), "size".padStart(12), "share".padStart(7));
for (const r of rows.slice(0, 30)) {
  const sz = r.bytes >= 1024 * 1024 * 1024
    ? `${(r.bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
    : r.bytes >= 1024 * 1024
      ? `${(r.bytes / 1024 / 1024).toFixed(1)} MB`
      : `${(r.bytes / 1024).toFixed(0)} KB`;
  const share = total > 0 ? ((r.bytes / total) * 100).toFixed(1) : "0";
  console.log(
    r.name.padEnd(40),
    String(r.rows).padStart(8),
    sz.padStart(12),
    `${share}%`.padStart(7),
  );
}

console.log("\n--- 自由页 / freelist ---");
const fl = (db.query("PRAGMA freelist_count").get() as any);
const ps = (db.query("PRAGMA page_size").get() as any);
const pc = (db.query("PRAGMA page_count").get() as any);
console.log("page_size:", ps.page_size, "page_count:", pc.page_count, "freelist:", fl.freelist_count);
const totalSize = ps.page_size * pc.page_count;
const freeSize = ps.page_size * fl.freelist_count;
console.log(`alloc: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB  free: ${(freeSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
