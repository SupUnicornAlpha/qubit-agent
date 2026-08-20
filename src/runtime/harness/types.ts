/**
 * The Harness layer is intentionally Host-side.  Core sees only the stable
 * Host Tool Protocol and never imports financial capability implementations.
 */
export type HarnessCapabilityKind =
  | "market-data"
  | "research"
  | "execution"
  | "risk"
  | "memory"
  | "observability"
  | "document"
  | "data"
  | "browser"
  | "developer"
  | "integration";

export type CapabilityExtensionKind = "mcp" | "skill" | "connector" | "exec-provider";

export type CapabilityExtensionRequirement = {
  kind: CapabilityExtensionKind;
  /** Stable package/server/provider identifier, not a display name. */
  id: string;
  /** Optional extensions leave the capability usable with its remaining surface. */
  optional?: boolean;
};

export type CapabilitySandboxRequirement = {
  filesystem?: "read" | "workspace-write";
  network?: "none" | "allowlist";
  process?: "none" | "allowlist";
  /** Third-party code and command execution must never silently use the host. */
  requireContainer?: boolean;
  /** Side effects are routed to Core HITL when the active profile permits prompting. */
  approvals?: readonly SandboxApprovalKind[];
};

export type SandboxApprovalKind =
  | "workspace-write"
  | "network"
  | "external-plugin"
  | "command-execution"
  | "broker-trade";

export type HarnessScopeKind = "global" | "workspace" | "workflow" | "agent";

export type HarnessScope = {
  kind: HarnessScopeKind;
  id: string;
  parent?: HarnessScope;
};

export type CapabilityToolSurface = {
  name: string;
  /** The consumer still applies scenario, policy and runtime-data filters. */
  mode: "read" | "write";
  description?: string;
};

export type CapabilityManifest = {
  id: string;
  version: string;
  title: string;
  kind: HarnessCapabilityKind;
  description: string;
  requires?: readonly string[];
  conflictsWith?: readonly string[];
  permissions?: readonly string[];
  tools?: readonly CapabilityToolSurface[];
  extensions?: readonly CapabilityExtensionRequirement[];
  sandbox?: CapabilitySandboxRequirement;
};

export type CapabilityProfile = {
  id: string;
  title: string;
  description: string;
  extends?: readonly string[];
  enable: readonly string[];
  disable?: readonly string[];
  /**
   * Declarative, non-secret tuning knobs exposed by a capability profile.
   * Values are persisted in the Harness activation record and are never
   * treated as environment variables or command fragments.
   */
  parameters?: Readonly<Record<string, CapabilityProfileParameter>>;
};

export type CapabilityProfileParameter = {
  type: "string" | "number" | "boolean" | "enum";
  title: string;
  description?: string;
  default?: string | number | boolean;
  values?: readonly string[];
};

export type CapabilityDisposer = () => void | Promise<void>;

export type CapabilityActivationContext = {
  scope: HarnessScope;
  capabilityId: string;
  profileId: string;
  /**
   * Phase 1 keeps registration declarative. Later this is the only path to
   * contribute pipeline hooks; capabilities never call Core directly.
   */
  registerDisposer(disposer: CapabilityDisposer): void;
};

export type HarnessCapabilityPlugin = {
  manifest: CapabilityManifest;
  activate?(
    context: CapabilityActivationContext
  ): CapabilityDisposer | undefined | Promise<CapabilityDisposer | undefined>;
};

export type ResolvedCapabilityComposition = {
  profileId: string;
  capabilityIds: string[];
  capabilities: HarnessCapabilityPlugin[];
  tools: CapabilityToolSurface[];
};

export class HarnessCompositionError extends Error {
  constructor(
    public readonly code:
      | "duplicate_capability"
      | "unknown_capability"
      | "unknown_profile"
      | "dependency_cycle"
      | "dependency_disabled"
      | "capability_conflict"
      | "activation_failed",
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "HarnessCompositionError";
  }
}
