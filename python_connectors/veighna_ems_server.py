#!/usr/bin/env python3
"""veighna_ems_server — VeighNa EMS 长驻 stdio JSON-RPC server (骨架)

当前状态：占位实现。VeighnaEmsProvider 默认走 paper 模式（TS 端内存模拟），
本文件未来扩展为接 VeighNa CTP/SimNow/IBKR/Tiger 等真实 broker gateway。

协议（行分隔 JSON-RPC，与 broker_http_server.py 风格类似）：
  stdin/stdout 各一行 JSON，方法：
    - "ping"               → {"ok": true, "version": "..."}
    - "configure"          → {gateway: "ctp" | "simnow" | "ibkr" | ..., credentials: {...}}
    - "submit_order"       → {symbol, exchange, side, qty, type, price?, account_ref}
    - "cancel_order"       → {broker_order_id, account_ref}
    - "get_order_status"   → {broker_order_id, account_ref}
    - "get_account"        → {account_ref}

激活方式（未来）：
  在 `VeighnaEmsProvider` 构造时传 `mode: 'subprocess'`，TS 端将 spawn 本脚本
  作为长驻进程；目前 mode='subprocess' 会被 TS 端降级为 'paper'。

依赖：
  - vnpy
  - 对应 gateway 包：vnpy_ctp / vnpy_ib / vnpy_tiger 等

由于 vnpy 本身较重且 broker 凭据不在仓库里，骨架先返回 not_implemented。
"""

from __future__ import annotations

import json
import sys
from typing import Any

VERSION = "0.1.0-skeleton"


def respond(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def handle(req: dict[str, Any]) -> dict[str, Any]:
    method = req.get("method")
    if method == "ping":
        return {"ok": True, "version": VERSION, "note": "skeleton; paper-trade lives in TS"}
    if method == "configure":
        # TODO: import vnpy, create MainEngine + gateway, login
        return {
            "ok": False,
            "error": "not_implemented",
            "hint": "Install vnpy + gateway and wire MainEngine here.",
        }
    if method in {"submit_order", "cancel_order", "get_order_status", "get_account"}:
        return {
            "ok": False,
            "error": "not_implemented",
            "method": method,
            "hint": "VeighNa gateway not wired; use TS paper-trade mode for now.",
        }
    return {"ok": False, "error": f"unknown_method: {method}"}


def main() -> None:
    # 长驻：按行读取 JSON 请求
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = handle(req)
        except Exception as e:  # noqa: BLE001
            resp = {"ok": False, "error": f"parse_error: {e}"}
        respond(resp)


if __name__ == "__main__":
    main()
