import { type Context, Hono } from "hono";
import { listRecentHarnessEvents, projectHarnessTrace } from "../runtime/harness/event-ledger";
import { listHarnessProfileHealth } from "../runtime/harness/health";
import {
  type DeclarativeHarnessPackage,
  HarnessPackageInstallError,
  getHarnessProfileActivation,
  installHarnessPackage,
  listHarnessMarketplaceCatalog,
  listHarnessPackageVersions,
  listHarnessProfileActivationHistory,
  listInstalledHarnessPackages,
  refreshHarnessPackageRuntime,
  revokedHarnessKeyIdsFromEnv,
  rollbackHarnessPackage,
  setActiveHarnessPackageProfiles,
  trustedHarnessKeysFromEnv,
  uninstallHarnessPackage,
  verifyHarnessPackage,
} from "../runtime/harness/package-manager";
import { builtinFinancialProfiles } from "../runtime/harness/system-profiles";

/**
 * Package-management API for declarative Harness capabilities.
 *
 * It accepts a JSON package object rather than a file path or executable
 * bundle. This keeps installation auditable and prevents a plugin import from
 * becoming an arbitrary local-code execution primitive.
 */
export const harnessRouter = new Hono();

harnessRouter.get("/packages", async (c) => {
  return c.json({ data: await listInstalledHarnessPackages() });
});

harnessRouter.get("/marketplace", async (c) => {
  const entries = await listHarnessMarketplaceCatalog();
  return c.json({
    data: entries.map((entry) => ({
      id: entry.package.id,
      version: entry.package.version,
      title: entry.package.title,
      description: entry.package.description,
      verification: entry.verification,
    })),
  });
});

harnessRouter.get("/packages/:packageId/versions", async (c) => {
  try {
    return c.json({
      data: await listHarnessPackageVersions({ packageId: c.req.param("packageId") }),
    });
  } catch (error) {
    if (error instanceof HarnessPackageInstallError) {
      return c.json({ ok: false, error: error.message, code: error.code }, 400);
    }
    throw error;
  }
});

harnessRouter.get("/profiles", async (c) => {
  const state = await refreshHarnessPackageRuntime();
  const resolverAllowlist = new Set(
    (process.env.QUBIT_HARNESS_RESOLVER_PROFILES ?? "")
      .split(",")
      .map((profileId) => profileId.trim())
      .filter(Boolean)
  );
  return c.json({
    data: {
      activeProfileIds: state.activeProfileIds,
      activation: getHarnessProfileActivation(),
      available: [
        ...builtinFinancialProfiles.map((profile) => ({
          id: profile.id,
          title: profile.title,
          description: profile.description,
          source: "system" as const,
          packageId: "builtin:financial",
          packageVersion: "1.0.0",
          resolverAllowlisted: resolverAllowlist.has(profile.id),
          parameters: Object.entries(profile.parameters ?? {}).map(([id, parameter]) => ({
            id,
            type: parameter.type,
            title: parameter.title,
            description: parameter.description,
            ...(parameter.default !== undefined ? { default: parameter.default } : {}),
            ...(parameter.values ? { values: [...parameter.values] } : {}),
          })),
        })),
        ...state.packages.flatMap((pkg) =>
          pkg.profiles.map((profile) => ({
            id: profile.id,
            title: profile.title,
            description: profile.description,
            source: "package" as const,
            packageId: pkg.id,
            packageVersion: pkg.version,
            resolverAllowlisted: resolverAllowlist.has(profile.id),
            parameters: Object.entries(profile.parameters ?? {}).map(([id, parameter]) => ({
              id,
              type: parameter.type,
              title: parameter.title,
              description: parameter.description,
              ...(parameter.default !== undefined ? { default: parameter.default } : {}),
              ...(parameter.values ? { values: [...parameter.values] } : {}),
            })),
          }))
        ),
      ],
      rejected: state.rejected,
    },
  });
});

harnessRouter.get("/profiles/export", async (c) => {
  await refreshHarnessPackageRuntime();
  return c.json({
    data: {
      ...getHarnessProfileActivation(),
      exportedAt: new Date().toISOString(),
    },
  });
});

harnessRouter.get("/profiles/history", async (c) => {
  return c.json({ data: await listHarnessProfileActivationHistory() });
});

/** Exposes key identifiers only; public key material and secrets never leave the server. */
harnessRouter.get("/trust", (c) => {
  const trusted = trustedHarnessKeysFromEnv();
  return c.json({
    data: {
      trustedKeyIds: Object.keys(trusted).sort(),
      revokedKeyIds: [...revokedHarnessKeyIdsFromEnv()].sort(),
      keyRotationSupported: true,
    },
  });
});

harnessRouter.get("/health", async (c) => {
  const events = await listRecentHarnessEvents(100).catch(() => []);
  const projection = projectHarnessTrace(events);
  return c.json({
    data: {
      profiles: listHarnessProfileHealth(),
      recentDegradations: projection.summary.degraded,
      fallbackPolicy: "legacy-tool-surface",
    },
  });
});

