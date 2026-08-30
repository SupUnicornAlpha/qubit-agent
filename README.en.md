# QUBIT Agent Platform

[中文](README.md)

**A multi-agent platform for quantitative research** — conversation-led research, analyst collaboration, governed market data, quant workbenches, backtesting, and execution orchestration in one product.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Tauri](https://img.shields.io/badge/desktop-Tauri%20v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)

---

## Overview

QUBIT brings together a custom ReAct Agent Runtime, A2A analyst teams, an MCP tool marketplace, and a visual IDE for quantitative research and trading automation. It lets you:

- Bring chart context into a conversation, then let an orchestration agent dispatch research, backtest, and risk roles.
- Select the agents involved in a study from the **Research** canvas, inspect the topology, and follow the A2A collaboration trail.
- Review factors, strategies, and scripts produced by agents in the quant workbench; edit indicators and Python signals, then run backtests.
- Maintain local watchlists, read positions from a configured broker, and use the watchlist as real Agent research context.
- Research equities, options, futures, and crypto in one market workspace while governing sources such as Wind, Tushare, EastMoney, AKShare, yfinance, Yahoo, and Binance.
- Bind a selected strategy to its compatible symbol and candle interval, run it from the current chart, and write signal and fill markers back to the chart.
- Continuously score agents with ten built-in benchmark scenarios covering outcomes, evidence, tool governance, research artifacts, and execution capability.
- Connect MCP services (Anthropic Registry), Skills (SkillsMP), and brokers (Futu / IB) through the configuration center.

Data and strategy scripts are stored locally in `~/.quant-agent` by default. Override this with `QUBIT_DATA_DIR`.

---

## Screenshots

### Research workbench · chat, charts, and backtests

Sessions, the Agent panel, charts, and the backtest dock work together in one screen. Market context can be brought directly into an analysis conversation.

![Research workbench: chat, chart, and backtesting](docs/screenshots/ide-workbench.png)

### Market center · watchlist, positions, and order book

The local watchlist serves both the market UI and Agent research. Each symbol can show an intraday mini candlestick chart and intraday change. When a broker is configured, positions are loaded from the broker bridge in the adjacent tab; removing a symbol requires confirmation.

![Market center: watchlist, positions entry, and level-two order book](docs/screenshots/market-watchlist.png)

### Options chain · Greeks and strategy modelling

Options-chain and market-depth views are shown side by side. Build a strategy by expiration, strike, Call / Put, and direction, then inspect quotes, IV, OI, Greeks, break-even, and expiry scenarios.

![AAPL options chain: strategy tools, Greeks, and expiry scenarios](docs/screenshots/market-options-chain.png)

### Research team · multi-agent topology

Organize research work by workflow, configure analyst groups, launch a team analysis, and bind strategies and code from the right panel. Strategy files are written to the workflow directory.

![Research team: member directory, topology canvas, and strategy code](docs/screenshots/research-team.png)

### News · symbol and sector briefings

Symbol charts are combined with Yahoo and built-in news sources. News can be brought into conversation analysis and supplemented with sector ETF coverage.

![News page: market data and news brief](docs/screenshots/news-brief.png)

---

## Features

| Module | What it does |
|---|---|
| **Agent Runtime** | Custom `perceive → reason → act → observe` ReAct state machine with tool semantic validation, failure-domain circuit breaking, bounded retries, and sandbox audit. |
| **Working modes** | Agent answers directly or executes on demand; Plan creates a verifiable plan and prohibits business tools; Goal plans, executes, validates, and closes through a completion gate. |
| **Research team** | The orchestrator dispatches specialists, collects A2A results, isolates timeouts, and fuses debate, risk, and signals. |
| **Market governance** | Routes by market, interval, credentials, health, and priority; exposes success rate, P95, latest error, circuit-break state, and fallbacks. |
| **Watchlist and positions** | Local watchlists are read through `market.ide_subscription.get`; every row supports an intraday mini chart, change, and confirmed deletion. Configured brokers supply positions through their bridge. |
| **Multi-asset market data** | Equities / ETFs, OPRA US option chains, continuous futures contracts, and Binance spot instruments share one market workspace. Available coverage depends on configured sources. |
| **Options chain and modelling** | Call / Put chain, quotes, IV, OI, Greeks, multi-leg strategies, break-even, and expiry scenarios. Research-grade data is explicitly labelled and is not a trading decision feed. |
| **Quant workbench** | Factors, strategies, and scripts produced by agents are linked to workflows; edit, evaluate, backtest, and jump between artifacts. |
| **Chart-native backtesting** | Before execution, the system validates a strategy's symbol or universe and its candle interval. Compatible runs execute on the current chart and write signals / fills back to candles. |
| **News evidence** | Current analysis uses a seven-day freshness window and filters content with missing dates, stale or irrelevant items, and synthetic / stub content. |
| **Conversation workbench** | Session management, workflow-linked messages, Agent panels, and execution timelines. |
| **Observability** | Session, workflow, step, tool, MCP, and sandbox monitoring with failure attribution. |
| **Configuration center** | Workspace diffs, model configuration, Agent draft publishing, and MCP & Skills marketplaces. |
| **Agent benchmark** | Ten research, stock-selection, factor, strategy, and trading scenarios with AQM scoring, traces, and version comparison. |
| **Live trading and brokers** | Intent → risk control → execution with Futu / IB in mock, sandbox, or live modes. |
| **Desktop client** | Tauri v2 client with a production sidecar, migrations / seeds, native DuckDB dependencies, and backend readiness state. |

The three working modes and the reasoning engines used by team roles are independent. Team roles may use the in-process ReAct runtime, Claude CLI, or Codex CLI. Plan-only enforcement is performed through runtime tool permissions. Goal persists results, constraints, validation criteria, and evidence, and supports pause, resume, edit, and clear actions. A plan cannot finish early when steps remain `pending` / `in_progress`, when all steps were skipped, or when no execution evidence exists. Legacy `experience: native / coding_agent` values map to Agent / Goal; new APIs use `loopOptionsJson.agentMode`.

### Watchlist, position, and research-data boundaries

- **Watchlists** are maintained locally by the IDE. Agents obtain actual entries from `market.ide_subscription.get`; when that interface is empty or unavailable, historical conversation symbols are never presented as a user's watchlist.
- **Positions** are loaded from a configured broker bridge. If no account is configured or the bridge is unavailable, the UI shows an empty state instead of fabricated holdings.
- **Market data and option chains** carry their source and availability information. Research-grade or degraded data is for research, backtesting, and scenario analysis only — never a direct basis for trading decisions.
- **Chart backtests** run only when the current symbol (or an explicitly selected universe member) and candle interval match the strategy. Basket strategies require an explicit backtest symbol.

---

## Technology

| Layer | Technology |
|---|---|
| Backend | Bun · TypeScript · Hono · Drizzle · SQLite · DuckDB · Rust Prime Core |
| Orchestration | Custom ReAct state machine · A2A message bus · OpenAI SDK (multiple providers) |
| Frontend | Vite · React · Zustand |
| Desktop | Tauri v2 (Rust) |
| Connectors | Python (`python_connectors/`, market and broker bridges) |

---

## Quick start

### 0. Prerequisites

| Component | Required | Used for |
|---|---|---|
| [Bun](https://bun.sh) `>= 1.3` | Yes | Backend runtime, package manager, and frontend dev server |
| Node.js `>= 20` | Recommended | Parts of the build toolchain (Vite / Drizzle Kit) |
| Git | Yes | Cloning and FSI vendor synchronization |
| Rust / Cargo (stable) | Only for Tauri | `bun run dev:tauri` / `bun run build:tauri` |
| Xcode Command Line Tools / MSVC Build Tools | Only for Tauri | Native Tauri build toolchain |
| Python `>= 3.10` + pip | Optional | Market data, backtesting, and broker HTTP bridges (`python_connectors/`) |
| OpenD (Futu) / IB Gateway | Optional | Live broker connections |

> Data and strategy scripts live in `~/.quant-agent` by default and can be relocated with `QUBIT_DATA_DIR`. Packaged macOS builds use `~/Library/Application Support/app.qubit.agent/` by default.

### 1. Clone and install dependencies

```bash
git clone <your-fork-or-this-repo>.git qubit-agent
cd qubit-agent

# Install root (backend) and frontend workspace dependencies
bun install

# Generate migrations and initialize SQLite after the first startup or a schema change
bun run db:generate
bun run db:migrate
```

Optional seed data is recommended on first use so the configuration center and research team have usable content:

```bash
bun run seed:agent-definitions    # Agent definitions and research-team groups
bun run seed:recommended-mcp      # Recommended MCP services (math, finance, etc.)
```

### 2. Backend (required)

The custom ReAct / A2A runtime and Hono HTTP/WS server listen on **http://localhost:3000** by default.

**Prerequisites:** finish step 1. To call hosted models, configure at least one provider key (see [Configuration](#configuration)).

```bash
# Terminal 1
bun run dev
```

Override the host and port with environment variables:

```bash
PORT=3000 HOST=localhost bun run dev
```

After `Server listening on http://localhost:3000` appears, `GET /api/v1/system/health` is available.

For desktop integration, use the watch-mode backend. It shares Tauri's data directory, listens on `127.0.0.1:17385`, and restarts when files under `src/**` change:

```bash
bun run dev:backend
```

### 3. Frontend (web debugging)

Vite + React listen on **http://localhost:3041**. `/api` and `/ws` are proxied to backend port `:3000` in `frontend/vite.config.ts`.

**Prerequisite:** the backend is running through `bun run dev` on `:3000`. The `:17385` `dev:backend` port is mainly for desktop-client integration.

```bash
# Terminal 2
bun run dev:frontend
```

Open **http://localhost:3041**. `Backend Connected` in the top bar confirms that the API is reachable.

### 4. Desktop client (Tauri v2, optional)

Tauri is the desktop shell. In development, `tauri dev` launches the frontend dev server
and loads `http://localhost:3041`; the debug app starts the Bun backend fallback itself,
so a separate `bun run dev` is not required. Before startup, an ignored sidecar placeholder
is created to satisfy Tauri's `externalBin` validation; the actual backend still runs from
source in watch mode.

**Prerequisites:**

- Rust (preferably via `rustup`) and your platform's native build tools are installed.
- Step 1 has completed.
- To use a precompiled sidecar, run `bun run build:app` first; otherwise use the development command below.

```bash
# Terminal 1
bun run dev:tauri
```

Build a distributable package, including the Bun-compiled backend sidecar, SQLite migrations, `python_connectors/`, and `content-packs/`:

```bash
bun run build:app:release
```

Artifacts are written to `src-tauri/target/release/bundle/` (`.dmg`, `.app`, `.msi`, and so on). On its first packaged launch, the client automatically starts the sidecar on `127.0.0.1:38473`, migrates the database, seeds Agent / MCP / tools, and creates a Python virtual environment when needed. You may also run `POST /api/v1/system/bootstrap` or `./dist/bundle/bin/qubit bootstrap` manually.

### 5. Python connectors (optional)

Enable this only for **AKShare / Tencent China A-share data, yfinance Yahoo data (including dividends and fundamentals), Python backtests, or Futu / IB / CCXT broker bridges**. When a Python environment or upstream source is unavailable, the backend degrades according to market capability and health, and returns `unavailable` rather than simulated market data.

**Prerequisite:** local `python3 >= 3.10`. A dedicated virtual environment is recommended.

```bash
cd python_connectors
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # numpy / pandas / akshare / yfinance / pytest

# Futu live-trading example; requires OpenD and an additional dependency
pip install futu-api
python broker_http_server.py             # http://127.0.0.1:18765 by default
```

Register the `mock`, `sandbox`, or `live` mode and `baseUrl` in **Broker Account Configuration**. Packaged builds create their virtual environment inside the data directory, so manual `pip install` is unnecessary.

### Common development setups

| Scenario | Terminal 1 | Terminal 2 | Terminal 3 |
|---|---|---|---|
| Web debugging only | `bun run dev` | `bun run dev:frontend` | — |
| Desktop-client debugging | `bun run dev` | — | `bun run dev:tauri` |
| Full stack with broker bridge | `bun run dev` | `bun run dev:frontend` | `python broker_http_server.py` |

### What happens after a backend change?

| Mode | How TypeScript changes take effect | Best for |
|---|---|---|
| `bun run dev` | **Does not auto-reload**; restart manually with Ctrl-C | Not recommended |
| `bun run dev:backend` | **Automatic**; `bun --watch` monitors `src/**` and performs a graceful restart in 1–2 seconds | Recommended for a standalone backend |
| `bun run dev:tauri` | **Automatic**; the Tauri sidecar uses `bun --watch` and the same data directory as Tauri | Recommended for the desktop shell |

Check whether the backend is running the newest code:

```bash
curl -s http://localhost:17385/api/v1/_meta/build-info | jq
```

- The `dev-backend.log` header prints a banner, `pid`, `commit`, and `watchMode` after each restart.
- To disable watch mode for a long backtest, set `QUBIT_DEV_NO_WATCH=1`:

  ```bash
  QUBIT_DEV_NO_WATCH=1 bash scripts/dev-backend.sh
  QUBIT_DEV_NO_WATCH=1 bun run dev:tauri
  ```

- If a stale process still owns the port (macOS may leave a Tauri sidecar running after the window closes):

  ```bash
  kill $(lsof -ti :17385)
  ```

---

## Configuration

### Models (Configuration Center / `.qubit/model.json`)

Supported providers: `openai`, `anthropic`, `ollama`, `deepseek`, `qwen`, `zhipu`, and `mock`.

If no model configuration has been saved in the frontend, QUBIT falls back to environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `DASHSCOPE_API_KEY`.

### Data directory

| Variable | Default | Description |
|---|---|---|
| `QUBIT_DATA_DIR` | `~/.quant-agent` | SQLite, Agent Pack, and workflow-strategy directory |
| `PORT` / `HOST` | `3000` / `localhost` | Backend binding |
| `SKILLSMP_API_KEY` | — | Optional SkillsMP search quota |
| `TOPOLOGY_TASK_TIMEOUT_MS` | `120000` | Orchestrator timeout for a single A2A expert result (10s–300s) |

Example workflow artifact paths:

`$QUBIT_DATA_DIR/projects/<projectId>/workflows/<workflowRunId>/report.md`  
`$QUBIT_DATA_DIR/projects/<projectId>/workflows/<workflowRunId>/strategies/...`

---

## Market data sources and evidence governance

QUBIT registers and probes the following real data sources at startup:

| Source | Primary coverage | Role |
|---|---|---|
| Wind | China A-shares / Hong Kong equities | High-priority terminal data |
| Tushare Pro | China A-share daily bars | Token-authenticated source |
| EastMoney | China A-shares | Public fallback |
| AKShare / Tencent Securities | China A-shares / Hong Kong equities | Python and independent-upstream fallback |
| yfinance / Yahoo Chart | US, Hong Kong, China, and many global markets | Global-market fallback |
| Binance | Crypto | Minute through daily bars |

The market-source panel in Configuration Center displays supported markets and intervals, credential state, recent health checks, success rate, P95 latency, latest error, circuit-break status, priority, fallback capability, and network route. The market page and Agent tools use this same health state and skip unavailable sources adaptively.

The startup readiness gate requests real samples for its target markets. A market is reported ready only when at least one target source returns valid data. If all sources fail, the tool returns `market_data_unavailable` with attempted sources and failure classes; empty or synthetic data is never reported as success.

Useful checks:

```bash
curl -s http://localhost:3000/api/v1/market/data-sources | jq
curl -s -X POST http://localhost:3000/api/v1/market/data-sources/health | jq
curl -s http://localhost:3000/api/v1/market/readiness | jq
```

News passes an evidence gate as well. Current market analysis accepts only content from the last seven days that has a valid publication time, is relevant to the symbol, and is not synthetic or a stub. Historical news must explicitly use `historical_validation` mode and cannot be treated as a recent catalyst.

---

## Repository layout

```text
qubit-agent/
├── src/                 # Backend API, custom ReAct / A2A runtime, routes
├── frontend/            # Web UI (Vite + React)
├── src-tauri/           # Tauri desktop shell
├── python_connectors/   # Market and broker HTTP bridges
├── docs/
│   ├── ARCHITECTURE.md  # Platform architecture
│   ├── screenshots/     # README assets
│   └── LOOP_DRIVERS.md  # Loop-driver reference
└── drizzle/             # Migration artifacts
```

---

## Development and quality

```bash
bun run lint          # Biome lint
bun run check         # lint + formatting checks
bun test              # integration tests
bun run build         # production backend build, including DuckDB external handling
```

> **Execution path:** the custom ReAct state machine lives in `src/runtime/react/` (`run-react-loop.ts` plus `nodes/*`). Agent-to-agent dispatch uses the A2A message bus and recovery uses `agent_checkpoint_snapshot`. LangGraph is no longer a runtime dependency.

### Agent Benchmark

Run the readiness benchmark after substantial changes to agents, tool governance, or research-artifact flows. It covers ten tasks: single-symbol research, multi-symbol comparison, thematic research, long / short stock selection, factor generation, long-only / long-short strategies, and long / short execution.

```bash
# Start the desktop integration backend (default: :17385)
bun run dev:backend

# All ten scenarios; use deterministic scoring first when no LLM judge is available
bun run scripts/run-readiness-evaluation.ts --no-judge

# Run selected scenarios only
QUBIT_READINESS_SCENARIOS=research,factor,strategy \
  bun run scripts/run-readiness-evaluation.ts --no-judge

# Re-score an existing workflow or export its trace
bun run scripts/agent-readiness-runner.ts \
  --scenario=research --workflow=<workflowRunId> --output-dir=./out/agent-readiness
bun run scripts/agent-readiness-runner.ts \
  --trace=<workflowRunId> --output-dir=./out/agent-readiness
```

Output is written to `out/agent-readiness/`, including metric snapshots per workflow, Markdown reports, complete traces, a summarized health report, and cross-version diffs. Scoring checks final responses, valid data, tool governance, research quality, structured artifacts, and execution efficiency; it does not equate a completed run with a capable agent.

---

## Common APIs (excerpt)

<details>
<summary>Expand REST endpoints</summary>

- `GET /api/v1/workflows/:id/stream/:runId` — step stream
- `GET /api/v1/agents/definitions` — Agent definitions and drafts
- `GET /api/v1/chat/sessions` · `POST /api/v1/chat/sessions/:sessionId/turns` — the single conversational execution entry point
- `GET /api/v1/monitor/sessions/:id/overview` — aggregated session monitoring
- `GET /api/v1/research-artifacts/fusion/:workflowId` — historical research artifact fusion
- `GET /api/v1/market/data-sources` — market source capability, health, latency, circuit break, and priority
- `POST /api/v1/market/data-sources/health` — run a real-sample health check
- `GET /api/v1/market/readiness` — startup market-readiness state
- `GET /api/v1/agents/mcp/market/catalog` — paginated MCP marketplace
- `GET /api/v1/agents/skills/market/search` — paginated Skills marketplace
- `POST /api/v1/reia/broker/accounts/upsert` — broker account

For the complete route list, see `src/routes/`.

</details>

### Brokers (Futu / IB)

The trading path is `intent_order` → risk control / confirmation → `executeIntentLive`. Start OpenD and the Python bridge first (see [Python connectors](#5-python-connectors-optional)), then configure `mock`, `sandbox`, or `live` and its `baseUrl` in **Broker Account Configuration**. See the [Futu OpenAPI documentation](https://openapi.futunn.com/futu-api-doc/intro/intro.html) for details.

### External MCP

Configure **stdio**, **http**, or **ws** transports in `mcp_server_config`. Tool timeouts can be set per service in `mcp_tool_binding`.

---

## Documentation

- [Platform architecture](docs/ARCHITECTURE.md)
- [Loop drivers](docs/LOOP_DRIVERS.md)
- [Agent Benchmark v2](docs/AGENT_BENCHMARK_V2.md)

---

## Contributing

Issues and pull requests are welcome. Please run `bun run check` and `bun test` before submitting a change when practical.

---

## License

[Apache License 2.0](LICENSE)
