import { desc, eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentDefinitionDraft,
  agentProfile,
  mcpToolBinding,
} from "../../db/sqlite/schema";
import {
  type PromptMode,
  defaultMemoryNamespace,
  getDataDir,
  mergeSystemPrompt,
  readPackFiles,
} from "./agent-pack-service";

export interface AgentPromptPreviewInput {
  definitionId: string;
  /** 未保存草稿时的前端覆盖（可选） */
  overrides?: {
    systemPrompt?: string;
    promptMode?: PromptMode;
    toolsJson?: unknown;
    mcpServersJson?: unknown;
    skillsJson?: unknown;
    subscriptionsJson?: unknown;
  };
}

export interface AgentPromptPreviewResult {
  mergedSystemPrompt: string;
  promptMode: PromptMode;
  sections: {
    agent: string;
    soul: string;
    user: string;
    memory: string;
    workspacePrompt: string;
    dbPrompt: string;
  };
  runtime: {
    tools: string[];
    mcpServers: string[];
    skills: string[];
    subscriptions: string[];
    mcpBindings: Array<{
      serverName: string;
      toolName: string;
      enabled: boolean;
      timeoutMs: number | null;
    }>;
  };
  packMeta: {
    packRoot: string;
    memoryNamespace: string;
    agentExists: boolean;
    soulExists: boolean;
    promptExists: boolean;
  };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

export async function buildAgentPromptPreview(
  db: DbClient,
  input: AgentPromptPreviewInput
): Promise<AgentPromptPreviewResult | null> {
  const defRows = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.id, input.definitionId))
    .limit(1);
  if (!defRows[0]) return null;
  const def = defRows[0];

  const draftRows = await db
    .select()
    .from(agentDefinitionDraft)
    .where(eq(agentDefinitionDraft.definitionId, input.definitionId))
    .orderBy(desc(agentDefinitionDraft.createdAt))
    .limit(1);
  const draft = draftRows[0];

  const profRows = await db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.definitionId, input.definitionId))
    .limit(1);
  const profile = profRows[0];

  const ov = input.overrides;
  const promptMode =
    (ov?.promptMode as PromptMode | undefined) ??
    (profile?.promptMode as PromptMode | undefined) ??
    "db_primary";
  const dbPrompt = ov?.systemPrompt ?? draft?.systemPrompt ?? def.systemPrompt;
  const tools = asStringArray(ov?.toolsJson ?? draft?.toolsJson ?? def.toolsJson);
  const mcpServers = asStringArray(ov?.mcpServersJson ?? draft?.mcpServersJson ?? def.mcpServersJson);
  const skills = asStringArray(ov?.skillsJson ?? draft?.skillsJson ?? def.skillsJson);
  const subscriptions = asStringArray(
    ov?.subscriptionsJson ?? draft?.subscriptionsJson ?? def.subscriptionsJson
  );

  const dataDir = getDataDir();
  const read = await readPackFiles({
    dataDir,
    definitionId: input.definitionId,
    configRootUri: profile?.configRootUri ?? "",
    soulFileRef: profile?.soulFileRef ?? "",
    promptTemplateRef: profile?.promptTemplateRef,
  });

  const mergedSystemPrompt = mergeSystemPrompt({
    mode: promptMode,
    dbPrompt,
    agentText: read.agentText,
    soulText: read.soulText,
    userText: read.userText,
    memoryText: read.memoryText,
    promptText: read.promptText,
  });

  const bindings = await db
    .select()
    .from(mcpToolBinding)
    .where(eq(mcpToolBinding.definitionId, input.definitionId));

  return {
    mergedSystemPrompt,
    promptMode,
    sections: {
      agent: read.agentText,
      soul: read.soulText,
      user: read.userText,
      memory: read.memoryText,
      workspacePrompt: read.promptText,
      dbPrompt,
    },
    runtime: {
      tools,
      mcpServers,
      skills,
      subscriptions,
      mcpBindings: bindings.map((b) => ({
        serverName: b.serverName,
        toolName: b.toolName,
        enabled: b.enabled,
        timeoutMs: b.timeoutMs,
      })),
    },
    packMeta: {
      packRoot: read.packRoot,
      memoryNamespace: profile?.memoryNamespace?.trim()
        ? profile.memoryNamespace
        : defaultMemoryNamespace(input.definitionId),
      agentExists: read.agentExists,
      soulExists: read.soulExists,
      promptExists: read.promptExists,
    },
  };
}