harnessRouter.post("/packages/verify", async (c) => {
  const pkg = await readPackage(c);
  if (!pkg) return c.json({ ok: false, error: "package JSON is required" }, 400);
  const result = verifyHarnessPackage(pkg, trustedHarnessKeysFromEnv());
  // A signer is never accepted from the request body: only the server's
  // operator-configured trust roots participate in verification.
  return c.json({ data: result });
});

harnessRouter.post("/packages/install", async (c) => {
  const pkg = await readPackage(c);
  if (!pkg) return c.json({ ok: false, error: "package JSON is required" }, 400);
  try {
    const record = await installHarnessPackage({ package: pkg });
    await refreshHarnessPackageRuntime();
    return c.json({ data: record }, 201);
  } catch (error) {
    if (error instanceof HarnessPackageInstallError) {
      return c.json({ ok: false, error: error.message, code: error.code }, 400);
    }
    throw error;
  }
});

harnessRouter.post("/packages/:packageId/rollback", async (c) => {
  try {
    const body = (await c.req.json()) as { version?: unknown };
    if (typeof body.version !== "string") {
      return c.json({ ok: false, error: "version is required" }, 400);
    }
    const record = await rollbackHarnessPackage({
      packageId: c.req.param("packageId"),
      version: body.version,
    });
    await refreshHarnessPackageRuntime();
    return c.json({ data: record });
  } catch (error) {
    if (error instanceof HarnessPackageInstallError) {
      return c.json({ ok: false, error: error.message, code: error.code }, 400);
    }
    throw error;
  }
});

harnessRouter.delete("/packages/:packageId", async (c) => {
  try {
    const record = await uninstallHarnessPackage({ packageId: c.req.param("packageId") });
    await refreshHarnessPackageRuntime();
    return c.json({ data: record });
  } catch (error) {
    if (error instanceof HarnessPackageInstallError) {
      return c.json({ ok: false, error: error.message, code: error.code }, 400);
    }
    throw error;
  }
});

harnessRouter.put("/profiles", async (c) => {
  try {
    const body = (await c.req.json()) as { profileIds?: unknown; parameterOverrides?: unknown };
    if (
      !Array.isArray(body.profileIds) ||
      !body.profileIds.every((value) => typeof value === "string")
    ) {
      return c.json({ ok: false, error: "profileIds must be an array of strings" }, 400);
    }
    const state = await setActiveHarnessPackageProfiles({
      profileIds: body.profileIds,
      ...(body.parameterOverrides !== undefined
        ? {
            parameterOverrides: body.parameterOverrides as Record<string, Record<string, unknown>>,
          }
        : {}),
    });
    return c.json({
      data: { activeProfileIds: state.activeProfileIds, activation: state.activation },
    });
  } catch (error) {
    if (error instanceof HarnessPackageInstallError) {
      return c.json({ ok: false, error: error.message, code: error.code }, 400);
    }
    throw error;
  }
});

harnessRouter.post("/profiles/import", async (c) => {
  try {
    const body = (await c.req.json()) as { activation?: Record<string, unknown> };
    const activation = body.activation;
    if (
      !activation ||
      activation.schemaVersion !== 1 ||
      !Array.isArray(activation.profileIds) ||
      !activation.profileIds.every((value) => typeof value === "string")
    ) {
      return c.json(
        { ok: false, error: "activation.schemaVersion=1 and string profileIds are required" },
        400
      );
    }
    const state = await setActiveHarnessPackageProfiles({
      profileIds: activation.profileIds,
      ...(activation.parameterOverrides !== undefined
        ? {
            parameterOverrides: activation.parameterOverrides as Record<
              string,
              Record<string, unknown>
            >,
          }
        : {}),
    });
    return c.json({
      data: { activeProfileIds: state.activeProfileIds, activation: state.activation },
    });
  } catch (error) {
    if (error instanceof HarnessPackageInstallError) {
      return c.json({ ok: false, error: error.message, code: error.code }, 400);
    }
    throw error;
  }
});

/**
 * A compact, already-redacted view for configuration UI. Detailed workflow
 * trace access remains in the workflow monitor; package management only needs
 * enough history to explain whether a composed capability was admitted or
 * rejected recently.
 */
harnessRouter.get("/events/recent", async (c) => {
  const rawLimit = Number(c.req.query("limit") ?? "20");
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 20;
  // A pre-migration deployment must not make package/Profile management fail.
  const events = await listRecentHarnessEvents(limit).catch(() => []);
  const projection = projectHarnessTrace(events);
  return c.json({
    data: {
      summary: projection.summary,
      events: events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        workflowRunId: event.workflowRunId,
        profileId: event.profileId,
        capabilityId: event.capabilityId,
        toolCallId: event.toolCallId,
        status: typeof event.payload.status === "string" ? event.payload.status : null,
        createdAt: event.createdAt,
      })),
    },
  });
});

async function readPackage(c: Context): Promise<DeclarativeHarnessPackage | null> {
  try {
    const body = (await c.req.json()) as { package?: unknown };
    if (!body?.package || typeof body.package !== "object" || Array.isArray(body.package))
      return null;
    return body.package as DeclarativeHarnessPackage;
  } catch {
    return null;
  }
}
