import { afterEach, describe, expect, test } from "bun:test";
import {
  attachPrimeCore,
  resetPrimeAttachStatus,
  resolveAttachMode,
  resolveCoreStrict,
} from "../attach";
import { resetCoreRuntimeCache } from "../core-runtime";

describe("prime attach", () => {
  const prevBackend = process.env.QUBIT_CORE_BACKEND;
  const prevUrl = process.env.QUBIT_RUST_CORE_URL;
  const prevStrict = process.env.QUBIT_CORE_STRICT;

  afterEach(() => {
    if (prevBackend === undefined) delete process.env.QUBIT_CORE_BACKEND;
    else process.env.QUBIT_CORE_BACKEND = prevBackend;
    if (prevUrl === undefined) delete process.env.QUBIT_RUST_CORE_URL;
    else process.env.QUBIT_RUST_CORE_URL = prevUrl;
    if (prevStrict === undefined) delete process.env.QUBIT_CORE_STRICT;
    else process.env.QUBIT_CORE_STRICT = prevStrict;
    resetPrimeAttachStatus();
    resetCoreRuntimeCache();
  });

  test("resolveAttachMode defaults to rust", () => {
    delete process.env.QUBIT_CORE_BACKEND;
    expect(resolveAttachMode()).toBe("rust");
    expect(resolveAttachMode("auto")).toBe("auto");
    expect(resolveAttachMode("ts")).toBe("ts");
  });

  test("resolveCoreStrict defaults true for rust, false for auto", () => {
    delete process.env.QUBIT_CORE_STRICT;
    expect(resolveCoreStrict("rust")).toBe(true);
    expect(resolveCoreStrict("auto")).toBe(false);
    process.env.QUBIT_CORE_STRICT = "0";
    expect(resolveCoreStrict("rust")).toBe(false);
  });

  test("mode=ts activates ts without probing", async () => {
    const st = await attachPrimeCore({ mode: "ts" });
    expect(st.activeBackend).toBe("ts");
    expect(st.healthy).toBe(true);
    expect(process.env.QUBIT_CORE_BACKEND).toBe("ts");
  });

  test("auto falls back to ts when core unreachable", async () => {
    const st = await attachPrimeCore({
      mode: "auto",
      rustCoreUrl: "http://127.0.0.1:1",
    });
    expect(st.activeBackend).toBe("ts");
    expect(st.healthy).toBe(false);
    expect(st.reason).toContain("unreachable");
    expect(process.env.QUBIT_CORE_BACKEND).toBe("ts");
  });

  test("mode=rust never falls back to ts when unreachable", async () => {
    delete process.env.QUBIT_CORE_STRICT;
    const st = await attachPrimeCore({
      mode: "rust",
      rustCoreUrl: "http://127.0.0.1:1",
    });
    expect(st.activeBackend).toBe("rust");
    expect(st.healthy).toBe(false);
    expect(st.reason).toContain("strict");
    expect(process.env.QUBIT_CORE_BACKEND).toBe("rust");
  });
});
