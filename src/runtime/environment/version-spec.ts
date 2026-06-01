/**
 * 极小化 PEP 440 版本约束求值（仅覆盖项目实际用到的子集）。
 *
 * 支持算子：== >= <= > < != ~=（compatible release）
 * 支持组合：用逗号 conjoin，如 `">=0.2.40,<1.0"`。
 *
 * **不支持**：epoch、本地标签（+ext）、@directURL、extras、prerelease 排序。
 * 已装版本 / spec 含 prerelease 标签（rc/dev/post/a/b）时按数值前缀 truncate
 * 比较，刻意做"宽松"以避免 false-mismatch（用户日常很少手写带 rc 的 spec）。
 *
 * 决议依据（DESIGN §6.1）：在 EnvironmentManager 这层只用版本作"提示"
 * （match / mismatch），真正的依赖求解仍交给 pip / npm。
 */

export type ComparisonOp = "==" | ">=" | "<=" | ">" | "<" | "!=" | "~=";

export interface ParsedConstraint {
  op: ComparisonOp;
  version: string;
  /** ~= 的右开上界，仅在 op='~=' 时有意义 */
  tildeUpper?: string;
}

/** 把 ">=0.2.40,<1.0" 拆为多个 ParsedConstraint；不识别的项跳过。 */
export function parseVersionSpec(spec: string | null | undefined): ParsedConstraint[] {
  if (!spec) return [];
  const out: ParsedConstraint[] = [];
  for (const partRaw of spec.split(",")) {
    const part = partRaw.trim();
    if (!part) continue;
    const m = part.match(/^(==|>=|<=|!=|~=|>|<)\s*([0-9][^\s,;]*)$/);
    if (!m) continue;
    const op = m[1] as ComparisonOp;
    const ver = m[2];
    if (op === "~=") {
      out.push({ op, version: ver, tildeUpper: nextCompatibleUpper(ver) });
    } else {
      out.push({ op, version: ver });
    }
  }
  return out;
}

/**
 * `~=X.Y.Z` ≈ `>=X.Y.Z,<X.(Y+1)`；`~=X.Y` ≈ `>=X.Y,<(X+1)`。
 * 主版本号 X 不允许 `~=X`（PEP 440 拒绝），这里简化处理：返回 X+1 上限。
 */
function nextCompatibleUpper(ver: string): string {
  const parts = numericParts(ver);
  if (parts.length <= 1) {
    parts[0] = (parts[0] ?? 0) + 1;
    return parts.join(".");
  }
  // truncate to len-1，最后一节 +1
  const head = parts.slice(0, -1);
  head[head.length - 1] = head[head.length - 1] + 1;
  return head.join(".");
}

/** 提取版本字符串中的数值序列；prerelease 标签（rc/dev/post/a/b）截断。 */
function numericParts(v: string): number[] {
  const cleaned = v.split(/[^0-9.]/)[0]; // 截断到首个非数字非点字符
  return cleaned
    .split(".")
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

/** lexicographic-numeric 比较：a-b 三态。短的视为后补 0。 */
export function compareVersions(a: string, b: string): number {
  const pa = numericParts(a);
  const pb = numericParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

/** 已装版本是否满足 spec；spec 为空 → 永远 true；spec 解析为空 → false（保守）。 */
export function satisfies(installed: string, spec: string | null | undefined): boolean {
  if (!spec) return true;
  const constraints = parseVersionSpec(spec);
  if (constraints.length === 0) return false;
  for (const c of constraints) {
    const cmp = compareVersions(installed, c.version);
    switch (c.op) {
      case "==":
        if (cmp !== 0) return false;
        break;
      case ">=":
        if (cmp < 0) return false;
        break;
      case "<=":
        if (cmp > 0) return false;
        break;
      case ">":
        if (cmp <= 0) return false;
        break;
      case "<":
        if (cmp >= 0) return false;
        break;
      case "!=":
        if (cmp === 0) return false;
        break;
      case "~=": {
        if (cmp < 0) return false;
        if (c.tildeUpper && compareVersions(installed, c.tildeUpper) >= 0) return false;
        break;
      }
    }
  }
  return true;
}
