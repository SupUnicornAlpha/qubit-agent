use axum::routing::post;
use axum::{Json, Router};
use qubit_runtime::{BridgeToolHost, CancelToken, NormalizedToolCall, ToolHost};
use qubit_tool_host::{LegacyBridgeClient, LegacyBridgeConfig};
use serde_json::{json, Value};
use tokio::sync::oneshot;

async fn mock_rpc(Json(body): Json<Value>) -> Json<Value> {
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = body.get("id").cloned();
    if method == "legacy.tools.invoke" {
        let params = body.get("params").cloned().unwrap_or(json!({}));
        return Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "call_id": params.get("call_id").unwrap_or(&json!("tc")),
                "ok": true,
                "observation": { "summary": "bridged" },
                "effects": [{ "kind": "artifact", "key": "market.resolve_symbol" }],
                "retryable": false
            }
        }));
    }
    if method == "legacy.tools.list" {
        return Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": [
                    { "name": "market.resolve_symbol", "description": "x" },
                    { "name": "call_mcp", "description": "meta" },
                    { "name": "mcp:mathjs:add", "description": "add" }
                ]
            }
        }));
    }
    Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "no" } }))
}

#[tokio::test]
async fn bridge_tool_host_invokes_via_http() {
    let app = Router::new().route("/rpc", post(mock_rpc));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
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
    let host = BridgeToolHost::new(client);
    let _ = host.refresh_tool_names().await;
    assert!(host.owns_name("mcp:mathjs:add"));
    assert!(host.owns_name("call_mcp"));
    assert!(host.tool_names().contains(&"mcp:mathjs:add".to_string()));

    let results = host
        .invoke_all(
            vec![NormalizedToolCall {
                call_id: "tc9".into(),
                name: "market.resolve_symbol".into(),
                args: json!({ "symbol": "AAPL" }),
            }],
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].ok);
    assert_eq!(results[0].effects[0].key, "market.resolve_symbol");

    let mcp = host
        .invoke_all(
            vec![NormalizedToolCall {
                call_id: "tc_mcp".into(),
                name: "mcp:mathjs:add".into(),
                args: json!({ "a": 1, "b": 2 }),
            }],
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert!(mcp[0].ok);
    let _ = tx.send(());
}
