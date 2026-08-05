import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { config } from "../../config";
import { getDb } from "../../db/sqlite/client";
import { connectorAuth } from "../../db/sqlite/schema";

export type ConnectorAuthStatus = "pending" | "connected" | "error" | "revoked";

/** Safe status DTO — never includes access/refresh tokens. */
export type ConnectorAuthPublic = {
  id: string;
  projectId: string;
  pluginId: string;
  provider: string;
  displayName: string;
  status: ConnectorAuthStatus;
  scopes: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  mcpServerName: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
  hasClientSecret: boolean;
  connected: boolean;
  updatedAt: string;
};

export type UpsertConnectorAuthInput = {
  projectId: string;
  pluginId: string;
  provider?: string;
  displayName?: string;
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes?: string;
  redirectUri?: string;
  mcpServerName?: string | null;
};

const GITHUB_PRESET = {
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  scopes: "read:user repo",
};

export function getConnectorPreset(pluginId: string): {
  provider: string;
  displayName: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string;
} | null {
  if (pluginId === "connector:github") {
    return {
      provider: "github",
      displayName: "GitHub",
      ...GITHUB_PRESET,
    };
  }
  if (pluginId === "connector:generic-oauth2") {
    return {
      provider: "generic_oauth2",
      displayName: "Generic OAuth2",
    };
  }
  return null;
}

export function publicBaseUrl(reqOrigin?: string): string {
  const env = process.env.QUBIT_PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  if (reqOrigin?.startsWith("http")) return reqOrigin.replace(/\/$/, "");
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}`;
}

export function defaultRedirectUri(reqOrigin?: string): string {
  return `${publicBaseUrl(reqOrigin)}/api/v1/plugins/oauth/callback`;
}

function toPublic(row: typeof connectorAuth.$inferSelect): ConnectorAuthPublic {
  return {
    id: row.id,
    projectId: row.projectId,
    pluginId: row.pluginId,
    provider: row.provider,
    displayName: row.displayName,
    status: row.status,
    scopes: row.scopes,
    authorizeUrl: row.authorizeUrl,
    tokenUrl: row.tokenUrl,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    mcpServerName: row.mcpServerName,
    expiresAt: row.expiresAt,
    errorMessage: row.errorMessage,
    hasClientSecret: Boolean(row.clientSecret?.trim()),
    connected: row.status === "connected" && Boolean(row.accessToken?.trim()),
    updatedAt: row.updatedAt,
  };
}

export async function listConnectorAuthStatus(projectId: string): Promise<ConnectorAuthPublic[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(connectorAuth)
    .where(eq(connectorAuth.projectId, projectId));
  return rows.map(toPublic);
}

export async function getConnectorAuth(
  projectId: string,
  pluginId: string
): Promise<typeof connectorAuth.$inferSelect | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(connectorAuth)
    .where(and(eq(connectorAuth.projectId, projectId), eq(connectorAuth.pluginId, pluginId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertConnectorAuthConfig(
  input: UpsertConnectorAuthInput
): Promise<ConnectorAuthPublic> {
  const preset = getConnectorPreset(input.pluginId);
  const authorizeUrl = (input.authorizeUrl || preset?.authorizeUrl || "").trim();
  const tokenUrl = (input.tokenUrl || preset?.tokenUrl || "").trim();
  const clientId = input.clientId.trim();
  if (!clientId) throw new Error("clientId is required");
  if (!authorizeUrl || !tokenUrl) throw new Error("authorizeUrl and tokenUrl are required");

  const db = await getDb();
  const existing = await getConnectorAuth(input.projectId, input.pluginId);
  const now = new Date().toISOString();
  const redirectUri = (input.redirectUri || defaultRedirectUri()).trim();

  if (existing) {
    await db
      .update(connectorAuth)
      .set({
        provider: input.provider ?? preset?.provider ?? existing.provider,
        displayName:
          input.displayName?.trim() ||
          preset?.displayName ||
          existing.displayName ||
          input.pluginId,
        clientId,
        clientSecret:
          input.clientSecret !== undefined
            ? input.clientSecret
            : existing.clientSecret,
        authorizeUrl,
        tokenUrl,
        scopes: (input.scopes ?? preset?.scopes ?? existing.scopes).trim(),
        redirectUri,
        mcpServerName:
          input.mcpServerName === undefined
            ? existing.mcpServerName
            : input.mcpServerName?.trim() || null,
        updatedAt: now,
        // Keep tokens; config change does not revoke unless disconnect.
      })
      .where(eq(connectorAuth.id, existing.id));
    const updated = await getConnectorAuth(input.projectId, input.pluginId);
    return toPublic(updated!);
  }

  const id = randomUUID();
  await db.insert(connectorAuth).values({
    id,
    projectId: input.projectId,
    pluginId: input.pluginId,
    provider: input.provider ?? preset?.provider ?? "generic_oauth2",
    displayName:
      input.displayName?.trim() || preset?.displayName || input.pluginId,
    status: "pending",
    clientId,
    clientSecret: input.clientSecret ?? "",
    authorizeUrl,
    tokenUrl,
    scopes: (input.scopes ?? preset?.scopes ?? "").trim(),
    redirectUri,
    mcpServerName: input.mcpServerName?.trim() || null,
    metaJson: {},
  });
  const created = await getConnectorAuth(input.projectId, input.pluginId);
  return toPublic(created!);
}

export async function beginOAuthAuthorize(input: {
  projectId: string;
  pluginId: string;
  reqOrigin?: string;
}): Promise<{ authorizeUrl: string; state: string }> {
  const row = await getConnectorAuth(input.projectId, input.pluginId);
  if (!row) {
    throw new Error(
      `connector not configured: upsert OAuth client settings for ${input.pluginId} first`
    );
  }
  if (!row.clientId.trim() || !row.authorizeUrl.trim()) {
    throw new Error("clientId and authorizeUrl required");
  }
  if (!row.clientSecret.trim()) {
    throw new Error("clientSecret required before authorize");
  }

  const state = randomBytes(24).toString("hex");
  const redirectUri = row.redirectUri.trim() || defaultRedirectUri(input.reqOrigin);
  const db = await getDb();
  await db
    .update(connectorAuth)
    .set({
      state,
      redirectUri,
      status: "pending",
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(connectorAuth.id, row.id));

  const url = new URL(row.authorizeUrl);
  url.searchParams.set("client_id", row.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (row.scopes.trim()) url.searchParams.set("scope", row.scopes.trim());

  return { authorizeUrl: url.toString(), state };
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function exchangeToken(input: {
  tokenUrl: string;
  body: Record<string, string>;
  clientId: string;
  clientSecret: string;
}): Promise<TokenResponse> {
  const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64");
  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basic}`,
      "User-Agent": "qubit-agent/oauth",
    },
    body: new URLSearchParams(input.body).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  let data: TokenResponse;
  if (contentType.includes("json")) {
    data = (await response.json()) as TokenResponse;
  } else {
    const text = await response.text();
    const params = new URLSearchParams(text);
    data = Object.fromEntries(params.entries()) as TokenResponse;
  }
  if (!response.ok || data.error || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        `token exchange failed: HTTP ${response.status}`
    );
  }
  return data;
}

