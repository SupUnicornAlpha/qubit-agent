use axum::routing::post;
use axum::{Json, Router};
use qubit_protocol::SessionId;
use qubit_runtime::{
    with_tool_turn_context, BridgeToolHost, CancelToken, NormalizedToolCall, ToolHost,
};
use qubit_tool_host::{LegacyBridgeClient, LegacyBridgeConfig};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{oneshot, Barrier};

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
                "observation": {
                    "summary": "bridged",
                    "workspace_id": params.get("workspace_id"),
                    "session_id": params.get("session_id"),
                },
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

async fn mock_host() -> (Arc<BridgeToolHost>, oneshot::Sender<()>) {
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
    (Arc::new(BridgeToolHost::new(client)), tx)
}

#[tokio::test]
async fn bridge_tool_host_invokes_via_http() {
    let (host, tx) = mock_host().await;
    with_tool_turn_context("ws".into(), SessionId::new("session"), async {
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
    })
    .await;
    let _ = tx.send(());
}

fn identity_call(id: &str) -> NormalizedToolCall {
    NormalizedToolCall {
        call_id: id.into(),
        name: "market.resolve_symbol".into(),
        args: json!({"symbol": "AAPL"}),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_bridge_turns_keep_their_own_identity() {
    let (host, tx) = mock_host().await;
    let barrier = Arc::new(Barrier::new(2));
    let mut tasks = Vec::new();
    for identity in ["controlled", "legacy"] {
        let host = Arc::clone(&host);
        let barrier = Arc::clone(&barrier);
        tasks.push(tokio::spawn(async move {
            let workspace = format!("ws_{identity}");
            let session = SessionId::new(format!("session_{identity}"));
            with_tool_turn_context(workspace.clone(), session.clone(), async {
                host.bind_turn_context(&workspace, &session).await;
                // Both turns have bound before either invokes; a shared last-bound
                // identity would deterministically send at least one wrong project.
                barrier.wait().await;
                let results = host
                    .invoke_all(vec![identity_call(identity)], CancelToken::new())
                    .await
                    .unwrap();
                let observation = results[0].observation.as_ref().unwrap();
                assert_eq!(observation["workspace_id"], workspace);
                assert_eq!(observation["session_id"], session.as_str());
            })
            .await;
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let _ = tx.send(());
}

#[tokio::test]
async fn nested_failed_turn_restores_parent_and_unscoped_bridge_fails_closed() {
    let (host, tx) = mock_host().await;
    with_tool_turn_context("parent_ws".into(), SessionId::new("parent"), async {
        host.bind_turn_context("parent_ws", &SessionId::new("parent"))
            .await;
        let child = with_tool_turn_context("child_ws".into(), SessionId::new("child"), async {
            host.bind_turn_context("child_ws", &SessionId::new("child"))
                .await;
            let results = host
                .invoke_all(vec![identity_call("child")], CancelToken::new())
                .await
                .unwrap();
            assert_eq!(
                results[0].observation.as_ref().unwrap()["session_id"],
                "child"
            );
            let cancel = CancelToken::new();
            cancel.cancel();
            host.invoke_all(vec![identity_call("cancelled")], cancel)
                .await
        })
        .await;
        assert!(child.is_err());
        let results = host
            .invoke_all(vec![identity_call("parent")], CancelToken::new())
            .await
            .unwrap();
        assert_eq!(
            results[0].observation.as_ref().unwrap()["workspace_id"],
            "parent_ws"
        );
        assert_eq!(
            results[0].observation.as_ref().unwrap()["session_id"],
            "parent"
        );
        // A spawned task cannot silently reuse its creator's authorization.
        let unscoped_host = Arc::clone(&host);
        assert!(tokio::spawn(async move {
            unscoped_host
                .invoke_all(vec![identity_call("spawned")], CancelToken::new())
                .await
        })
        .await
        .unwrap()
        .is_err());
    })
    .await;
    let error = host
        .invoke_all(vec![identity_call("unscoped")], CancelToken::new())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("bridge_turn_context_missing"));
    let _ = tx.send(());
}
