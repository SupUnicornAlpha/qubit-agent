#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runL0SoftSuite, runL0Suite } from "../src/runtime/benchmark/l0-suite";
import { QUBIT_BENCH_VERSION } from "../src/runtime/benchmark/qubit-bench-cases";

const label = process.env["QUBIT_BENCH_LABEL"] ?? new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = resolve(
  process.env["QUBIT_BENCH_OUT"] ?? join("out", "qubit-bench", "L0", label)
);
const hard = runL0Suite();
const soft = runL0SoftSuite();
const hardPassed = hard.filter((result) => result.pass).length;
const softPassed = soft.filter((result) => result.pass).length;
const markdown = [
  "# QUBIT Bench L0 — Scorecard Fixture Suite",
  "",
  `- label: \`${label}\``,
  `- version: \`${QUBIT_BENCH_VERSION}\``,
  `- hard: ${hardPassed}/${hard.length}`,
  `- soft: ${softPassed}/${soft.length}`,
  "",
  "## Hard assertions",
  "",
  "| Case | Expected | Actual | Result |",
  "| --- | --- | --- | --- |",
  ...hard.map(
    (result) =>
      `| ${result.id} | ${result.expected.assertionId}=${result.expected.status} | ${result.actual} | ${result.pass ? "PASS" : "FAIL"} |`
  ),
  "",
  "## Soft dimensions",
  "",
  "| Case | Detail | Result |",
  "| --- | --- | --- |",
  ...soft.map(
    (result) => `| ${result.id} | ${result.detail} | ${result.pass ? "PASS" : "FAIL"} |`
  ),
  "",
  "> 本批为离线 Envelope/Scorecard fixture；不等同于 L1 的真 LLM/真工具评测，也不用于报告其为模型能力分数。",
  "",
].join("\n");

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "summary.md"), markdown, "utf8");
await writeFile(
  join(outputDir, "summary.json"),
  JSON.stringify({ hard, soft }, null, 2),
  "utf8"
);
console.log(markdown);
if (hardPassed !== hard.length || softPassed !== soft.length) process.exit(1);
