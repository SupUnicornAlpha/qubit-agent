#!/usr/bin/env python3
"""Small, fixed-purpose arithmetic and optional SymPy verifier for the Math Harness.

It accepts expressions, never arbitrary Python programs. Expressions are parsed
as an AST before evaluation; attribute access, indexing, comprehensions,
assignments and all non-whitelisted calls are rejected.
"""

from __future__ import annotations

import ast
import json
import math
import sys
from typing import Any


SAFE_FUNCS = {
    "abs": abs,
    "min": min,
    "max": max,
    "sqrt": math.sqrt,
    "exp": math.exp,
    "log": math.log,
    "log10": math.log10,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "erf": math.erf,
}
SAFE_CONSTANTS = {"pi": math.pi, "e": math.e}
ALLOWED_NODES = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Call, ast.Name, ast.Load,
    ast.Constant, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod,
    ast.USub, ast.UAdd, ast.Compare, ast.Eq, ast.NotEq, ast.Lt, ast.LtE,
    ast.Gt, ast.GtE, ast.BoolOp, ast.And, ast.Or, ast.Not,
)


def normalize(expression: str) -> str:
    if len(expression) > 4000:
        raise ValueError("expression_too_long")
    return expression.replace("^", "**").strip()


def validate(expression: str, variable_names: set[str]) -> ast.Expression:
    tree = ast.parse(normalize(expression), mode="eval")
    nodes = list(ast.walk(tree))
    if len(nodes) > 256:
        raise ValueError("expression_too_complex")
    for node in nodes:
        if not isinstance(node, ALLOWED_NODES):
            raise ValueError(f"unsafe_syntax:{type(node).__name__}")
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise ValueError("invalid_constant")
            if not math.isfinite(float(node.value)) or abs(float(node.value)) > 1e12:
                raise ValueError("unsafe_constant")
        if isinstance(node, ast.Name) and node.id not in variable_names | set(SAFE_FUNCS) | set(SAFE_CONSTANTS):
            raise ValueError(f"unknown_symbol:{node.id}")
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in SAFE_FUNCS:
                raise ValueError("unsafe_call")
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow) and isinstance(node.right, ast.Constant):
            if abs(float(node.right.value)) > 1000:
                raise ValueError("unsafe_exponent")
    return tree


def numeric(expression: str, variables_raw: Any) -> Any:
    if not isinstance(variables_raw, dict) or len(variables_raw) > 128:
        raise ValueError("invalid_variables")
    variables: dict[str, float] = {}
    for key, value in variables_raw.items():
        if not isinstance(key, str) or not key.isidentifier() or isinstance(value, bool):
            raise ValueError("invalid_variable")
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("non_finite_variable")
        variables[key] = number
    tree = validate(expression, set(variables))
    value = eval(compile(tree, "<math-harness>", "eval"), {"__builtins__": {}, **SAFE_FUNCS, **SAFE_CONSTANTS}, variables)
    if isinstance(value, bool):
        return value
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ValueError("non_finite_result")
    return float(value)


def symbolic(left: str, right: str, variable_names_raw: Any) -> dict[str, Any]:
    if not isinstance(variable_names_raw, list) or len(variable_names_raw) > 128:
        raise ValueError("invalid_symbolic_variables")
    variable_names = set()
    for name in variable_names_raw:
        if not isinstance(name, str) or not name.isidentifier():
            raise ValueError("invalid_symbolic_variable")
        variable_names.add(name)
    validate(left, variable_names)
    validate(right, variable_names)
    try:
        import sympy as sp  # type: ignore
    except Exception as exc:
        return {"ok": False, "unavailable": True, "error": f"sympy_unavailable:{str(exc)[:200]}"}
    locals_map = {name: sp.Symbol(name, real=True) for name in variable_names}
    locals_map.update({name: getattr(sp, name) for name in ("sqrt", "exp", "log", "sin", "cos", "tan")})
    left_expr = sp.sympify(normalize(left), locals=locals_map, evaluate=True)
    right_expr = sp.sympify(normalize(right), locals=locals_map, evaluate=True)
    equivalent = bool(sp.simplify(left_expr - right_expr) == 0)
    return {"ok": True, "equivalent": equivalent, "engine_version": getattr(sp, "__version__", None)}


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        action = payload.get("action", "evaluate")
        if action == "evaluate":
            value = numeric(str(payload.get("expression", "")), payload.get("variables", {}))
            print(json.dumps({"ok": True, "value": value, "engine_version": "python-ast/1"}))
            return
        if action == "symbolic_equivalent":
            result = symbolic(
                str(payload.get("left_expression", "")),
                str(payload.get("right_expression", "")),
                payload.get("variables", []),
            )
            print(json.dumps(result))
            return
        raise ValueError("unsupported_action")
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)[:500]}))


if __name__ == "__main__":
    main()
