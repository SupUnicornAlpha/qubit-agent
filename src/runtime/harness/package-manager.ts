/**
 * Declarative Harness package verifier and local lockfile store.
 *
 * Packages deliberately contain manifests/profiles only in this phase. They
 * cannot ship arbitrary executable code, register a Core handler, or widen a
 * provider permission merely by being installed. Code-bearing adapters will
 * require a future reviewed runner format on top of this trust boundary.
 */
import { createHash, verify } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { getDataDir } from "../agent/agent-pack-service";
import { CapabilityRegistry } from "./capability-registry";
import type { CapabilityManifest, CapabilityProfile, CapabilityProfileParameter } from "./types";

const PACKAGE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CAPABILITY_KINDS = new Set([
  "market-data",
  "research",
  "execution",
  "risk",
  "memory",
  "observability",
  "document",
  "data",
  "browser",
  "developer",
  "integration",
]);
const EXTENSION_KINDS = new Set(["mcp", "skill", "connector", "exec-provider"]);

export type HarnessPackageSignature = {
  algorithm: "ed25519";
  keyId: string;
  value: string;
};

export type HarnessPackageIntegrity = {
  algorithm: "sha256";
  /** Lowercase hexadecimal digest of the canonical unsigned package payload. */
  digest: string;
};

export type DeclarativeHarnessPackage = {
  schemaVersion: 1;
  id: string;
  version: string;
  title: string;
  description: string;
  capabilities: CapabilityManifest[];
  profiles: CapabilityProfile[];
  /** Dependencies are metadata-only; package code cannot be transitively loaded. */
  dependencies?: Array<{ packageId: string; version: string }>;
  integrity: HarnessPackageIntegrity;
  signature: HarnessPackageSignature;
};

export type HarnessPackageLockRecord = {
  packageId: string;
  version: string;
  digest: string;
  keyId: string;
  installedAt: string;
};

export type HarnessPackageVersionRecord = {
  packageId: string;
  version: string;
  digest: string;
  keyId: string;
  /** The version currently referenced from the lockfile. */
  current: boolean;
};

export type HarnessPackageVerification =
  | { ok: true; digest: string; keyId: string }
  | { ok: false; code: string; message: string };

export type HarnessMarketplaceEntry = {
  package: DeclarativeHarnessPackage;
  verification: HarnessPackageVerification;
};

export type HarnessPackageRuntimeState = {
  packages: DeclarativeHarnessPackage[];
  activeProfileIds: string[];
  activation: HarnessProfileActivation;
  rejected: Array<{ packageId: string; reason: string }>;
};

export type HarnessProfileActivation = {
  schemaVersion: 1;
  profileIds: string[];
  /** Non-secret per-profile values validated against the signed manifest. */
  parameterOverrides: Record<string, Record<string, string | number | boolean>>;
  revision: number;
  updatedAt: string | null;
};

export type HarnessProfileActivationAudit = {
  revision: number;
  changedAt: string;
  source: "api" | "package-uninstall";
  previousProfileIds: string[];
  profileIds: string[];
  changedParameterProfiles: string[];
};

let runtimeState: HarnessPackageRuntimeState = {
  packages: [],
  activeProfileIds: [],
  activation: {
    schemaVersion: 1,
    profileIds: [],
    parameterOverrides: {},
    revision: 0,
    updatedAt: null,
  },
  rejected: [],
};

export function canonicalHarnessPackagePayload(input: DeclarativeHarnessPackage): string {
  const { integrity: _integrity, signature: _signature, ...unsigned } = input;
  return stableJson(unsigned);
}

export function hashHarnessPackage(input: DeclarativeHarnessPackage): string {
  return createHash("sha256").update(canonicalHarnessPackagePayload(input)).digest("hex");
}

export function trustedHarnessKeysFromEnv(
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const raw = env.QUBIT_HARNESS_TRUSTED_KEYS_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
}

/**
 * Key revocation is intentionally independent from the trusted-key map so an
 * operator can invalidate a compromised signer immediately without editing
 * every installed lock record. The value is a comma-separated list of key IDs.
 */
export function revokedHarnessKeyIdsFromEnv(
  env: Record<string, string | undefined> = process.env
): Set<string> {
  return new Set(
    (env.QUBIT_HARNESS_REVOKED_KEY_IDS ?? "")
      .split(",")
      .map((keyId) => keyId.trim())
      .filter(Boolean)
  );
}

