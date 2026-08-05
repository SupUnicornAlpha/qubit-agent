import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import { project, workspace } from "../../../db/sqlite/schema";
import {
  beginOAuthAuthorize,
  defaultRedirectUri,
  disconnectConnectorAuth,
  getConnectorPreset,
  listConnectorAuthStatus,
  upsertConnectorAuthConfig,
} from "../oauth-service";
import {
  GENERIC_OAUTH_PLUGIN_ID,
  GITHUB_CONNECTOR_PLUGIN_ID,
  listOfficialPluginPacks,
} from "../official-packs";

describe("oauth presets and official connector packs", () => {
  test("github + generic packs are listed", () => {
    const packs = listOfficialPluginPacks();
    expect(packs.some((p) => p.id === GITHUB_CONNECTOR_PLUGIN_ID)).toBe(true);
    expect(packs.some((p) => p.id === GENERIC_OAUTH_PLUGIN_ID)).toBe(true);
    expect(packs.find((p) => p.id === GITHUB_CONNECTOR_PLUGIN_ID)?.auth?.type).toBe("oauth2");
  });

  test("getConnectorPreset fills GitHub URLs", () => {
    const p = getConnectorPreset(GITHUB_CONNECTOR_PLUGIN_ID);
    expect(p?.authorizeUrl).toContain("github.com");
    expect(p?.tokenUrl).toContain("access_token");
  });

  test("defaultRedirectUri points at oauth callback", () => {
    expect(defaultRedirectUri("http://localhost:3000")).toBe(
      "http://localhost:3000/api/v1/plugins/oauth/callback"
    );
  });
});

describe("connector_auth persistence", () => {
  const wsId = `ws-oauth-${randomUUID().slice(0, 8)}`;
  const projectId = `proj-oauth-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    process.env.QUBIT_DATA_DIR = `/tmp/qubit-oauth-${Date.now()}`;
    await runMigrations();
    const db = await getDb();
    await db.insert(workspace).values({ id: wsId, name: "oauth-ws", owner: "test" });
    await db.insert(project).values({
      id: projectId,
      workspaceId: wsId,
      name: "oauth-proj",
      marketScope: "US",
    });
  });

  test("upsert + authorize begin + disconnect", async () => {
    const pub = await upsertConnectorAuthConfig({
      projectId,
      pluginId: GITHUB_CONNECTOR_PLUGIN_ID,
      clientId: "cid",
      clientSecret: "csecret",
      authorizeUrl: "",
      tokenUrl: "",
      mcpServerName: "github-mcp",
    });
    expect(pub.clientId).toBe("cid");
    expect(pub.authorizeUrl).toContain("github.com");
    expect(pub.hasClientSecret).toBe(true);
    expect(pub.connected).toBe(false);

    const { authorizeUrl, state } = await beginOAuthAuthorize({
      projectId,
      pluginId: GITHUB_CONNECTOR_PLUGIN_ID,
    });
    expect(authorizeUrl).toContain("client_id=cid");
    expect(authorizeUrl).toContain(`state=${state}`);
    expect(state.length).toBeGreaterThan(10);

    const statuses = await listConnectorAuthStatus(projectId);
    expect(statuses.some((s) => s.pluginId === GITHUB_CONNECTOR_PLUGIN_ID)).toBe(true);

    const disconnected = await disconnectConnectorAuth({
      projectId,
      pluginId: GITHUB_CONNECTOR_PLUGIN_ID,
    });
    expect(disconnected?.status).toBe("revoked");
    expect(disconnected?.connected).toBe(false);
  });

  test("generic oauth requires explicit urls", async () => {
    await expect(
      upsertConnectorAuthConfig({
        projectId,
        pluginId: GENERIC_OAUTH_PLUGIN_ID,
        clientId: "x",
        authorizeUrl: "",
        tokenUrl: "",
      })
    ).rejects.toThrow(/authorizeUrl and tokenUrl/);
  });
});
