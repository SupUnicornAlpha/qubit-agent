import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/** 目录名 slug：小写、连字符，去掉危险字符。 */
export function slugifyWorkspaceName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base.slice(0, 64) || "workspace";
}

/**
 * 将逻辑相对路径解析到 workspace 根下；拒绝越界、绝对路径。
 * 返回绝对路径与规范化相对路径（POSIX `/`）。
 */
export function resolveInsideRoot(
  rootPath: string,
  relPath: string
): { absPath: string; relPosix: string } {
  const trimmed = relPath.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === ".") {
    throw new WorkspacePathError("relPath required");
  }
  if (isAbsolute(trimmed) || trimmed.startsWith("~/") || /^[a-zA-Z]:/.test(trimmed)) {
    throw new WorkspacePathError("absolute paths are not allowed");
  }
  const segments = trimmed.split("/").filter((p) => p.length > 0 && p !== ".");
  if (segments.length === 0) {
    throw new WorkspacePathError("relPath required");
  }
  if (segments.some((p) => p === "..")) {
    throw new WorkspacePathError("path traversal is not allowed");
  }
  const rootAbs = resolve(rootPath);
  const absPath = resolve(rootAbs, ...segments);
  const rel = relative(rootAbs, absPath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new WorkspacePathError("path escapes workspace root");
  }
  const relPosix = rel.split(sep).join("/");
  return { absPath, relPosix };
}

export function joinRoot(rootPath: string, ...parts: string[]): string {
  return join(resolve(rootPath), ...parts);
}

export function normalizeRelPosix(relPath: string): string {
  return normalize(relPath).split(sep).join("/").replace(/^\.\//, "");
}
