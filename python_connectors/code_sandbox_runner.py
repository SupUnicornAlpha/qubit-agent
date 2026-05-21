#!/usr/bin/env python3
"""code_sandbox_runner — Agent 沙箱代码执行（spawn-once）

供量化研究 Agent 在 chat 流程中调用 builtin tool `code.run_python`：
拿到大量行情/因子值/价格数据后跑 pandas 计算，例如：
  - 计算 IC 矩阵 / RankIC 矩阵
  - 跨因子相关性矩阵
  - 自定义因子聚合（多因子等权 / 加权）
  - 拟合简单线性/逻辑回归

协议（stdin JSON）：
  {
    "code": "import pandas as pd\\nresult = pd.DataFrame(vars['bars']).head()",
    "vars": {"bars": [...], "factor_values": {...}, ...},   # 注入到 exec 命名空间
    "timeout_sec": 30,         # 上限 120
    "max_stdout_bytes": 65536, # 上限 524288
    "return_var": "result"     # 若提供：把这个变量序列化为 JSON 返回（DataFrame → records）
  }

stdout JSON：
  {
    "ok": true,
    "stdout": "...",
    "result": <serialized return_var>,
    "elapsed_ms": 123,
    "rows_in_result": 10
  }
或 {"ok": false, "error": "...", "stdout": "..."}

安全约束：
  - 限制 __builtins__ 为安全集合（无 open/eval/__import__/exec 等）
  - 通过 audit hook 拦截敏感操作（open/socket/subprocess/os.system…）
  - 通过自定义 import hook 限制可导入模块为白名单
  - SIGALRM 强制超时
  - 子进程级隔离（spawn-once，无网络访问由 TS 侧 spawn 时不传 env 也无法保证；
    真实生产建议外层用 unshare/docker，TS 侧不强加要求，作为「best effort」）

输出格式适配：
  - return_var 是 dict/list/标量 → 直接 JSON.dumps
  - return_var 是 pandas.DataFrame → to_dict('records')，附带 columns/dtypes
  - return_var 是 numpy.ndarray → tolist() + shape
  - return_var 是 pandas.Series → tolist() + index
"""

from __future__ import annotations

import builtins as _builtins
import io
import json
import signal
import sys
import time
import traceback
from typing import Any

# ─── 受限 builtins 白名单 ───
SAFE_BUILTINS_NAMES = {
    "abs", "all", "any", "bool", "bytes", "callable", "chr", "complex",
    "dict", "divmod", "enumerate", "filter", "float", "format", "frozenset",
    "getattr", "hasattr", "hash", "id", "int", "isinstance", "issubclass",
    "iter", "len", "list", "map", "max", "min", "next", "object", "oct",
    "ord", "pow", "print", "range", "repr", "reversed", "round", "set",
    "setattr", "slice", "sorted", "str", "sum", "tuple", "type", "vars",
    "zip", "True", "False", "None", "NotImplemented", "Ellipsis",
    # 异常
    "Exception", "ValueError", "TypeError", "KeyError", "IndexError",
    "ArithmeticError", "ZeroDivisionError", "RuntimeError", "StopIteration",
    "AssertionError", "AttributeError", "LookupError", "OverflowError",
    "FloatingPointError", "MemoryError", "NameError",
}

SAFE_BUILTINS = {k: getattr(_builtins, k) for k in SAFE_BUILTINS_NAMES if hasattr(_builtins, k)}

# ─── 模块白名单（默认放行；其它一律 ImportError） ───
ALLOWED_MODULES = {
    "math", "statistics", "json", "decimal", "fractions",
    "itertools", "functools", "operator", "collections",
    "datetime", "time",
    "numpy", "numpy.linalg", "numpy.random",
    "pandas",
    "scipy", "scipy.stats", "scipy.optimize",
    "re",
}

# 注意：上面的 ALLOWED_MODULES 只允许"完全等于"或"以 X. 开头"匹配


def _is_allowed_module(name: str) -> bool:
    if name in ALLOWED_MODULES:
        return True
    for prefix in ALLOWED_MODULES:
        if name.startswith(prefix + "."):
            return True
    return False


_orig_import = _builtins.__import__


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    # 不允许相对导入 / 越权
    if level != 0:
        raise ImportError(f"relative import not allowed: {name}")
    if not _is_allowed_module(name):
        raise ImportError(f"module '{name}' is not allowed in sandbox")
    return _orig_import(name, globals, locals, fromlist, level)


SAFE_BUILTINS["__import__"] = _safe_import


