import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessRouter } from "../../routes/harness.routes";
import { CapabilityRegistry } from "./capability-registry";
import {
  type DeclarativeHarnessPackage,
  canonicalHarnessPackagePayload,
  getActiveHarnessPackageProfiles,
  hashHarnessPackage,
  installHarnessPackage,
  listHarnessPackageVersions,
  listHarnessProfileActivationHistory,
  listInstalledHarnessPackages,
  loadVerifiedHarnessPackages,
  refreshHarnessPackageRuntime,
  registerDeclarativeHarnessPackage,
  rollbackHarnessPackage,
  setActiveHarnessPackageProfiles,
  uninstallHarnessPackage,
  verifyHarnessPackage,
} from "./package-manager";
import { buildHarnessToolSurfaceShadow } from "./shadow-tool-surface";

const dataDir = await mkdtemp(join(tmpdir(), "qubit-harness-package-"));
const keyPair = generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function signedPackage(version = "1.0.0"): DeclarativeHarnessPackage {
  const pack: DeclarativeHarnessPackage = {
    schemaVersion: 1,
    id: "example.research-tools",
    version,
    title: "Example research tools",
    description: "A signed declarative package for Harness tests.",
    capabilities: [
      {
        id: "example.research-tools.sentiment",
        version,
        title: "Example sentiment",
        kind: "research",
        description: "Exposes a review-only sentiment tool.",
        tools: [{ name: "example.sentiment.get", mode: "read" }],
      },
    ],
    profiles: [
      {
        id: "example.research-tools.default",
        title: "Example research",
        description: "Loads the signed example capability.",
        enable: ["example.research-tools.sentiment"],
      },
    ],
    integrity: { algorithm: "sha256", digest: "0".repeat(64) },
    signature: { algorithm: "ed25519", keyId: "test-root", value: "pending" },
  };
  pack.integrity.digest = hashHarnessPackage(pack);
  return resignPackage(pack);
}

function resignPackage(pack: DeclarativeHarnessPackage): DeclarativeHarnessPackage {
  pack.integrity.digest = hashHarnessPackage(pack);
  pack.signature.value = sign(
    null,
    Buffer.from(canonicalHarnessPackagePayload(pack), "utf-8"),
    keyPair.privateKey
  ).toString("base64");
  return pack;
}

function first<T>(items: readonly T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error("test fixture expected at least one item");
  return value;
}