export async function completeOAuthCallback(input: {
  code: string;
  state: string;
}): Promise<ConnectorAuthPublic> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(connectorAuth)
    .where(eq(connectorAuth.state, input.state))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("invalid or expired OAuth state");

  try {
    const token = await exchangeToken({
      tokenUrl: row.tokenUrl,
      clientId: row.clientId,
      clientSecret: row.clientSecret,
      body: {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: row.redirectUri,
        client_id: row.clientId,
        client_secret: row.clientSecret,
      },
    });
    const expiresAt =
      typeof token.expires_in === "number"
        ? new Date(Date.now() + token.expires_in * 1000).toISOString()
        : null;
    await db
      .update(connectorAuth)
      .set({
        accessToken: token.access_token!,
        refreshToken: token.refresh_token ?? row.refreshToken,
        tokenType: token.token_type ?? "Bearer",
        expiresAt,
        status: "connected",
        state: null,
        errorMessage: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(connectorAuth.id, row.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(connectorAuth)
      .set({
        status: "error",
        errorMessage: message.slice(0, 1000),
        state: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(connectorAuth.id, row.id));
    throw error;
  }

  const updated = await getConnectorAuth(row.projectId, row.pluginId);
  return toPublic(updated!);
}

export async function refreshConnectorAccessToken(
  row: typeof connectorAuth.$inferSelect
): Promise<typeof connectorAuth.$inferSelect> {
  if (!row.refreshToken?.trim()) return row;
  const token = await exchangeToken({
    tokenUrl: row.tokenUrl,
    clientId: row.clientId,
    clientSecret: row.clientSecret,
    body: {
      grant_type: "refresh_token",
      refresh_token: row.refreshToken,
      client_id: row.clientId,
      client_secret: row.clientSecret,
    },
  });
  const expiresAt =
    typeof token.expires_in === "number"
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : row.expiresAt;
  const db = await getDb();
  await db
    .update(connectorAuth)
    .set({
      accessToken: token.access_token!,
      refreshToken: token.refresh_token ?? row.refreshToken,
      tokenType: token.token_type ?? row.tokenType,
      expiresAt,
      status: "connected",
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(connectorAuth.id, row.id));
  const updated = await getConnectorAuth(row.projectId, row.pluginId);
  return updated!;
}

function isExpiringSoon(expiresAt: string | null, skewMs = 60_000): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return false;
  return t <= Date.now() + skewMs;
}

/**
 * Resolve Bearer token for an MCP server bound via connector_auth.mcp_server_name.
 * Refreshes when near expiry.
 */
export async function resolveMcpOAuthHeaders(input: {
  projectId?: string;
  serverName: string;
}): Promise<Record<string, string>> {
  if (!input.projectId) return {};
  const db = await getDb();
  const rows = await db
    .select()
    .from(connectorAuth)
    .where(
      and(
        eq(connectorAuth.projectId, input.projectId),
        eq(connectorAuth.mcpServerName, input.serverName),
        eq(connectorAuth.status, "connected")
      )
    )
    .limit(1);
  let row = rows[0];
  if (!row?.accessToken) return {};
  if (isExpiringSoon(row.expiresAt) && row.refreshToken) {
    try {
      row = await refreshConnectorAccessToken(row);
    } catch {
      /* use existing token; call may still fail */
    }
  }
  if (!row.accessToken) return {};
  const type = (row.tokenType || "Bearer").trim() || "Bearer";
  return { Authorization: `${type} ${row.accessToken}` };
}

export async function disconnectConnectorAuth(input: {
  projectId: string;
  pluginId: string;
}): Promise<ConnectorAuthPublic | null> {
  const row = await getConnectorAuth(input.projectId, input.pluginId);
  if (!row) return null;
  const db = await getDb();
  await db
    .update(connectorAuth)
    .set({
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      state: null,
      status: "revoked",
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(connectorAuth.id, row.id));
  const updated = await getConnectorAuth(input.projectId, input.pluginId);
  return updated ? toPublic(updated) : null;
}