# ─── audit hook：拦截高危 io / 网络 / 进程操作 ───
DENIED_AUDIT_EVENTS = {
    "open",
    "socket.connect", "socket.bind",
    "subprocess.Popen", "os.system", "os.exec", "os.spawn",
    "shutil.rmtree", "shutil.move", "shutil.copy",
    "urllib.Request",
    "ftplib.FTP",
    "smtplib.SMTP",
}


def _audit(event: str, args: tuple) -> None:
    for denied in DENIED_AUDIT_EVENTS:
        if event == denied or event.startswith(denied):
            raise PermissionError(f"sandbox denied: {event}")


# Python 3.8+ 提供 sys.addaudithook
sys.addaudithook(_audit)


class TimeoutError_(Exception):
    pass


def _timeout_handler(signum, frame):  # noqa: ARG001
    raise TimeoutError_("sandbox timeout")


# ─── 结果序列化 ───


def _serialize(val: Any) -> tuple[Any, int]:
    """返回 (JSON-safe value, rows_in_result)。"""
    try:
        import pandas as pd  # noqa: WPS433
        import numpy as np  # noqa: WPS433

        if isinstance(val, pd.DataFrame):
            # 限制最多 1000 行
            n = min(len(val), 1000)
            return {
                "_type": "DataFrame",
                "columns": list(val.columns),
                "rows": val.head(n).to_dict(orient="records"),
                "total_rows": int(len(val)),
            }, n
        if isinstance(val, pd.Series):
            n = min(len(val), 1000)
            return {
                "_type": "Series",
                "name": val.name,
                "index": list(map(str, val.head(n).index)),
                "values": val.head(n).tolist(),
                "total_rows": int(len(val)),
            }, n
        if isinstance(val, np.ndarray):
            arr = val.tolist()
            n = len(arr) if isinstance(arr, list) else 1
            return {"_type": "ndarray", "shape": list(val.shape), "values": arr}, n
        if isinstance(val, (int, float, bool, str)) or val is None:
            return val, 1
        if isinstance(val, dict):
            return {k: _serialize(v)[0] for k, v in val.items()}, len(val)
        if isinstance(val, (list, tuple)):
            return [_serialize(v)[0] for v in val[:1000]], min(len(val), 1000)
        # 兜底
        return repr(val), 1
    except ImportError:
        # numpy/pandas 未装时直接用 json 兜底
        try:
            json.dumps(val)
            n = len(val) if isinstance(val, (list, dict)) else 1
            return val, n
        except (TypeError, ValueError):
            return repr(val), 1


def main():
    started = time.time()
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        code = str(payload.get("code") or "")
        vars_in = payload.get("vars") or {}
        timeout_sec = min(120, max(1, int(payload.get("timeout_sec") or 30)))
        max_stdout = min(524_288, max(1024, int(payload.get("max_stdout_bytes") or 65_536)))
        return_var = payload.get("return_var")

        if not code.strip():
            raise ValueError("code is required")
        if not isinstance(vars_in, dict):
            raise ValueError("vars must be an object")

        ns: dict[str, Any] = {"__builtins__": SAFE_BUILTINS, "vars": dict(vars_in)}
        # 也把 vars 里的每个 key 直接展开为顶级变量，方便用户写代码
        for k, v in vars_in.items():
            if k.isidentifier() and not k.startswith("_") and k not in ns:
                ns[k] = v

        # 抓 stdout
        cap = io.StringIO()
        sys_stdout_bak = sys.stdout
        sys.stdout = cap

        # 超时
        signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(timeout_sec)

        try:
            exec(compile(code, "<sandbox>", "exec"), ns, ns)
        finally:
            signal.alarm(0)
            sys.stdout = sys_stdout_bak

        stdout_text = cap.getvalue()
        if len(stdout_text) > max_stdout:
            stdout_text = (
                stdout_text[:max_stdout]
                + f"\n…[truncated {len(stdout_text) - max_stdout} bytes]"
            )

        result: Any = None
        rows = 0
        if return_var:
            if return_var not in ns:
                raise NameError(f"return_var '{return_var}' not defined after code execution")
            result, rows = _serialize(ns[return_var])

        print(
            json.dumps(
                {
                    "ok": True,
                    "stdout": stdout_text,
                    "result": result,
                    "elapsed_ms": int((time.time() - started) * 1000),
                    "rows_in_result": rows,
                }
            )
        )
    except TimeoutError_ as e:
        print(json.dumps({"ok": False, "error": "timeout", "detail": str(e)}))
        sys.exit(1)
    except PermissionError as e:
        print(json.dumps({"ok": False, "error": "permission_denied", "detail": str(e)}))
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(e),
                    "trace": traceback.format_exc()[-1500:],
                }
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
