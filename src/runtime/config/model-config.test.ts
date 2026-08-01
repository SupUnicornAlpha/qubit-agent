import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadModelConfig,
  resolveEmbeddingRuntimeOptions,
  saveModelConfig,
} from "./model-config";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "qubit-model-config-"));
  dirs.push(d);
  return d;
}

describe("model-config embedding", () => {
  test("save/load embedding nested fields", async () => {
    const root = tempRoot();
    await saveModelConfig(
      {
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-chat",
        embedding: {
          enabled: true,
          model: "text-embedding-3-large",
          apiKey: "sk-emb",
          baseUrl: "https://api.example.com/v1",
          dimensions: 1024,
        },
      },
      root
    );
    const loaded = await loadModelConfig(root);
    expect(loaded?.embedding?.model).toBe("text-embedding-3-large");
    expect(loaded?.embedding?.apiKey).toBe("sk-emb");
    expect(loaded?.embedding?.baseUrl).toBe("https://api.example.com/v1");
    expect(loaded?.embedding?.dimensions).toBe(1024);
  });

  test("partial embedding patch keeps prior apiKey when blank", async () => {
    const root = tempRoot();
    await saveModelConfig(
      {
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-chat",
        embedding: { model: "text-embedding-3-small", apiKey: "sk-emb" },
      },
      root
    );
    await saveModelConfig(
      {
        embedding: { model: "text-embedding-3-large", enabled: false },
      },
      root
    );
    const loaded = await loadModelConfig(root);
    expect(loaded?.embedding?.model).toBe("text-embedding-3-large");
    expect(loaded?.embedding?.enabled).toBe(false);
    expect(loaded?.embedding?.apiKey).toBe("sk-emb");
  });

  test("resolveEmbeddingRuntimeOptions falls back to chat key then env", () => {
    const fromChat = resolveEmbeddingRuntimeOptions(
      {
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-chat",
        embedding: { enabled: true, model: "text-embedding-3-small", apiKey: "" },
      },
      {}
    );
    expect(fromChat.apiKey).toBe("sk-chat");
    expect(fromChat.source).toBe("model.json");

    const fromEnv = resolveEmbeddingRuntimeOptions(null, {
      OPENAI_API_KEY: "sk-env",
    });
    expect(fromEnv.apiKey).toBe("sk-env");
    expect(fromEnv.source).toBe("env");

    const disabled = resolveEmbeddingRuntimeOptions(
      {
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-chat",
        embedding: { enabled: false, model: "text-embedding-3-small", apiKey: "sk-emb" },
      },
      { OPENAI_API_KEY: "sk-env" }
    );
    expect(disabled.enabled).toBe(false);
    expect(disabled.source).toBe("disabled");
  });
});