export function verifyHarnessPackage(
  input: DeclarativeHarnessPackage,
  trustedKeys: Readonly<Record<string, string>>,
  options?: { revokedKeyIds?: ReadonlySet<string> }
): HarnessPackageVerification {
  const structural = validateHarnessPackage(input);
  if (structural) return structural;
  const digest = hashHarnessPackage(input);
  if (digest !== input.integrity.digest) {
    return {
      ok: false,
      code: "integrity_mismatch",
      message: `sha256 mismatch for ${input.id}@${input.version}`,
    };
  }
  const revokedKeyIds = options?.revokedKeyIds ?? revokedHarnessKeyIdsFromEnv();
  if (revokedKeyIds.has(input.signature.keyId)) {
    return {
      ok: false,
      code: "signer_revoked",
      message: `Ed25519 signer "${input.signature.keyId}" is revoked by operator policy`,
    };
  }
  const publicKey = trustedKeys[input.signature.keyId];
  if (!publicKey) {
    return {
      ok: false,
      code: "untrusted_signer",
      message: `No trusted Ed25519 key for keyId "${input.signature.keyId}"`,
    };
  }
  try {
    const valid = verify(
      null,
      Buffer.from(canonicalHarnessPackagePayload(input), "utf-8"),
      publicKey,
      Buffer.from(input.signature.value, "base64")
    );
    return valid
      ? { ok: true, digest, keyId: input.signature.keyId }
      : {
          ok: false,
          code: "signature_invalid",
          message: "Ed25519 package signature did not verify",
        };
  } catch (error) {
    return {
      ok: false,
      code: "signature_invalid",
      message: `Could not verify package signature: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function installHarnessPackage(input: {
  package: DeclarativeHarnessPackage;
  trustedKeys?: Readonly<Record<string, string>>;
  dataDir?: string;
  now?: Date;
}): Promise<HarnessPackageLockRecord> {
  const verification = verifyHarnessPackage(
    input.package,
    input.trustedKeys ?? trustedHarnessKeysFromEnv()
  );
  if (!verification.ok)
    throw new HarnessPackageInstallError(verification.code, verification.message);

  const root = resolve(input.dataDir ?? getDataDir(), "harness-packages");
  const lockPath = resolve(root, "lock.json");
  const previous = await readLock(lockPath);
  const missingDependencies = (input.package.dependencies ?? []).filter(
    (dependency) =>
      !previous.some(
        (record) =>
          record.packageId === dependency.packageId && record.version === dependency.version
      )
  );
  if (missingDependencies.length > 0) {
    throw new HarnessPackageInstallError(
      "dependency_unavailable",
      `Required package versions are not installed: ${missingDependencies
        .map((dependency) => `${dependency.packageId}@${dependency.version}`)
        .join(", ")}`
    );
  }
  const packagePath = resolve(root, "packages", input.package.id, `${input.package.version}.json`);
  ensureUnderRoot(root, packagePath);
  await mkdir(dirname(packagePath), { recursive: true });
  await atomicWrite(packagePath, `${JSON.stringify(input.package, null, 2)}\n`);

  const record: HarnessPackageLockRecord = {
    packageId: input.package.id,
    version: input.package.version,
    digest: verification.digest,
    keyId: verification.keyId,
    installedAt: (input.now ?? new Date()).toISOString(),
  };
  const lock = previous.filter((item) => item.packageId !== record.packageId);
  lock.push(record);
  lock.sort((a, b) => a.packageId.localeCompare(b.packageId));
  await atomicWrite(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return record;
}

export async function listInstalledHarnessPackages(
  dataDir: string = getDataDir()
): Promise<HarnessPackageLockRecord[]> {
  return readLock(resolve(dataDir, "harness-packages", "lock.json"));
}

/**
 * Read-only marketplace catalogue. Fetching is deliberately outside the Core:
 * an operator syncs a signed JSON catalogue into the data directory (or sets
 * QUBIT_HARNESS_MARKETPLACE_CATALOG_PATH). Each entry is verified again before
 * it is displayed, so the UI never treats the catalogue as a trust root.
 */
export async function listHarnessMarketplaceCatalog(input?: {
  dataDir?: string;
  path?: string;
  trustedKeys?: Readonly<Record<string, string>>;
}): Promise<HarnessMarketplaceEntry[]> {
  const dataDir = input?.dataDir ?? getDataDir();
  const root = resolve(dataDir, "harness-packages");
  const path =
    input?.path ??
    process.env.QUBIT_HARNESS_MARKETPLACE_CATALOG_PATH ??
    resolve(root, "marketplace.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    const packages = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { packages?: unknown }).packages)
        ? (parsed as { packages: unknown[] }).packages
        : [];
    return packages
      .filter((value): value is DeclarativeHarnessPackage =>
        Boolean(value && typeof value === "object")
      )
      .map((pkg) => ({
        package: pkg,
        verification: verifyHarnessPackage(pkg, input?.trustedKeys ?? trustedHarnessKeysFromEnv()),
      }));
  } catch {
    return [];
  }
}

/**
 * Installed package payloads are retained by version. This makes rollback a
 * lockfile operation rather than a re-download and keeps the signed bytes
 * that were previously admitted available for inspection.
 */
export async function listHarnessPackageVersions(input: {
  packageId: string;
  trustedKeys?: Readonly<Record<string, string>>;
  dataDir?: string;
}): Promise<HarnessPackageVersionRecord[]> {
  if (!PACKAGE_ID.test(input.packageId)) {
    throw new HarnessPackageInstallError("package_id_invalid", "Package id is invalid");
  }
  const dataDir = input.dataDir ?? getDataDir();
  const root = resolve(dataDir, "harness-packages");
  const packageDir = resolve(root, "packages", input.packageId);
  ensureUnderRoot(root, packageDir);
  const lock = await readLock(resolve(root, "lock.json"));
  const current = lock.find((record) => record.packageId === input.packageId)?.version;
  const trustedKeys = input.trustedKeys ?? trustedHarnessKeysFromEnv();
  try {
    const entries = await readdir(packageDir, { withFileTypes: true });
    const versions: HarnessPackageVersionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const version = entry.name.slice(0, -".json".length);
      if (!SEMVER.test(version)) continue;
      const path = resolve(packageDir, entry.name);
      ensureUnderRoot(root, path);
      try {
        const pkg = JSON.parse(await readFile(path, "utf-8")) as DeclarativeHarnessPackage;
        const verification = verifyHarnessPackage(pkg, trustedKeys);
        if (!verification.ok || pkg.id !== input.packageId || pkg.version !== version) continue;
        versions.push({
          packageId: pkg.id,
          version,
          digest: verification.digest,
          keyId: verification.keyId,
          current: version === current,
        });
      } catch {
        // An unreadable historical package must not prevent inspection or rollback of other versions.
      }
    }
    return versions.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true })
    );
  } catch {
    return [];
  }
}

export async function rollbackHarnessPackage(input: {
  packageId: string;
  version: string;
  trustedKeys?: Readonly<Record<string, string>>;
  dataDir?: string;
  now?: Date;
}): Promise<HarnessPackageLockRecord> {
  if (!PACKAGE_ID.test(input.packageId) || !SEMVER.test(input.version)) {
    throw new HarnessPackageInstallError(
      "package_target_invalid",
      "Package id or version is invalid"
    );
  }
  const dataDir = input.dataDir ?? getDataDir();
  const root = resolve(dataDir, "harness-packages");
  const packagePath = resolve(root, "packages", input.packageId, `${input.version}.json`);
  ensureUnderRoot(root, packagePath);
  let pkg: DeclarativeHarnessPackage;
  try {
    pkg = JSON.parse(await readFile(packagePath, "utf-8")) as DeclarativeHarnessPackage;
  } catch {
    throw new HarnessPackageInstallError(
      "package_version_missing",
      `No retained package ${input.packageId}@${input.version} is available for rollback`
    );
  }
  const verification = verifyHarnessPackage(pkg, input.trustedKeys ?? trustedHarnessKeysFromEnv());
  if (!verification.ok || pkg.id !== input.packageId || pkg.version !== input.version) {
    throw new HarnessPackageInstallError(
      verification.ok ? "package_version_invalid" : verification.code,
      verification.ok
        ? "Retained package does not match the requested rollback target"
        : verification.message
    );
  }
  const record: HarnessPackageLockRecord = {
    packageId: pkg.id,
    version: pkg.version,
    digest: verification.digest,
    keyId: verification.keyId,
    installedAt: (input.now ?? new Date()).toISOString(),
  };
  const lockPath = resolve(root, "lock.json");
  const lock = (await readLock(lockPath)).filter((item) => item.packageId !== pkg.id);
  lock.push(record);
  lock.sort((a, b) => a.packageId.localeCompare(b.packageId));
  await atomicWrite(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return record;
}

/**
 * Uninstall removes a package from the active lock only. Signed version files
 * remain retained locally, so a deliberate rollback/reinstall is possible and
 * no package bytes are deleted as a side effect of an operator action.
 */
export async function uninstallHarnessPackage(input: {
  packageId: string;
  dataDir?: string;
}): Promise<HarnessPackageLockRecord> {
  if (!PACKAGE_ID.test(input.packageId)) {
    throw new HarnessPackageInstallError("package_id_invalid", "Package id is invalid");
  }
  const dataDir = input.dataDir ?? getDataDir();
  const root = resolve(dataDir, "harness-packages");
  const lockPath = resolve(root, "lock.json");
  const lock = await readLock(lockPath);
  const target = lock.find((record) => record.packageId === input.packageId);
  if (!target) {
    throw new HarnessPackageInstallError(
      "package_not_installed",
      `Package ${input.packageId} is not currently installed`
    );
  }
  const dependents = await findInstalledDependents({
    root,
    records: lock,
    packageId: input.packageId,
  });
  if (dependents.length > 0) {
    throw new HarnessPackageInstallError(
      "dependency_in_use",
      `Cannot uninstall ${input.packageId}; required by ${dependents.join(", ")}`
    );
  }
  await atomicWrite(
    lockPath,
    `${JSON.stringify(
      lock.filter((record) => record.packageId !== input.packageId),
      null,
      2
    )}\n`
  );
  const activationPath = resolve(root, "activation.json");
  const activation = await readHarnessProfileActivation(activationPath);
  const retainedProfileIds = activation.profileIds.filter(
    (profileId) => !profileId.startsWith(`${input.packageId}.`)
  );
  if (retainedProfileIds.length !== activation.profileIds.length) {
    const nextActivation: HarnessProfileActivation = {
      ...activation,
      profileIds: retainedProfileIds,
      parameterOverrides: Object.fromEntries(
        Object.entries(activation.parameterOverrides).filter(([profileId]) =>
          retainedProfileIds.includes(profileId)
        )
      ),
      revision: activation.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(activationPath, `${JSON.stringify(nextActivation, null, 2)}\n`);
    await appendActivationAudit({
      root,
      previous: activation,
      next: nextActivation,
      source: "package-uninstall",
    });
  }
  return target;
}

/**
 * Converts a verified data-only package into ordinary Kernel registrations.
 * The package has no activation hook by construction, so it cannot execute
 * code while being composed; tools still pass through the normal Host policy
 * and sandbox pipeline when they are later bound to an implementation.
 */
export function registerDeclarativeHarnessPackage(
  registry: CapabilityRegistry,
  input: DeclarativeHarnessPackage
): void {
  for (const manifest of input.capabilities) registry.register({ manifest });
  for (const profile of input.profiles) registry.registerProfile(profile);
}

export async function loadVerifiedHarnessPackages(input: {
  registry: CapabilityRegistry;
  trustedKeys?: Readonly<Record<string, string>>;
  dataDir?: string;
}): Promise<{
  loaded: HarnessPackageLockRecord[];
  packages: DeclarativeHarnessPackage[];
  rejected: Array<{ packageId: string; reason: string }>;
}> {
  const root = resolve(input.dataDir ?? getDataDir(), "harness-packages");
  const records = await readLock(resolve(root, "lock.json"));
  const trustedKeys = input.trustedKeys ?? trustedHarnessKeysFromEnv();
  const loaded: HarnessPackageLockRecord[] = [];
  const packages: DeclarativeHarnessPackage[] = [];
  const rejected: Array<{ packageId: string; reason: string }> = [];
  for (const record of records) {
    const path = resolve(root, "packages", record.packageId, `${record.version}.json`);
    try {
      ensureUnderRoot(root, path);
      const pkg = JSON.parse(await readFile(path, "utf-8")) as DeclarativeHarnessPackage;
      const verification = verifyHarnessPackage(pkg, trustedKeys);
      if (!verification.ok || verification.digest !== record.digest) {
        rejected.push({
          packageId: record.packageId,
          reason: verification.ok ? "package digest differs from lockfile" : verification.message,
        });
        continue;
      }
      registerDeclarativeHarnessPackage(input.registry, pkg);
      loaded.push(record);
      packages.push(pkg);
    } catch (error) {
      rejected.push({
        packageId: record.packageId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { loaded, packages, rejected };
}

/** Refreshes the process-local declarative package cache used by tool composition. */
export async function refreshHarnessPackageRuntime(input?: {
  trustedKeys?: Readonly<Record<string, string>>;
  dataDir?: string;
}): Promise<HarnessPackageRuntimeState> {
  const dataDir = input?.dataDir ?? getDataDir();
  const registry = new CapabilityRegistry();
  const outcome = await loadVerifiedHarnessPackages({
    registry,
    ...(input?.trustedKeys ? { trustedKeys: input.trustedKeys } : {}),
    dataDir,
  });
  const available = new Set(
    outcome.packages.flatMap((pkg) => pkg.profiles.map((profile) => profile.id))
  );
  const activation = await readHarnessProfileActivation(
    resolve(dataDir, "harness-packages", "activation.json")
  );
  const activeProfileIds = activation.profileIds.filter((profileId) => available.has(profileId));
  runtimeState = {
    packages: outcome.packages,
    activeProfileIds,
    activation: {
      ...activation,
      profileIds: activeProfileIds,
      parameterOverrides: Object.fromEntries(
        Object.entries(activation.parameterOverrides).filter(([profileId]) =>
          activeProfileIds.includes(profileId)
        )
      ),
    },
    rejected: outcome.rejected,
  };
  return getHarnessPackageRuntimeState();
}

export function getHarnessPackageRuntimeState(): HarnessPackageRuntimeState {
  return {
    packages: [...runtimeState.packages],
    activeProfileIds: [...runtimeState.activeProfileIds],
    activation: {
      ...runtimeState.activation,
      profileIds: [...runtimeState.activation.profileIds],
      parameterOverrides: structuredClone(runtimeState.activation.parameterOverrides),
    },
    rejected: [...runtimeState.rejected],
  };
}

export function getActiveHarnessPackageProfiles(): string[] {
  return [...runtimeState.activeProfileIds];
}

export function getHarnessProfileActivation(): HarnessProfileActivation {
  return {
    ...runtimeState.activation,
    profileIds: [...runtimeState.activation.profileIds],
    parameterOverrides: structuredClone(runtimeState.activation.parameterOverrides),
  };
}

/** A compact, append-only audit trail for configuration changes. */
export async function listHarnessProfileActivationHistory(
  dataDir: string = getDataDir()
): Promise<HarnessProfileActivationAudit[]> {
  try {
    const raw = JSON.parse(
      await readFile(resolve(dataDir, "harness-packages", "activation-history.json"), "utf-8")
    ) as unknown;
    return Array.isArray(raw) ? raw.filter(isActivationAudit).slice(-100).reverse() : [];
  } catch {
    return [];
  }
}

export async function setActiveHarnessPackageProfiles(input: {
  profileIds: readonly string[];
  parameterOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  trustedKeys?: Readonly<Record<string, string>>;
  dataDir?: string;
}): Promise<HarnessPackageRuntimeState> {
  const dataDir = input.dataDir ?? getDataDir();
  const state = await refreshHarnessPackageRuntime({
    ...(input.trustedKeys ? { trustedKeys: input.trustedKeys } : {}),
    dataDir,
  });
  const available = new Set(
    state.packages.flatMap((pkg) => pkg.profiles.map((profile) => profile.id))
  );
  const profileIds = [
    ...new Set(input.profileIds.map((profileId) => profileId.trim()).filter(Boolean)),
  ].sort();
  const invalid = profileIds.filter((profileId) => !available.has(profileId));
  if (invalid.length > 0) {
    throw new HarnessPackageInstallError(
      "profile_unknown",
      `Package profiles are not installed or trusted: ${invalid.join(", ")}`
    );
  }
  const parameterOverrides = validateProfileParameterOverrides({
    profiles: state.packages.flatMap((pkg) => pkg.profiles),
    profileIds,
    ...(input.parameterOverrides !== undefined
      ? { parameterOverrides: input.parameterOverrides }
      : {}),
  });
  const path = resolve(dataDir, "harness-packages", "activation.json");
  const activation: HarnessProfileActivation = {
    schemaVersion: 1,
    profileIds,
    parameterOverrides,
    revision: state.activation.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(path, `${JSON.stringify(activation, null, 2)}\n`);
  await appendActivationAudit({
    root: resolve(dataDir, "harness-packages"),
    previous: state.activation,
    next: activation,
    source: "api",
  });
  runtimeState = { ...state, activeProfileIds: profileIds, activation };
  return getHarnessPackageRuntimeState();
}

export class HarnessPackageInstallError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "HarnessPackageInstallError";
  }
}

function validateHarnessPackage(
  input: DeclarativeHarnessPackage
): HarnessPackageVerification | null {
  if (!input || typeof input !== "object") {
    return { ok: false, code: "manifest_invalid", message: "Package must be a JSON object" };
  }
  if (input.schemaVersion !== 1) {
    return {
      ok: false,
      code: "schema_unsupported",
      message: "Only Harness package schemaVersion=1 is supported",
    };
  }
  if (
    typeof input.id !== "string" ||
    typeof input.version !== "string" ||
    !PACKAGE_ID.test(input.id) ||
    !SEMVER.test(input.version)
  ) {
    return {
      ok: false,
      code: "manifest_invalid",
      message: "Package id or semantic version is invalid",
    };
  }
  if (
    typeof input.title !== "string" ||
    typeof input.description !== "string" ||
    !input.title.trim() ||
    !input.description.trim()
  ) {
    return {
      ok: false,
      code: "manifest_invalid",
      message: "Package title and description are required",
    };
  }
  if (!Array.isArray(input.capabilities) || !Array.isArray(input.profiles)) {
    return {
      ok: false,
      code: "manifest_invalid",
      message: "Capabilities and profiles must be arrays",
    };
  }
  if (
    input.dependencies !== undefined &&
    (!Array.isArray(input.dependencies) ||
      input.dependencies.some(
        (dependency) =>
          !dependency ||
          !PACKAGE_ID.test(dependency.packageId) ||
          !SEMVER.test(dependency.version) ||
          dependency.packageId === input.id
      ))
  ) {
    return {
      ok: false,
      code: "manifest_invalid",
      message: "Package dependencies must use package id plus an exact semantic version",
    };
  }
  const capabilityIds = new Set<string>();
  for (const capability of input.capabilities) {
    if (
      !capability ||
      typeof capability.id !== "string" ||
      typeof capability.version !== "string" ||
      !PACKAGE_ID.test(capability.id) ||
      !SEMVER.test(capability.version) ||
      !capability.id.startsWith(`${input.id}.`) ||
      typeof capability.title !== "string" ||
      !capability.title.trim() ||
      typeof capability.description !== "string" ||
      !capability.description.trim() ||
      !CAPABILITY_KINDS.has(capability.kind) ||
      !isNamespacedIdList(capability.requires, input.id) ||
      !isNamespacedIdList(capability.conflictsWith, input.id) ||
      !isStringList(capability.permissions) ||
      !isToolSurfaceList(capability.tools) ||
      !isExtensionRequirementList(capability.extensions) ||
      !isSandboxRequirement(capability.sandbox) ||
      capabilityIds.has(capability.id)
    ) {
      return {
        ok: false,
        code: "manifest_invalid",
        message: "Capability manifest is invalid or duplicated",
      };
    }
    capabilityIds.add(capability.id);
  }
  const profileIds = new Set<string>();
  for (const profile of input.profiles) {
    if (
      !profile ||
      typeof profile.id !== "string" ||
      !profile.id.trim() ||
      !profile.id.startsWith(`${input.id}.`) ||
      !isNamespacedIdList(profile.extends, input.id) ||
      !isNamespacedIdList(profile.enable, input.id, true) ||
      !isNamespacedIdList(profile.disable, input.id) ||
      !isProfileParameterMap(profile.parameters) ||
      profileIds.has(profile.id) ||
      typeof profile.title !== "string" ||
      !profile.title.trim() ||
      typeof profile.description !== "string" ||
      !profile.description.trim()
    ) {
      return {
        ok: false,
        code: "manifest_invalid",
        message: "Capability profile is invalid or duplicated",
      };
    }
    profileIds.add(profile.id);
  }
  if (
    !input.integrity ||
    input.integrity.algorithm !== "sha256" ||
    typeof input.integrity.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.integrity.digest)
  ) {
    return {
      ok: false,
      code: "manifest_invalid",
      message: "Package must declare a sha256 hexadecimal integrity digest",
    };
  }
  if (
    !input.signature ||
    input.signature.algorithm !== "ed25519" ||
    typeof input.signature.keyId !== "string" ||
    typeof input.signature.value !== "string" ||
    !input.signature.keyId.trim() ||
    !input.signature.value.trim()
  ) {
    return {
      ok: false,
      code: "manifest_invalid",
      message: "Package must declare an Ed25519 signature",
    };
  }
  return null;
}

function isStringList(value: unknown): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

/** First-party packages cannot alter or depend on a Core namespace by manifest alone. */
function isNamespacedIdList(value: unknown, packageId: string, required = false): boolean {
  if (value === undefined) return !required;
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "string" && item.startsWith(`${packageId}.`) && PACKAGE_ID.test(item)
    )
  );
}

function isToolSurfaceList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((item) => {
        if (!item || typeof item !== "object") return false;
        const tool = item as Record<string, unknown>;
        return (
          typeof tool.name === "string" &&
          tool.name.trim().length > 0 &&
          ["read", "write"].includes(tool.mode as string) &&
          (tool.description === undefined || typeof tool.description === "string")
        );
      }))
  );
}

function isExtensionRequirementList(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((item) => {
        if (!item || typeof item !== "object") return false;
        const extension = item as Record<string, unknown>;
        return (
          EXTENSION_KINDS.has(extension.kind as string) &&
          typeof extension.id === "string" &&
          extension.id.trim().length > 0 &&
          (extension.optional === undefined || typeof extension.optional === "boolean")
        );
      }))
  );
}

function isSandboxRequirement(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sandbox = value as Record<string, unknown>;
  return (
    (sandbox.filesystem === undefined ||
      ["read", "workspace-write"].includes(sandbox.filesystem as string)) &&
    (sandbox.network === undefined || ["none", "allowlist"].includes(sandbox.network as string)) &&
    (sandbox.process === undefined || ["none", "allowlist"].includes(sandbox.process as string)) &&
    (sandbox.requireContainer === undefined || typeof sandbox.requireContainer === "boolean") &&
    (sandbox.approvals === undefined ||
      (Array.isArray(sandbox.approvals) &&
        sandbox.approvals.every((approval) =>
          [
            "workspace-write",
            "network",
            "external-plugin",
            "command-execution",
            "broker-trade",
          ].includes(approval as string)
        )))
  );
}

function isProfileParameterMap(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([name, parameter]) => {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) return false;
    if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) return false;
    const item = parameter as CapabilityProfileParameter;
    if (
      !["string", "number", "boolean", "enum"].includes(item.type) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      (item.description !== undefined && typeof item.description !== "string")
    ) {
      return false;
    }
    if (item.type === "enum") {
      return (
        Array.isArray(item.values) &&
        item.values.length > 0 &&
        item.values.every((value) => typeof value === "string") &&
        (item.default === undefined ||
          (typeof item.default === "string" && item.values.includes(item.default)))
      );
    }
    if (item.default === undefined) return true;
    return (
      (item.type === "string" && typeof item.default === "string") ||
      (item.type === "number" && typeof item.default === "number") ||
      (item.type === "boolean" && typeof item.default === "boolean")
    );
  });
}

async function readLock(path: string): Promise<HarnessPackageLockRecord[]> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLockRecord);
  } catch {
    return [];
  }
}

async function readHarnessProfileActivation(path: string): Promise<HarnessProfileActivation> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    const profileIds = Array.isArray(parsed.profileIds)
      ? parsed.profileIds.filter((value): value is string => typeof value === "string")
      : [];
    const parameterOverrides = sanitizeParameterOverrides(parsed.parameterOverrides);
    return {
      schemaVersion: 1,
      profileIds: [...new Set(profileIds)].sort(),
      parameterOverrides,
      revision:
        typeof parsed.revision === "number" &&
        Number.isSafeInteger(parsed.revision) &&
        parsed.revision >= 0
          ? parsed.revision
          : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return {
      schemaVersion: 1,
      profileIds: [],
      parameterOverrides: {},
      revision: 0,
      updatedAt: null,
    };
  }
}

function validateProfileParameterOverrides(input: {
  profiles: CapabilityProfile[];
  profileIds: readonly string[];
  parameterOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}): Record<string, Record<string, string | number | boolean>> {
  const requested = input.parameterOverrides ?? {};
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
    throw new HarnessPackageInstallError(
      "profile_parameters_invalid",
      "parameterOverrides must be an object"
    );
  }
  const profiles = new Map(input.profiles.map((profile) => [profile.id, profile]));
  const result: Record<string, Record<string, string | number | boolean>> = {};
  for (const [profileId, rawValues] of Object.entries(requested)) {
    if (!input.profileIds.includes(profileId)) {
      throw new HarnessPackageInstallError(
        "profile_parameters_inactive",
        `Parameter override requires active profile: ${profileId}`
      );
    }
    const profile = profiles.get(profileId);
    if (!profile || !rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) {
      throw new HarnessPackageInstallError(
        "profile_parameters_invalid",
        `Invalid parameters for ${profileId}`
      );
    }
    const accepted: Record<string, string | number | boolean> = {};
    for (const [name, value] of Object.entries(rawValues)) {
      const definition = profile.parameters?.[name];
      if (!definition || !isParameterValue(definition, value)) {
        throw new HarnessPackageInstallError(
          "profile_parameters_invalid",
          `Invalid value for ${profileId}.${name}`
        );
      }
      accepted[name] = value;
    }
    if (Object.keys(accepted).length > 0) result[profileId] = accepted;
  }
  return result;
}

function isParameterValue(
  definition: CapabilityProfileParameter,
  value: unknown
): value is string | number | boolean {
  if (definition.type === "enum") {
    return typeof value === "string" && Boolean(definition.values?.includes(value));
  }
  return (
    (definition.type === "string" && typeof value === "string") ||
    (definition.type === "number" && typeof value === "number") ||
    (definition.type === "boolean" && typeof value === "boolean")
  );
}

function sanitizeParameterOverrides(
  value: unknown
): Record<string, Record<string, string | number | boolean>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, Record<string, string | number | boolean>> = {};
  for (const [profileId, rawValues] of Object.entries(value as Record<string, unknown>)) {
    if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) continue;
    const values: Record<string, string | number | boolean> = {};
    for (const [name, item] of Object.entries(rawValues as Record<string, unknown>)) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        values[name] = item;
      }
    }
    if (Object.keys(values).length > 0) result[profileId] = values;
  }
  return result;
}

async function appendActivationAudit(input: {
  root: string;
  previous: HarnessProfileActivation;
  next: HarnessProfileActivation;
  source: HarnessProfileActivationAudit["source"];
}): Promise<void> {
  const path = resolve(input.root, "activation-history.json");
  const existing = await listHarnessProfileActivationHistory(dirname(input.root));
  const changedParameterProfiles = [
    ...new Set([
      ...Object.keys(input.previous.parameterOverrides),
      ...Object.keys(input.next.parameterOverrides),
    ]),
  ].filter(
    (profileId) =>
      stableJson(input.previous.parameterOverrides[profileId] ?? {}) !==
      stableJson(input.next.parameterOverrides[profileId] ?? {})
  );
  const entry: HarnessProfileActivationAudit = {
    revision: input.next.revision,
    changedAt: input.next.updatedAt ?? new Date().toISOString(),
    source: input.source,
    previousProfileIds: [...input.previous.profileIds],
    profileIds: [...input.next.profileIds],
    changedParameterProfiles,
  };
  await atomicWrite(path, `${JSON.stringify([entry, ...existing].slice(0, 100), null, 2)}\n`);
}

async function findInstalledDependents(input: {
  root: string;
  records: HarnessPackageLockRecord[];
  packageId: string;
}): Promise<string[]> {
  const dependents: string[] = [];
  for (const record of input.records) {
    if (record.packageId === input.packageId) continue;
    try {
      const payload = JSON.parse(
        await readFile(
          resolve(input.root, "packages", record.packageId, `${record.version}.json`),
          "utf-8"
        )
      ) as DeclarativeHarnessPackage;
      if (payload.dependencies?.some((dependency) => dependency.packageId === input.packageId)) {
        dependents.push(`${record.packageId}@${record.version}`);
      }
    } catch {
      // An unreadable dependent is handled during runtime verification, not as a destructive uninstall blocker.
    }
  }
  return dependents.sort();
}

function isActivationAudit(value: unknown): value is HarnessProfileActivationAudit {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.revision === "number" &&
    typeof item.changedAt === "string" &&
    (item.source === "api" || item.source === "package-uninstall") &&
    Array.isArray(item.previousProfileIds) &&
    Array.isArray(item.profileIds) &&
    Array.isArray(item.changedParameterProfiles)
  );
}

function isLockRecord(value: unknown): value is HarnessPackageLockRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["packageId", "version", "digest", "keyId", "installedAt"].every(
    (key) => typeof item[key] === "string"
  );
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, contents, "utf-8");
  await rename(temp, path);
}

function ensureUnderRoot(root: string, path: string): void {
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new HarnessPackageInstallError(
      "path_escape",
      "Harness package path escapes its data directory"
    );
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
