/** 判断工具/MCP 是否「成功但无有效数据」 */
export function isEmptyToolResponse(responseJson: unknown): boolean {
  if (responseJson == null || responseJson === undefined) return true;
  if (typeof responseJson === "string") {
    const s = responseJson.trim();
    if (!s || s === "{}" || s === "[]" || s === "null") return true;
    try {
      return isEmptyToolResponse(JSON.parse(s));
    } catch {
      return false;
    }
  }
  if (Array.isArray(responseJson)) return responseJson.length === 0;
  if (typeof responseJson === "object") {
    const o = responseJson as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 0) return true;
    if (o.isError === true || o.error) return false;
    if (o.content === "" || o.content === null) return true;
    if (o.result === "" || o.result === null) return true;
    if (o.data === null || o.data === undefined) {
      if (keys.length <= 2 && ("status" in o || "ok" in o)) return true;
    }
    if (Array.isArray(o.content) && o.content.length === 0) return true;
  }
  return false;
}
