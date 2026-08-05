import { Hono } from "hono";
import {
  beginOAuthAuthorize,
  completeOAuthCallback,
  defaultRedirectUri,
  disconnectConnectorAuth,
  getConnectorPreset,
  listConnectorAuthStatus,
  publicBaseUrl,
  upsertConnectorAuthConfig,
} from "../runtime/plugins/oauth-service";

export const pluginsOauthRouter = new Hono();

pluginsOauthRouter.get("/status", async (c) => {
  const projectId = c.req.query("projectId")?.trim();
  if (!projectId) return c.json({ error: "projectId required" }, 400);
  const data = await listConnectorAuthStatus(projectId);
  return c.json({ data });
});

pluginsOauthRouter.get("/presets/:pluginId", (c) => {
  const pluginId = decodeURIComponent(c.req.param("pluginId"));
  const preset = getConnectorPreset(pluginId);
  if (!preset) return c.json({ error: "unknown connector preset" }, 404);
  return c.json({
    data: {
      pluginId,
      ...preset,
      defaultRedirectUri: defaultRedirectUri(),
    },
  });
});

pluginsOauthRouter.post("/connections", async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    pluginId?: string;
    provider?: string;
    displayName?: string;
    clientId?: string;
    clientSecret?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    scopes?: string;
    redirectUri?: string;
    mcpServerName?: string | null;
  }>();
  const projectId = body.projectId?.trim();
  const pluginId = body.pluginId?.trim();
  const clientId = body.clientId?.trim();
  if (!projectId || !pluginId || !clientId) {
    return c.json({ error: "projectId, pluginId, clientId required" }, 400);
  }
  const preset = getConnectorPreset(pluginId);
  try {
    const data = await upsertConnectorAuthConfig({
      projectId,
      pluginId,
      clientId,
      authorizeUrl: (body.authorizeUrl ?? preset?.authorizeUrl ?? "").trim(),
      tokenUrl: (body.tokenUrl ?? preset?.tokenUrl ?? "").trim(),
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.displayName ? { displayName: body.displayName } : {}),
      ...(body.clientSecret !== undefined ? { clientSecret: body.clientSecret } : {}),
      ...(body.scopes !== undefined
        ? { scopes: body.scopes }
        : preset?.scopes
          ? { scopes: preset.scopes }
          : {}),
      ...(body.redirectUri ? { redirectUri: body.redirectUri } : {}),
      ...(body.mcpServerName !== undefined ? { mcpServerName: body.mcpServerName } : {}),
    });
    return c.json({ data }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

pluginsOauthRouter.get("/authorize", async (c) => {
  const projectId = c.req.query("projectId")?.trim();
  const pluginId = c.req.query("pluginId")?.trim();
  const redirect = c.req.query("redirect") === "1";
  if (!projectId || !pluginId) {
    return c.json({ error: "projectId and pluginId required" }, 400);
  }
  const origin = c.req.header("origin") ?? publicBaseUrl();
  try {
    const { authorizeUrl, state } = await beginOAuthAuthorize({
      projectId,
      pluginId,
      reqOrigin: origin,
    });
    if (redirect) return c.redirect(authorizeUrl, 302);
    return c.json({ data: { authorizeUrl, state } });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

pluginsOauthRouter.get("/callback", async (c) => {
  const code = c.req.query("code")?.trim();
  const state = c.req.query("state")?.trim();
  const err = c.req.query("error")?.trim();
  const errDesc = c.req.query("error_description")?.trim();
  if (err) {
    return c.html(
      `<!doctype html><html><body style="font-family:system-ui;padding:24px">
        <h2>OAuth 失败</h2>
        <p>${escapeHtml(errDesc || err)}</p>
        <p>可以关闭此窗口，回到 Qubit 插件页重试。</p>
      </body></html>`,
      400
    );
  }
  if (!code || !state) {
    return c.html(
      `<!doctype html><html><body style="font-family:system-ui;padding:24px">
        <h2>OAuth 回调缺少 code/state</h2>
      </body></html>`,
      400
    );
  }
  try {
    const data = await completeOAuthCallback({ code, state });
    return c.html(
      `<!doctype html><html><body style="font-family:system-ui;padding:24px">
        <h2>已连接：${escapeHtml(data.displayName || data.pluginId)}</h2>
        <p>状态：${escapeHtml(data.status)}。可以关闭此窗口，回到 Qubit「插件」页刷新。</p>
        <script>try{window.opener&&window.opener.postMessage({type:'qubit-oauth',status:'connected',pluginId:${JSON.stringify(data.pluginId)}},'*')}catch(e){}</script>
      </body></html>`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.html(
      `<!doctype html><html><body style="font-family:system-ui;padding:24px">
        <h2>换取 token 失败</h2>
        <p>${escapeHtml(message)}</p>
      </body></html>`,
      400
    );
  }
});

pluginsOauthRouter.delete("/connections/:pluginId", async (c) => {
  const pluginId = decodeURIComponent(c.req.param("pluginId"));
  const projectId = c.req.query("projectId")?.trim();
  if (!projectId) return c.json({ error: "projectId required" }, 400);
  const data = await disconnectConnectorAuth({ projectId, pluginId });
  if (!data) return c.json({ error: "connection not found" }, 404);
  return c.json({ data });
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
