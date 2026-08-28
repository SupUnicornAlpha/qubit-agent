import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DBDIR = `${process.env.HOME}/Library/Application Support/app.qubit.agent/db`;

const targets = [
  "qubit.db",
  "core.sqlite.bak-20260604-103827",
  "core.sqlite.bak-20260601-174723",
  "core.sqlite.bak-pre-0056-20260527-180100",
  "core-backup-fix-drift-20260527-154817.sqlite",
  "core.sqlite.bak-20260525-105908",
];

let freed = 0;
for (const name of targets) {
  const p = join(DBDIR, name);
  if (existsSync(p)) {
    const sz = statSync(p).size;
    rmSync(p, { force: true });
    freed += sz;
    console.log(`removed: ${name} (${(sz / 1024 / 1024 / 1024).toFixed(2)} GB)`);
  } else {
    console.log(`skip (missing): ${name}`);
  }
}
console.log(`\nfreed: ${(freed / 1024 / 1024 / 1024).toFixed(2)} GB`);

console.log("\n--- remaining ---");
for (const f of readdirSync(DBDIR)) {
  const sz = statSync(join(DBDIR, f)).size;
  console.log(`${f}\t${(sz / 1024 / 1024).toFixed(1)} MB`);
}
