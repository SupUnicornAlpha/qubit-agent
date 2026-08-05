use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use schemars::schema_for;
use serde_json::Value;

use qubit_protocol::{
    AgentSpec, ContextEnvelope, ContextHandoffV1, DeliveryVerdict, HitlInboxItem, HitlPrompt,
    InvocationRequest, RuntimeEvent, SessionCreate, SessionView, TriggerEvent, TurnStart,
    WorkingMemory, PROTOCOL_VERSION,
};

fn write_schema<T: schemars::JsonSchema>(out_dir: &std::path::Path, name: &str) {
    let schema = schema_for!(T);
    let path = out_dir.join(format!("{name}.schema.json"));
    let json = serde_json::to_string_pretty(&schema).expect("serialize schema");
    fs::write(&path, json).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
    eprintln!("wrote {}", path.display());
}

fn main() {
    let out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("schemas");
    fs::create_dir_all(&out_dir).expect("create schemas dir");

    write_schema::<AgentSpec>(&out_dir, "agent_spec");
    write_schema::<SessionCreate>(&out_dir, "session_create");
    write_schema::<SessionView>(&out_dir, "session_view");
    write_schema::<TurnStart>(&out_dir, "turn_start");
    write_schema::<RuntimeEvent>(&out_dir, "runtime_event");
    write_schema::<ContextEnvelope>(&out_dir, "context_envelope");
    write_schema::<WorkingMemory>(&out_dir, "working_memory");
    write_schema::<ContextHandoffV1>(&out_dir, "context_handoff_v1");
    write_schema::<HitlPrompt>(&out_dir, "hitl_prompt");
    write_schema::<HitlInboxItem>(&out_dir, "hitl_inbox_item");
    write_schema::<DeliveryVerdict>(&out_dir, "delivery_verdict");
    write_schema::<InvocationRequest>(&out_dir, "invocation_request");
    write_schema::<TriggerEvent>(&out_dir, "trigger_event");

    let mut meta = BTreeMap::new();
    meta.insert("protocol_version", Value::String(PROTOCOL_VERSION.into()));
    meta.insert(
        "generated_at",
        Value::String(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs().to_string())
                .unwrap_or_default(),
        ),
    );
    fs::write(
        out_dir.join("manifest.json"),
        serde_json::to_string_pretty(&meta).unwrap(),
    )
    .expect("write manifest");
}
