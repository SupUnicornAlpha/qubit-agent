//! Mock Bun legacy bridge + client roundtrip.

use std::net::SocketAddr;

use axum::routing::post;
use axum::{Json, Router};
use qubit_tool_host::{
    LegacyBridgeClient, LegacyBridgeConfig, LegacyInvokeParams, DEFAULT_BRIDGED_TOOLS,
};
use serde_json::{json, Value};
use tokio::sync::oneshot;

async fn mock_rpc(Json(body): Json<Value>) -> Json<Value> {
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = body.get("id").cloned();
    match method {
        "legacy.tools.list" => Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": DEFAULT_BRIDGED_TOOLS.iter().map(|n| json!({
                    "name": n,
                    "description": format!("mock {n}")
                })).collect::<Vec<_>>()
            }
        })),
        "legacy.tools.invoke" => {
            let params = body.get("params").cloned().unwrap_or(json!({}));
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let call_id = params
                .get("call_id")
                .and_then(|v| v.as_str())
                .unwrap_or("tc_mock");
            Json(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "call_id": call_id,
                    "ok": true,
                    "observation": { "summary": format!("mock ok: {name}"), "echo": params.get("args") },
                    "effects": [{ "kind": "other", "key": name, "meta": { "via": "mock" } }],
                    "retryable": false,
                    "error_code": null
                }
            }))
        }
        other => Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("unknown {other}") }
        })),
    }
}

#[tokio::test]
async fn legacy_bridge_list_and_invoke() {
    let app = Router::new().route("/rpc", post(mock_rpc));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let (tx, rx) = oneshot::channel::<()>();
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await
            .ok();
    });

    let client = LegacyBridgeClient::new(LegacyBridgeConfig {
        base_url: format!("http://{addr}"),
        timeout_secs: 5,
    })
    .unwrap();

    let tools = client.list_tools().await.expect("list");
    assert!(tools.len() >= 3);
    assert!(tools.iter().any(|t| t.name == "market.resolve_symbol"));

    let result = client
        .invoke(LegacyInvokeParams {
            call_id: "tc_1".into(),
            name: "market.resolve_symbol".into(),
            args: json!({ "symbol": "600519" }),
            idempotency_key: Some("k1".into()),
            workspace_id: None,
            session_id: None,
        })
        .await
        .expect("invoke");
    assert!(result.ok);
    assert_eq!(result.call_id, "tc_1");
    assert!(!result.effects.is_empty());

    let _ = tx.send(());
}
