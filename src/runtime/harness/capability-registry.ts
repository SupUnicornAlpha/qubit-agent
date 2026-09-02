import {
  type CapabilityActivationContext,
  type CapabilityDisposer,
  type CapabilityManifest,
  type CapabilityProfile,
  type HarnessCapabilityPlugin,
  HarnessCompositionError,
  type HarnessScope,
  type ResolvedCapabilityComposition,
} from "./types";

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function assertManifest(manifest: CapabilityManifest): void {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(manifest.id)) {
    throw new TypeError(`Invalid capability id: ${manifest.id}`);
  }
  if (!manifest.version.trim() || !manifest.title.trim() || !manifest.description.trim()) {
    throw new TypeError(`Capability ${manifest.id} must declare version, title and description.`);
  }
}

export class CapabilityScopeLease {
  #disposed = false;

  constructor(
    readonly composition: ResolvedCapabilityComposition,
    readonly scope: HarnessScope,
    private readonly disposers: CapabilityDisposer[]
  ) {}

  get disposed(): boolean {
    return this.#disposed;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const failures: unknown[] = [];
    for (const disposer of [...this.disposers].reverse()) {
      try {
        await disposer();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more capability disposers failed.");
    }
  }
}

/**
 * A small explicit equivalent of Cordis' scoped resource ownership. It has no
 * singleton state and does not make the execution engine aware of plugins.
 */
export class CapabilityRegistry {
  private readonly plugins = new Map<string, HarnessCapabilityPlugin>();
  private readonly profiles = new Map<string, CapabilityProfile>();

  register(plugin: HarnessCapabilityPlugin): this {
    assertManifest(plugin.manifest);
    if (this.plugins.has(plugin.manifest.id)) {
      throw new HarnessCompositionError(
        "duplicate_capability",
        `Capability already registered: ${plugin.manifest.id}`,
        { capabilityId: plugin.manifest.id }
      );
    }
    this.plugins.set(plugin.manifest.id, plugin);
    return this;
  }

  registerProfile(profile: CapabilityProfile): this {
    if (!profile.id.trim() || !profile.title.trim() || !profile.description.trim()) {
      throw new TypeError("Capability profile must declare id, title and description.");
    }
    this.profiles.set(profile.id, {
      ...profile,
      enable: unique(profile.enable),
      disable: unique(profile.disable ?? []),
      extends: unique(profile.extends ?? []),
    });
    return this;
  }

  getManifest(capabilityId: string): CapabilityManifest | null {
    return this.plugins.get(capabilityId)?.manifest ?? null;
  }

  getProfile(profileId: string): CapabilityProfile | null {
    return this.profiles.get(profileId) ?? null;
  }

