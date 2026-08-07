/**
 * Qubit PluginManifest — product-facing install unit (轨 A).
 * Execution still goes through builtin / MCP / agent_skill (轨 B 直装投影到此模型).
 */

export type PluginKind = "builtin_pack" | "mcp" | "skill" | "connector" | "bundle";

export type PluginVisibility = "public" | "personal" | "project";

export type PluginSafetyLevel = "low" | "medium" | "high";

export type PluginOriginFormat =
  | "native"
  | "mcp"
  | "agent_skills"
  | "codex_plugin"
  | "claude_plugin";

export interface PluginManifestRef {
  mcpCatalogId?: string;
  mcpInstallId?: string;
  mcpServerName?: string;
  skillIds?: string[];
  skillInstallId?: string;
  skillName?: string;
  skillPaths?: string[];
  builtinTools?: string[];
  mcpServers?: Array<{
    name: string;
    command?: string;
    url?: string;
    transport?: string;
    env?: Record<string, string>;
  }>;
}

export interface PluginOrigin {
  format: PluginOriginFormat;
  sourcePath?: string;
  sourceUrl?: string;
  note?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  description: string;
  category: string;
  visibility: PluginVisibility;
  kind: PluginKind;
  ref: PluginManifestRef;
  auth?: { type: "none" | "api_key" | "oauth2"; scopes?: string[] };
  safetyLevel: PluginSafetyLevel;
  origin?: PluginOrigin;
}

/** List/API row: manifest + install state for a project. */
export interface PluginListItem extends PluginManifest {
  installed: boolean;
  /** Opaque uninstall key: builtin:<id> | mcp:<installId> | skill:<installId> */
  installKey?: string;
  installStatus?: string;
  installedAt?: string;
  warnings?: string[];
  /** P2 OAuth: connected without exposing tokens */
  oauthConnected?: boolean;
  oauthStatus?: string;
  oauthExpiresAt?: string | null;
  oauthError?: string | null;
  oauthMcpServerName?: string | null;
}

export {
  INTERNET_PLUGIN_ID,
  QUANT_DATA_PLUGIN_ID,
} from "./plugin-ids";
