import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB = new Database(
  join(process.env.HOME!, "Library/Application Support/app.qubit.agent/db/core.sqlite"),
  { readonly: true },
);

const r = DB.query(`SELECT request_json, response_json, error_message, created_at, workflow_run_id
                    FROM tool_call_log
                    WHERE tool_name='factor.autoEvaluate' AND error_message LIKE '%FOREIGN KEY%'
                    ORDER BY created_at DESC`).all() as any[];
console.log(`found ${r.length} FK-fail rows\n`);
for (const row of r) {
  console.log(`=== ${row.created_at} wf=${row.workflow_run_id} ===`);
  const req = JSON.parse(row.request_json);
  const txt = req.reasonText ?? "";
  /** 找 reasonText 里的 <TOOL_CALL> JSON */
  const m = txt.match(/<TOOL_CALL>\s*([\s\S]*?)\s*<\/TOOL_CALL>/);
  if (m) {
    console.log("TOOL_CALL JSON:");
    try {
      console.log(JSON.stringify(JSON.parse(m[1]), null, 2));
    } catch {
      console.log(m[1]);
    }
  } else {
    console.log("(no <TOOL_CALL> tag found)");
    console.log("reasonText excerpt:", txt.slice(0, 400));
  }
  console.log("\nerror:", row.error_message);
  console.log("response excerpt:", (row.response_json ?? "").slice(0, 400));
  console.log("");
}

console.log("\n=== 验证 project 表里有哪些 id ===");
const projs = DB.query("SELECT id, name, workspace_id FROM project LIMIT 20").all() as any[];
for (const p of projs) console.log(`  ${p.id} | ${p.name} | ws=${p.workspace_id}`);
