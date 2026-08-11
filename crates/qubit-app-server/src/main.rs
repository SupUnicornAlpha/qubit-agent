//! Qubit Prime App Server — HTTP JSON-RPC + thin SSE event stream (O1).
//!
//! - `POST /rpc` — JSON-RPC methods
//! - `GET /health` — RuntimeHealth
//! - `GET /events` — SSE stream of `RuntimeEvent` (transport only; Core stays thin)
//!
//! WebSocket was avoided so we do not pull axum `ws` / tungstenite (keeps deps thin).

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::Parser;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt as _;
use tower_http::cors::CorsLayer;
use tracing::{info, warn};

use qubit_protocol::methods;
use qubit_protocol::{
    AgentSpec, HitlInboxFilter, HitlRespond, InvocationRequest, RuntimeEvent, SessionCreate,
    SessionGet, SessionSetMode, TriggerEvent, TurnCancel, TurnId, TurnStart,
};
use qubit_runtime::CoreRuntimeService;

#[derive(Parser, Debug)]
#[command(name = "qubit-app-server", about = "Qubit Prime App Server (M1)")]
struct Args {
    #[arg(long, env = "QUBIT_BIND", default_value = "127.0.0.1:8787")]
    bind: SocketAddr,
}

#[derive(Clone)]
struct AppState {
    runtime: Arc<CoreRuntimeService>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    method: String,
    #[serde(default)]
    params: Value,
    id: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
    id: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    let h = state.runtime.health().await;
    Json(serde_json::to_value(h).unwrap_or(json!({ "status": "ok" })))
}

#[derive(Debug, Deserialize)]
struct EventsQuery {
    /// Optional: only forward events for this turn_id.
    #[serde(default)]
    turn_id: Option<String>,
}

fn event_turn_id(ev: &RuntimeEvent) -> Option<&TurnId> {
    match ev {
        RuntimeEvent::TurnStarted { turn_id, .. }
        | RuntimeEvent::Token { turn_id, .. }
        | RuntimeEvent::ReasoningToken { turn_id, .. }
        | RuntimeEvent::ToolStarted { turn_id, .. }
        | RuntimeEvent::ToolFinished { turn_id, .. }
        | RuntimeEvent::PlanUpdated { turn_id, .. }
        | RuntimeEvent::TurnCompleted { turn_id, .. }
        | RuntimeEvent::TurnFailed { turn_id, .. } => Some(turn_id),
        RuntimeEvent::HitlRequested { prompt, .. } => Some(&prompt.turn_id),
        RuntimeEvent::RuntimeDegraded { .. } => None,
    }
}

async fn events_sse(
    State(state): State<AppState>,
    Query(q): Query<EventsQuery>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>> + Send> {
    let filter_turn = q.turn_id.filter(|s| !s.trim().is_empty());
    let hello_data = json!({
        "type": "subscribed",
        "method": methods::EVENTS_SUBSCRIBE,
        "filter_turn_id": filter_turn,
    })
    .to_string();
    let hello = tokio_stream::once(Ok::<Event, Infallible>(
        Event::default().event("subscribed").data(hello_data),
    ));

    let rx = state.runtime.event_bus().subscribe();
    let live = BroadcastStream::new(rx).filter_map(move |item| {
        let event = match item {
            Ok(ev) => ev,
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(n)) => {
                return Some(Ok::<Event, Infallible>(
                    Event::default()
                        .event("lagged")
                        .data(json!({ "skipped": n }).to_string()),
                ));
            }
        };
        if let Some(ref want) = filter_turn {
            match event_turn_id(&event) {
                Some(tid) if tid.as_str() == want => {}
                Some(_) => return None,
                None => {}
            }
        }
        match serde_json::to_string(&event) {
            Ok(text) => Some(Ok(Event::default().event("runtime").data(text))),
            Err(e) => {
                warn!(error = %e, "serialize RuntimeEvent failed");
                None
            }
        }
    });

    Sse::new(hello.chain(live)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

async fn rpc(
    State(state): State<AppState>,
    Json(req): Json<JsonRpcRequest>,
) -> (StatusCode, Json<JsonRpcResponse>) {
    if req.jsonrpc != "2.0" {
        return (
            StatusCode::BAD_REQUEST,
            Json(JsonRpcResponse {
                jsonrpc: "2.0",
                result: None,
                error: Some(JsonRpcError {
                    code: -32600,
                    message: "invalid jsonrpc version".into(),
                    data: None,
                }),
                id: req.id,
            }),
        );
    }

    match dispatch(&state, &req.method, req.params).await {
        Ok(result) => (
            StatusCode::OK,
            Json(JsonRpcResponse {
                jsonrpc: "2.0",
                result: Some(result),
                error: None,
                id: req.id,
            }),
        ),
        Err(err) => {
            warn!(method = %req.method, error = %err, "rpc failed");
            (
                StatusCode::OK,
                Json(JsonRpcResponse {
                    jsonrpc: "2.0",
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32000,
                        message: err,
                        data: None,
                    }),
                    id: req.id,
                }),
            )
        }
    }
}

