import { Hono } from "hono";
import { getFsiCatalogSnapshot } from "../runtime/fsi/fsi-catalog";

export const fsiRouter = new Hono();

/** FSI 内容包目录：bundle、角色融合、MCP 目录、steering 示例（只读） */
fsiRouter.get("/catalog", async (c) => {
  const snapshot = await getFsiCatalogSnapshot();
  return c.json(snapshot);
});
