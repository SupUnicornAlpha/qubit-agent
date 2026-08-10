#!/usr/bin/env python3
"""Runner for *container-isolated* Python execution.

This file deliberately does not attempt to sandbox Python itself.  It is only
mounted read-only into a Docker container created with no network, a read-only
root filesystem, dropped capabilities, an unprivileged user and resource
limits.  Keeping this distinction explicit prevents the unsafe fiction that a
``__builtins__`` filter can safely execute hostile Python on the host.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import time
import traceback
from typing import Any


def serialize(value: Any) -> tuple[Any, int]:
    try:
        import numpy as np
        import pandas as pd

        if isinstance(value, pd.DataFrame):
            rows = min(len(value), 1000)
            return {
                "_type": "DataFrame",
                "columns": list(value.columns),
                "rows": value.head(rows).to_dict(orient="records"),
                "total_rows": int(len(value)),
            }, rows
        if isinstance(value, pd.Series):
            rows = min(len(value), 1000)
            return {
                "_type": "Series",
                "name": value.name,
                "index": list(map(str, value.head(rows).index)),
                "values": value.head(rows).tolist(),
                "total_rows": int(len(value)),
            }, rows
        if isinstance(value, np.ndarray):
            raw = value.tolist()
            return {"_type": "ndarray", "shape": list(value.shape), "values": raw}, len(raw) if isinstance(raw, list) else 1
    except ImportError:
        pass
    if isinstance(value, dict):
        return {str(k): serialize(v)[0] for k, v in value.items()}, len(value)
    if isinstance(value, (list, tuple)):
        return [serialize(v)[0] for v in value[:1000]], min(len(value), 1000)
    try:
        json.dumps(value)
        return value, 1
    except (TypeError, ValueError):
        return repr(value), 1


def install_declared_wheels(packages: list[str]) -> None:
    if not packages:
        return
    wheelhouse = "/opt/wheels"
    if not os.path.isdir(wheelhouse):
        raise RuntimeError("declared packages require a mounted wheelhouse")
    target = "/tmp/site"
    # No index/no network: package setup code executes only inside this already
    # constrained container, and dependencies must have been supplied by the user.
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--no-index", "--find-links", wheelhouse, "--target", target, *packages],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=90,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("wheel_install_failed: " + result.stdout[-1200:])
    sys.path.insert(0, target)


def main() -> None:
    started = time.time()
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        code = str(payload.get("code") or "")
        vars_in = payload.get("vars") or {}
        packages = payload.get("packages") or []
        max_stdout = min(524_288, max(1024, int(payload.get("max_stdout_bytes") or 65_536)))
        return_var = payload.get("return_var")
        if not code.strip():
            raise ValueError("code is required")
        if not isinstance(vars_in, dict) or not isinstance(packages, list):
            raise ValueError("vars must be an object and packages must be an array")
        install_declared_wheels([str(p) for p in packages])
        ns: dict[str, Any] = {"vars": dict(vars_in), "__name__": "__sandbox__"}
        for key, value in vars_in.items():
            if key.isidentifier() and not key.startswith("_"):
                ns[key] = value
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            exec(compile(code, "<container-sandbox>", "exec"), ns, ns)
        output = captured.getvalue()
        if len(output) > max_stdout:
            output = output[:max_stdout] + f"\n…[truncated {len(output) - max_stdout} bytes]"
        result: Any = None
        rows = 0
        if return_var:
            if return_var not in ns:
                raise NameError(f"return_var '{return_var}' not defined after code execution")
            result, rows = serialize(ns[return_var])
        print(json.dumps({"ok": True, "stdout": output, "result": result, "elapsed_ms": int((time.time() - started) * 1000), "rows_in_result": rows}))
    except Exception as exc:  # hostile code errors are returned, never raised into the host
        print(json.dumps({"ok": False, "error": str(exc), "trace": traceback.format_exc()[-1500:]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
