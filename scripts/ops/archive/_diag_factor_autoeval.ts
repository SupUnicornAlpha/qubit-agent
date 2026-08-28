import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB = new Database(
  join(process.env.HOME!, "Library/Application Support/app.qubit.agent/db/core.sqlite"),
  { readonly: true },
);

console.log("=== factor.autoEvaluate 12 次失败 详情 ===\n");
const rows = DB.query(`
  SELECT created_at, workflow_run_id, status,
         substr(request_json, 1, 500) AS input,
         substr(error_message, 1, 600) AS err,
         substr(response_json, 1, 300) AS out
  FROM tool_call_log
  WHERE tool_name = 'factor.autoEvaluate'
  ORDER BY created_at DESC`).all() as any[];

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  console.log(`--- #${i + 1} ${r.created_at} status=${r.status} wf=${r.workflow_run_id?.slice(0, 8)} ---`);
  console.log(`input : ${r.input}`);
  console.log(`error : ${r.err ?? "(none)"}`);
  console.log(`out   : ${r.out ?? "(none)"}`);
  console.log();
}

console.log("\n=== factor.register 调用情况 ===");
const reg = DB.query(`
  SELECT created_at, status, substr(request_json,1,300) AS input,
         substr(error_message,1,300) AS err,
         substr(response_json,1,200) AS out
  FROM tool_call_log
  WHERE tool_name = 'factor.register'
  ORDER BY created_at DESC
  LIMIT 5`).all() as any[];
for (const r of reg) {
  console.log(`[${r.status}] ${r.created_at}`);
  console.log(`  input: ${r.input}`);
  if (r.err) console.log(`  err  : ${r.err}`);
}

console.log("\n=== 看 factor_definition 表中那些 'expr 为空' 是怎么落进去的 ===");
const empty = DB.query(`
  SELECT name, category, length(expr) AS expr_len, length(definition_json) AS def_len, 
         substr(definition_json, 1, 200) AS def_excerpt,
         created_at
  FROM factor_definition
  WHERE expr = '' OR expr IS NULL
  ORDER BY created_at DESC LIMIT 10`).all() as any[];
console.log(`empty-expr factors: ${empty.length}`);
for (const f of empty) {
  console.log(`  ${f.created_at?.slice(0,16)} name=${f.name.padEnd(40)} cat=${f.category.padEnd(12)} expr_len=${f.expr_len} def_len=${f.def_len}`);
  console.log(`    def: ${f.def_excerpt}`);
}