describe("declarative Harness package manager", () => {
  test("verifies a trusted Ed25519 package with a stable content digest", () => {
    const pack = signedPackage();
    expect(verifyHarnessPackage(pack, { "test-root": publicKey })).toEqual({
      ok: true,
      digest: pack.integrity.digest,
      keyId: "test-root",
    });
  });

  test("rejects package tampering after it has been signed", () => {
    const pack = signedPackage();
    pack.description = "Tampered package";
    expect(verifyHarnessPackage(pack, { "test-root": publicKey })).toMatchObject({
      ok: false,
      code: "integrity_mismatch",
    });
  });

  test("rejects a package signed by an operator-revoked key", () => {
    const pack = signedPackage();
    expect(
      verifyHarnessPackage(
        pack,
        { "test-root": publicKey },
        { revokedKeyIds: new Set(["test-root"]) }
      )
    ).toMatchObject({
      ok: false,
      code: "signer_revoked",
    });
  });

  test("rejects a package profile which reaches into a Core capability namespace", () => {
    const pack = signedPackage();
    first(pack.profiles).enable = ["market.core"];
    resignPackage(pack);
    expect(verifyHarnessPackage(pack, { "test-root": publicKey })).toMatchObject({
      ok: false,
      code: "manifest_invalid",
    });
  });

  test("persists a version lock and replaces a package id atomically on upgrade", async () => {
    const first = signedPackage("1.0.0");
    const second = signedPackage("1.1.0");
    await installHarnessPackage({
      package: first,
      trustedKeys: { "test-root": publicKey },
      dataDir,
      now: new Date("2026-08-20T00:00:00.000Z"),
    });
    const record = await installHarnessPackage({
      package: second,
      trustedKeys: { "test-root": publicKey },
      dataDir,
      now: new Date("2026-08-20T00:01:00.000Z"),
    });
    expect(record).toMatchObject({ packageId: "example.research-tools", version: "1.1.0" });
    expect(await listInstalledHarnessPackages(dataDir)).toEqual([record]);
  });

  test("loads a verified package as ordinary declarative Kernel capabilities", async () => {
    const packageDataDir = await mkdtemp(join(tmpdir(), "qubit-harness-package-load-"));
    try {
      const pack = signedPackage("1.3.0");
      await installHarnessPackage({
        package: pack,
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      const registry = new CapabilityRegistry();
      const outcome = await loadVerifiedHarnessPackages({
        registry,
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      expect(outcome.loaded).toHaveLength(1);
      expect(outcome.rejected).toEqual([]);
      expect(registry.resolve("example.research-tools.default").tools).toEqual([
        { name: "example.sentiment.get", mode: "read" },
      ]);

      const directRegistry = new CapabilityRegistry();
      registerDeclarativeHarnessPackage(directRegistry, pack);
      expect(directRegistry.resolve("example.research-tools.default").capabilityIds).toEqual([
        "example.research-tools.sentiment",
      ]);
    } finally {
      await rm(packageDataDir, { recursive: true, force: true });
      await refreshHarnessPackageRuntime({
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
    }
  });

  test("keeps trusted package profiles inert until explicitly activated", async () => {
    const packageDataDir = await mkdtemp(join(tmpdir(), "qubit-harness-package-active-"));
    try {
      const pack = signedPackage("1.4.0");
      await installHarnessPackage({
        package: pack,
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      expect(
        (
          await refreshHarnessPackageRuntime({
            trustedKeys: { "test-root": publicKey },
            dataDir: packageDataDir,
          })
        ).activeProfileIds
      ).toEqual([]);
      await setActiveHarnessPackageProfiles({
        profileIds: ["example.research-tools.default"],
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      expect(getActiveHarnessPackageProfiles()).toEqual(["example.research-tools.default"]);
      expect(
        (
          await refreshHarnessPackageRuntime({
            trustedKeys: { "test-root": publicKey },
            dataDir: packageDataDir,
          })
        ).activation
      ).toMatchObject({
        schemaVersion: 1,
        profileIds: ["example.research-tools.default"],
        revision: 1,
      });
    } finally {
      await rm(packageDataDir, { recursive: true, force: true });
      await refreshHarnessPackageRuntime({
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
    }
  });

  test("persists a selected built-in financial Profile without requiring a package", async () => {
    const packageDataDir = await mkdtemp(join(tmpdir(), "qubit-harness-system-profile-"));
    try {
      const state = await setActiveHarnessPackageProfiles({
        profileIds: ["us-options-research"],
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      expect(state.activation).toMatchObject({
        profileIds: ["us-options-research"],
        revision: 1,
      });
      expect(
        (
          await refreshHarnessPackageRuntime({
            trustedKeys: { "test-root": publicKey },
            dataDir: packageDataDir,
          })
        ).activeProfileIds
      ).toEqual(["us-options-research"]);
    } finally {
      await rm(packageDataDir, { recursive: true, force: true });
      await refreshHarnessPackageRuntime({
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
    }
  });

  test("validates Profile parameters and keeps an activation audit trail", async () => {
    const pack = signedPackage("1.3.0");
    first(pack.profiles).parameters = {
      refresh_seconds: { type: "number", title: "刷新间隔", default: 30 },
      market: { type: "enum", title: "市场", values: ["US", "CN"], default: "US" },
    };
    resignPackage(pack);
    await installHarnessPackage({
      package: pack,
      trustedKeys: { "test-root": publicKey },
      dataDir,
    });
    const profileId = first(pack.profiles).id;
    const state = await setActiveHarnessPackageProfiles({
      profileIds: [profileId],
      parameterOverrides: { [profileId]: { refresh_seconds: 15, market: "CN" } },
      trustedKeys: { "test-root": publicKey },
      dataDir,
    });
    expect(state.activation.parameterOverrides[profileId]).toEqual({
      refresh_seconds: 15,
      market: "CN",
    });
    await expect(
      setActiveHarnessPackageProfiles({
        profileIds: [profileId],
        parameterOverrides: { [profileId]: { market: "HK" } },
        trustedKeys: { "test-root": publicKey },
        dataDir,
      })
    ).rejects.toMatchObject({ code: "profile_parameters_invalid" });
    const history = await listHarnessProfileActivationHistory(dataDir);
    expect(history.some((entry) => entry.profileIds.includes(profileId))).toBe(true);
  });

  test("retains trusted historical versions and rolls the active lock back atomically", async () => {
    const packageDataDir = await mkdtemp(join(tmpdir(), "qubit-harness-package-rollback-"));
    try {
      await installHarnessPackage({
        package: signedPackage("1.0.0"),
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      await installHarnessPackage({
        package: signedPackage("1.2.0"),
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      expect(
        (
          await listHarnessPackageVersions({
            packageId: "example.research-tools",
            trustedKeys: { "test-root": publicKey },
            dataDir: packageDataDir,
          })
        ).map((item) => [item.version, item.current])
      ).toEqual([
        ["1.2.0", true],
        ["1.0.0", false],
      ]);

      const rolledBack = await rollbackHarnessPackage({
        packageId: "example.research-tools",
        version: "1.0.0",
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      expect(rolledBack.version).toBe("1.0.0");
      expect(await listInstalledHarnessPackages(packageDataDir)).toEqual([rolledBack]);
    } finally {
      await rm(packageDataDir, { recursive: true, force: true });
    }
  });

  test("uninstall deactivates only that package and retains signed versions for later recovery", async () => {
    const packageDataDir = await mkdtemp(join(tmpdir(), "qubit-harness-package-uninstall-"));
    try {
      await installHarnessPackage({
        package: signedPackage("1.5.0"),
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      await setActiveHarnessPackageProfiles({
        profileIds: ["example.research-tools.default"],
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      await uninstallHarnessPackage({
        packageId: "example.research-tools",
        dataDir: packageDataDir,
      });
      expect(await listInstalledHarnessPackages(packageDataDir)).toEqual([]);
      expect(
        await listHarnessPackageVersions({
          packageId: "example.research-tools",
          trustedKeys: { "test-root": publicKey },
          dataDir: packageDataDir,
        })
      ).toMatchObject([{ version: "1.5.0", current: false }]);
      expect(
        (
          await refreshHarnessPackageRuntime({
            trustedKeys: { "test-root": publicKey },
            dataDir: packageDataDir,
          })
        ).activeProfileIds
      ).toEqual([]);
    } finally {
      await rm(packageDataDir, { recursive: true, force: true });
      await refreshHarnessPackageRuntime({
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
    }
  });

  test("degrades an invalid active package composition back to the legacy Agent surface", async () => {
    const packageDataDir = await mkdtemp(join(tmpdir(), "qubit-harness-package-fallback-"));
    try {
      const pack = signedPackage("1.6.0");
      first(pack.capabilities).conflictsWith = ["example.research-tools.conflicting"];
      pack.capabilities.push({
        id: "example.research-tools.conflicting",
        version: "1.6.0",
        title: "Conflicting test capability",
        kind: "research",
        description: "For Agent availability fallback coverage.",
      });
      first(pack.profiles).enable = [
        "example.research-tools.sentiment",
        "example.research-tools.conflicting",
      ];
      resignPackage(pack);
      await installHarnessPackage({
        package: pack,
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      await setActiveHarnessPackageProfiles({
        profileIds: ["example.research-tools.default"],
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
      const shadow = buildHarnessToolSurfaceShadow({
        role: "risk",
        legacyTools: ["evaluate_risk"],
      });
      expect(shadow.legacyTools).toEqual(["evaluate_risk"]);
      expect(shadow.profileIds).toEqual([]);
      expect(shadow.unavailableProfileIds).toEqual(["example.research-tools.default"]);
      expect(shadow.availabilityWarning).toContain("cannot be composed");
    } finally {
      await rm(packageDataDir, { recursive: true, force: true });
      await refreshHarnessPackageRuntime({
        trustedKeys: { "test-root": publicKey },
        dataDir: packageDataDir,
      });
    }
  });

  test("exposes trusted verification through the package API without accepting request-supplied keys", async () => {
    const original = process.env.QUBIT_HARNESS_TRUSTED_KEYS_JSON;
    process.env.QUBIT_HARNESS_TRUSTED_KEYS_JSON = JSON.stringify({ "test-root": publicKey });
    try {
      const response = await harnessRouter.request("http://qubit.test/packages/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ package: signedPackage("1.2.0") }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { ok: true, keyId: "test-root" } });
    } finally {
      if (original === undefined) process.env.QUBIT_HARNESS_TRUSTED_KEYS_JSON = undefined;
      else process.env.QUBIT_HARNESS_TRUSTED_KEYS_JSON = original;
    }
  });
});
