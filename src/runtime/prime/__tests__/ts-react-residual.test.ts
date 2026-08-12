import { afterEach, describe, expect, test } from "bun:test";
import {
  TS_REACT_CALL_SITES,
  TS_REACT_OUT_OF_SCOPE,
  assertTsReactAllowed,
  isTsReactAllowedUnderRust,
} from "../ts-react-residual";

describe("ts react residual / hard guard", () => {
  const prevBackend = process.env.QUBIT_CORE_BACKEND;
  const prevAllow = process.env.QUBIT_ALLOW_TS_REACT_UNDER_RUST;

  afterEach(() => {
    if (prevBackend === undefined) delete process.env.QUBIT_CORE_BACKEND;
    else process.env.QUBIT_CORE_BACKEND = prevBackend;
    if (prevAllow === undefined) delete process.env.QUBIT_ALLOW_TS_REACT_UNDER_RUST;
    else process.env.QUBIT_ALLOW_TS_REACT_UNDER_RUST = prevAllow;
  });

  test("inventory lists exactly two direct call sites", () => {
    expect(TS_REACT_CALL_SITES).toHaveLength(2);
    expect(TS_REACT_CALL_SITES.every((s) => s.valve === "rust→core")).toBe(true);
    expect(TS_REACT_OUT_OF_SCOPE.length).toBeGreaterThan(0);
  });

  test("assertTsReactAllowed allows ts backend", () => {
    process.env.QUBIT_CORE_BACKEND = "ts";
    delete process.env.QUBIT_ALLOW_TS_REACT_UNDER_RUST;
    expect(() => assertTsReactAllowed("unit")).not.toThrow();
  });

  test("assertTsReactAllowed blocks rust without escape hatch", () => {
    process.env.QUBIT_CORE_BACKEND = "rust";
    delete process.env.QUBIT_ALLOW_TS_REACT_UNDER_RUST;
    expect(() => assertTsReactAllowed("unit")).toThrow(/TS ReAct blocked/);
  });

  test("assertTsReactAllowed allows rust with escape hatch", () => {
    process.env.QUBIT_CORE_BACKEND = "rust";
    process.env.QUBIT_ALLOW_TS_REACT_UNDER_RUST = "1";
    expect(isTsReactAllowedUnderRust()).toBe(true);
    expect(() => assertTsReactAllowed("unit")).not.toThrow();
  });
});
