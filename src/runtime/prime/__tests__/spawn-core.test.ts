import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAppServerBin,
  resolveCoreLlmEnv,
  shouldRespawnCoreForLlm,
} from "../spawn-core";

describe("spawn-core helpers", () => {
  test("resolveAppServerBin returns null or existing path", () => {
    const bin = resolveAppServerBin();
    if (bin) {
      expect(bin.includes("qubit-app-server")).toBe(true);
    } else {
      expect(bin).toBeNull();
    }
  });

  test("resolveCoreLlmEnv prefers model.json over OPENAI_API_KEY", () => {
    const root = mkdtempSync(join(tmpdir(), "core-llm-"));
    mkdirSync(join(root, ".qubit"), { recursive: true });
    writeFileSync(
      join(root, ".qubit", "model.json"),
      JSON.stringify({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        apiKey: "sk-from-model-json-ok",
        baseUrl: "https://api.deepseek.com/chat/completions",
      })
    );

    const env = resolveCoreLlmEnv(
      {
        OPENAI_API_KEY: "sk-stale-openai-from-hydrate",
      } as NodeJS.ProcessEnv,
      [root]
    );

    expect(env.QUBIT_LLM_API_KEY).toBe("sk-from-model-json-ok");
    expect(env.QUBIT_LLM_MODEL).toBe("deepseek-v4-flash");
    expect(env.QUBIT_LLM_BASE_URL).toBe("https://api.deepseek.com/v1");
  });

  test("resolveCoreLlmEnv lets explicit QUBIT_LLM_API_KEY win", () => {
    const root = mkdtempSync(join(tmpdir(), "core-llm-explicit-"));
    mkdirSync(join(root, ".qubit"), { recursive: true });
    writeFileSync(
      join(root, ".qubit", "model.json"),
      JSON.stringify({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        apiKey: "sk-from-model",
        baseUrl: "https://api.deepseek.com/v1",
      })
    );

    const env = resolveCoreLlmEnv(
      {
        QUBIT_LLM_API_KEY: "sk-explicit-core",
        OPENAI_API_KEY: "sk-openai",
      } as NodeJS.ProcessEnv,
      [root]
    );
    expect(env.QUBIT_LLM_API_KEY).toBe("sk-explicit-core");
  });

  test("shouldRespawnCoreForLlm adopts matching external core (no restart storm)", () => {
    const decision = shouldRespawnCoreForLlm({
      health: {
        ok: true,
        degradedReasons: [],
        fakeModel: false,
        llmModel: "deepseek-v4-flash",
        llmBaseUrl: "https://api.deepseek.com/v1",
        hasLlmKey: true,
      },
      llmEnv: {
        QUBIT_LLM_API_KEY: "sk-x",
        QUBIT_LLM_MODEL: "deepseek-v4-flash",
        QUBIT_LLM_BASE_URL: "https://api.deepseek.com/v1",
      },
      ownedPid: null,
    });
    expect(decision.respawn).toBe(false);
    expect(decision.reason).toBe("llm_ok");
  });

  test("shouldRespawnCoreForLlm force-refreshes external when QUBIT_FORCE_EXTERNAL_CORE_REFRESH=1", () => {
    const prev = process.env.QUBIT_FORCE_EXTERNAL_CORE_REFRESH;
    process.env.QUBIT_FORCE_EXTERNAL_CORE_REFRESH = "1";
    try {
      const decision = shouldRespawnCoreForLlm({
        health: {
          ok: true,
          degradedReasons: [],
          fakeModel: false,
          llmModel: "deepseek-v4-flash",
          llmBaseUrl: "https://api.deepseek.com/v1",
          hasLlmKey: true,
        },
        llmEnv: {
          QUBIT_LLM_API_KEY: "sk-x",
          QUBIT_LLM_MODEL: "deepseek-v4-flash",
          QUBIT_LLM_BASE_URL: "https://api.deepseek.com/v1",
        },
        ownedPid: null,
      });
      expect(decision.respawn).toBe(true);
      expect(decision.reason).toBe("external_core_refresh_llm");
    } finally {
      if (prev === undefined) delete process.env.QUBIT_FORCE_EXTERNAL_CORE_REFRESH;
      else process.env.QUBIT_FORCE_EXTERNAL_CORE_REFRESH = prev;
    }
  });

  test("shouldRespawnCoreForLlm keeps owned matching core", () => {
    const decision = shouldRespawnCoreForLlm({
      health: {
        ok: true,
        degradedReasons: [],
        fakeModel: false,
        llmModel: "deepseek-v4-flash",
        llmBaseUrl: "https://api.deepseek.com/v1",
        hasLlmKey: true,
      },
      llmEnv: {
        QUBIT_LLM_API_KEY: "sk-x",
        QUBIT_LLM_MODEL: "deepseek-v4-flash",
        QUBIT_LLM_BASE_URL: "https://api.deepseek.com/v1",
      },
      ownedPid: 1234,
    });
    expect(decision.respawn).toBe(false);
  });
});