  listProfiles(): CapabilityProfile[] {
    return [...this.profiles.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  resolve(profileId: string): ResolvedCapabilityComposition {
    return this.resolveProfiles([profileId]);
  }

  /**
   * A workflow may layer independent profiles (for example broker research +
   * document delivery). Resolve all of them as one dependency graph so a
   * conflict cannot hide behind profile boundaries.
   */
  resolveProfiles(profileIds: readonly string[]): ResolvedCapabilityComposition {
    const requestedProfileIds = unique(profileIds).sort();
    if (requestedProfileIds.length === 0) {
      throw new HarnessCompositionError(
        "unknown_profile",
        "At least one capability profile is required."
      );
    }
    const enabled = new Set<string>();
    for (const profileId of requestedProfileIds) {
      for (const capabilityId of this.resolveProfileCapabilityIds(profileId, new Set())) {
        enabled.add(capabilityId);
      }
    }
    const profileId = requestedProfileIds.join("+");
    const ordered = this.topologicallyOrder(enabled, profileId);
    const capabilities = ordered.map((id) => this.plugins.get(id) as HarnessCapabilityPlugin);
    const toolsByName = new Map(
      capabilities
        .flatMap((capability) => capability.manifest.tools ?? [])
        .map((tool) => [tool.name, tool] as const)
    );
    const tools = [...toolsByName.values()];
    return { profileId, capabilityIds: ordered, capabilities, tools };
  }

  async activate(input: {
    profileId: string;
    scope: HarnessScope;
  }): Promise<CapabilityScopeLease> {
    const composition = this.resolve(input.profileId);
    const disposers: CapabilityDisposer[] = [];
    try {
      for (const capability of composition.capabilities) {
        if (!capability.activate) continue;
        const context: CapabilityActivationContext = {
          scope: input.scope,
          capabilityId: capability.manifest.id,
          profileId: input.profileId,
          registerDisposer(disposer) {
            disposers.push(disposer);
          },
        };
        const result = await capability.activate(context);
        if (typeof result === "function") disposers.push(result);
      }
      return new CapabilityScopeLease(composition, input.scope, disposers);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const disposer of [...disposers].reverse()) {
        try {
          await disposer();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      throw new HarnessCompositionError(
        "activation_failed",
        `Failed to activate profile ${input.profileId}.`,
        {
          profileId: input.profileId,
          scope: input.scope,
          cause: error instanceof Error ? error.message : String(error),
          cleanupFailures: cleanupErrors.length,
        }
      );
    }
  }

  private resolveProfileCapabilityIds(profileId: string, visiting: Set<string>): Set<string> {
    if (visiting.has(profileId)) {
      throw new HarnessCompositionError(
        "dependency_cycle",
        `Capability profile cycle at ${profileId}.`,
        { profileId }
      );
    }
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new HarnessCompositionError(
        "unknown_profile",
        `Unknown capability profile: ${profileId}`,
        { profileId }
      );
    }
    visiting.add(profileId);
    const enabled = new Set<string>();
    for (const parentId of profile.extends ?? []) {
      for (const capabilityId of this.resolveProfileCapabilityIds(parentId, visiting)) {
        enabled.add(capabilityId);
      }
    }
    for (const capabilityId of profile.enable) enabled.add(capabilityId);
    for (const capabilityId of profile.disable ?? []) enabled.delete(capabilityId);
    visiting.delete(profileId);
    return enabled;
  }

  private topologicallyOrder(enabled: Set<string>, profileId: string): string[] {
    const ordered: string[] = [];
    const visited = new Set<string>();
    const active = new Set<string>();
    const visit = (capabilityId: string): void => {
      if (visited.has(capabilityId)) return;
      if (active.has(capabilityId)) {
        throw new HarnessCompositionError(
          "dependency_cycle",
          `Capability dependency cycle at ${capabilityId}.`,
          { capabilityId, profileId }
        );
      }
      const plugin = this.plugins.get(capabilityId);
      if (!plugin) {
        throw new HarnessCompositionError(
          "unknown_capability",
          `Unknown capability: ${capabilityId}`,
          { capabilityId, profileId }
        );
      }
      active.add(capabilityId);
      for (const requiredId of plugin.manifest.requires ?? []) {
        if (!enabled.has(requiredId)) {
          throw new HarnessCompositionError(
            "dependency_disabled",
            `Capability ${capabilityId} requires ${requiredId}, but the profile does not enable it.`,
            { capabilityId, requiredId, profileId }
          );
        }
        visit(requiredId);
      }
      for (const conflictingId of plugin.manifest.conflictsWith ?? []) {
        if (enabled.has(conflictingId)) {
          throw new HarnessCompositionError(
            "capability_conflict",
            `Capabilities ${capabilityId} and ${conflictingId} cannot be composed together.`,
            { capabilityId, conflictingId, profileId }
          );
        }
      }
      active.delete(capabilityId);
      visited.add(capabilityId);
      ordered.push(capabilityId);
    };
    for (const capabilityId of [...enabled].sort()) visit(capabilityId);
    return ordered;
  }
}