async fn dispatch(state: &AppState, method: &str, params: Value) -> Result<Value, String> {
    let rt = &state.runtime;
    match method {
        methods::RUNTIME_HEALTH => {
            let h = rt.health().await;
            serde_json::to_value(h).map_err(|e| e.to_string())
        }
        methods::SESSION_CREATE => {
            let req: SessionCreate = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let view = rt.create_session(req).await.map_err(|e| e.to_string())?;
            serde_json::to_value(view).map_err(|e| e.to_string())
        }
        methods::SESSION_GET => {
            let req: SessionGet = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let view = rt.get_session(req).await.map_err(|e| e.to_string())?;
            serde_json::to_value(view).map_err(|e| e.to_string())
        }
        methods::SESSION_SET_MODE => {
            let req: SessionSetMode = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let view = rt.set_session_mode(req).await.map_err(|e| e.to_string())?;
            serde_json::to_value(view).map_err(|e| e.to_string())
        }
        methods::SESSION_SNAPSHOT => {
            let req: SessionGet = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let snap = rt.session_snapshot(req).await.map_err(|e| e.to_string())?;
            serde_json::to_value(snap).map_err(|e| e.to_string())
        }
        methods::TURN_START => {
            let req: TurnStart = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let res = rt.start_turn(req).await.map_err(|e| e.to_string())?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        methods::TURN_CANCEL => {
            let req: TurnCancel = serde_json::from_value(params).map_err(|e| e.to_string())?;
            rt.cancel_turn(req).await.map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        methods::TURN_FAIL => {
            let req: TurnCancel = serde_json::from_value(params).map_err(|e| e.to_string())?;
            rt.fail_turn(req).await.map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        methods::HITL_RESPOND => {
            let req: HitlRespond = serde_json::from_value(params).map_err(|e| e.to_string())?;
            rt.respond_hitl(req).await.map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        methods::HITL_INBOX_LIST => {
            let filter: HitlInboxFilter = serde_json::from_value(params).unwrap_or_default();
            let items = rt
                .list_hitl_inbox(filter)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(items).map_err(|e| e.to_string())
        }
        methods::AGENT_LIST => {
            let list = rt.list_agents().await;
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        methods::AGENT_UPSERT => {
            let spec: AgentSpec = serde_json::from_value(params).map_err(|e| e.to_string())?;
            rt.upsert_agent_spec(spec).await;
            Ok(json!({ "ok": true }))
        }
        methods::AGENT_INVOKE => {
            let req: InvocationRequest =
                serde_json::from_value(params).map_err(|e| e.to_string())?;
            let rec = rt.invoke_agent(req).await.map_err(|e| e.to_string())?;
            serde_json::to_value(rec).map_err(|e| e.to_string())
        }
        methods::TRIGGER_INGEST => {
            let event: TriggerEvent = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let turn = rt.ingest_trigger(event).await.map_err(|e| e.to_string())?;
            Ok(json!({ "turn_id": turn }))
        }
        other => Err(format!("method not found: {other}")),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "qubit_app_server=info,qubit_runtime=info".into()),
        )
        .init();

    let args = Args::parse();
    let runtime = Arc::new(build_runtime());
    runtime.seed_defaults().await;
    match runtime.recover_on_boot().await {
        Ok(n) => {
            if n > 0 {
                info!(recovered = n, "Core recover_on_boot hydrated sessions/HITL");
            }
        }
        Err(e) => warn!(error = %e, "recover_on_boot failed"),
    }
    if let Ok(path) = std::env::var("QUBIT_AGENT_SPECS_PATH") {
        match load_agent_specs_file(&runtime, &path).await {
            Ok(n) => info!(path = %path, count = n, "loaded agent specs from file"),
            Err(e) => warn!(path = %path, error = %e, "failed to load agent specs"),
        }
    }

    let state = AppState { runtime };
    let app = Router::new()
        .route("/health", get(health))
        .route("/rpc", post(rpc))
        .route("/events", get(events_sse))
        .layer(CorsLayer::permissive())
        .with_state(state);

    info!(%args.bind, "qubit-app-server listening (HTTP JSON-RPC + SSE /events)");
    let listener = tokio::net::TcpListener::bind(args.bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn build_runtime() -> CoreRuntimeService {
    use qubit_runtime::{OpenAiCompatibleClient, OpenAiCompatibleConfig};
    use std::sync::Arc as StdArc;

    let has_key = std::env::var("QUBIT_LLM_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::var("OPENAI_API_KEY")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .is_some();
    let force_fake = std::env::var("QUBIT_CORE_FAKE_MODEL")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let skip_db = std::env::var("QUBIT_CORE_SKIP_DB")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if force_fake {
        warn!("QUBIT_CORE_FAKE_MODEL=1 — using stub FakeModelClient (no LLM)");
        if skip_db {
            return CoreRuntimeService::new_for_test();
        }
        return match CoreRuntimeService::new_with_default_db() {
            Ok(rt) => {
                info!(
                    path = %qubit_runtime::default_core_db_path().display(),
                    "Core durable Session/HITL/Checkpoint SQLite enabled"
                );
                rt
            }
            Err(e) => {
                warn!(error = %e, "failed to open Core DB; falling back to in-memory");
                CoreRuntimeService::new_for_test()
            }
        };
    }

    let models: Option<StdArc<dyn qubit_runtime::ModelClient>> = if has_key
        || std::env::var("QUBIT_LLM_BASE_URL").is_ok()
    {
        match OpenAiCompatibleClient::from_env() {
            Ok(client) => {
                let cfg = OpenAiCompatibleConfig::default();
                info!(
                    model = %cfg.model,
                    base_url = %cfg.base_url,
                    "Core LLM: OpenAI-compatible client"
                );
                Some(StdArc::new(client))
            }
            Err(e) => {
                warn!(error = %e, "failed to init OpenAI client; falling back to FakeModelClient");
                None
            }
        }
    } else {
        warn!(
                "no QUBIT_LLM_API_KEY / OPENAI_API_KEY — Core using FakeModelClient stub (will not echo prompts)"
            );
        None
    };

    if skip_db {
        return match models {
            Some(m) => CoreRuntimeService::new_with_model(m),
            None => CoreRuntimeService::new_for_test(),
        };
    }

    let path = qubit_runtime::default_core_db_path();
    match models {
        Some(m) => match CoreRuntimeService::new_with_sqlite_and_model(&path, StdArc::clone(&m)) {
            Ok(rt) => {
                info!(path = %path.display(), "Core durable Session/HITL/Checkpoint SQLite enabled");
                rt
            }
            Err(e) => {
                warn!(error = %e, "failed to open Core DB; falling back to in-memory + model");
                CoreRuntimeService::new_with_model(m)
            }
        },
        None => match CoreRuntimeService::new_with_sqlite(&path) {
            Ok(rt) => {
                info!(path = %path.display(), "Core durable Session/HITL/Checkpoint SQLite enabled");
                rt
            }
            Err(e) => {
                warn!(error = %e, "failed to open Core DB; falling back to in-memory");
                CoreRuntimeService::new_for_test()
            }
        },
    }
}

async fn load_agent_specs_file(rt: &CoreRuntimeService, path: &str) -> Result<usize, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let specs: Vec<AgentSpec> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let n = specs.len();
    for spec in specs {
        rt.upsert_agent_spec(spec).await;
    }
    Ok(n)
}
