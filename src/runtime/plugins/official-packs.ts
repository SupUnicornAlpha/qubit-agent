import { INTERNET_BUILTIN_TOOLS } from "../tools/internet-tools";
import {
  FUTU_CONNECTOR_PLUGIN_ID,
  GENERIC_OAUTH_PLUGIN_ID,
  GITHUB_CONNECTOR_PLUGIN_ID,
  INTERNET_PLUGIN_ID,
  QUANT_DATA_PLUGIN_ID,
} from "./plugin-ids";
import type { PluginManifest } from "./types";

export {
  FUTU_CONNECTOR_PLUGIN_ID,
  GENERIC_OAUTH_PLUGIN_ID,
  GITHUB_CONNECTOR_PLUGIN_ID,
} from "./plugin-ids";

/** Official packs shown in Plugins UI (展示投影，不新开执行路径). */
export function listOfficialPluginPacks(): PluginManifest[] {
  return [
    {
      id: INTERNET_PLUGIN_ID,
      name: "Internet",
      version: "1.0.0",
      description:
        "官方联网工具包：web.search 搜索公开网页，web.fetch 读取正文。研究默认能力，source=web，不可作实盘行情源。",
      category: "featured",
      visibility: "public",
      kind: "builtin_pack",
      ref: { builtinTools: [...INTERNET_BUILTIN_TOOLS] },
      auth: { type: "none" },
      safetyLevel: "low",
      origin: { format: "native" },
    },
    {
      id: QUANT_DATA_PLUGIN_ID,
      name: "Quant Data",
      version: "1.0.0",
      description:
        "官方量化数据面入口（行情 / 新闻等 ACP connector 工具）。代码内 bootstrap，非用户可卸。",
      category: "featured",
      visibility: "public",
      kind: "builtin_pack",
      ref: {
        builtinTools: ["fetch_klines", "fetch_price_data", "fetch_news", "run_screener"],
      },
      auth: { type: "none" },
      safetyLevel: "medium",
      origin: { format: "native" },
    },
    {
      id: FUTU_CONNECTOR_PLUGIN_ID,
      name: "Futu 富途",
      version: "1.0.0",
      description:
        "富途 OpenD：交易走 broker_http + qubit-broker MCP；行情走 market_bridge（L2）。在券商账户配置 OpenD host/port 后自动拉起本地桥。需本机 OpenD 与 futu-api。",
      category: "trading",
      visibility: "public",
      kind: "connector",
      ref: {
        mcpServers: [
          {
            name: "qubit-broker",
            command: "bun run src/runtime/mcp/broker-mcp-server.ts",
            transport: "stdio",
          },
        ],
        builtinTools: ["submit_order", "cancel_order", "get_fills"],
      },
      auth: { type: "none" },
      safetyLevel: "high",
      origin: { format: "native" },
    },
    {
      id: GITHUB_CONNECTOR_PLUGIN_ID,
      name: "GitHub",
      version: "1.0.0",
      description:
        "OAuth2 连接 GitHub（预置 authorize/token URL）。配置 Client ID/Secret 后连接；可选绑定 MCP server 名以在 HTTP 调用时注入 Bearer。",
      category: "productivity",
      visibility: "public",
      kind: "connector",
      ref: {},
      auth: { type: "oauth2", scopes: ["read:user", "repo"] },
      safetyLevel: "medium",
      origin: { format: "native" },
    },
    {
      id: GENERIC_OAUTH_PLUGIN_ID,
      name: "Generic OAuth2",
      version: "1.0.0",
      description:
        "通用 OAuth2 连接器：自填 authorize_url / token_url / scopes / client。适合 Notion、Linear、自建 IdP 等；不绑定 OpenAI App ID。",
      category: "productivity",
      visibility: "public",
      kind: "connector",
      ref: {},
      auth: { type: "oauth2" },
      safetyLevel: "medium",
      origin: { format: "native" },
    },
  ];
}

export function getOfficialPluginPack(id: string): PluginManifest | undefined {
  return listOfficialPluginPacks().find((p) => p.id === id);
}
