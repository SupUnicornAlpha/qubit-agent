import { afterEach, describe, expect, test } from "bun:test";
import {
  assertTsReactAllowed,
  isTsReactAllowedUnderRust,
} from "../ts-react-residual";

describe("ts-react-residual Phase B", () => {
  const prevBackend = process.env.QUBIT_CORE_BACKEND;

  afterEach(() => {
    if (prevBackend === undefined) delete process.env.QUBIT_CORE_BACKEND;
    else process.env.QUBIT_CORE_BACKEND = prevBackend;
  });

  test("assertTsReactAllowed always throws (TS runtime gone)", () => {
    process.env.QUBIT_CORE_BACKEND = "ts";
    expect(() => assertTsReactAllowed("unit")).toThrow(/TS Agent runtime removed/);
    process.env.QUBIT_CORE_BACKEND = "rust";
    expect(() => assertTsReactAllowed("unit")).toThrow(/TS Agent runtime removed/);
  });

  test("isTsReactAllowedUnderRust is always false", () => {
    expect(isTsReactAllowedUnderRust()).toBe(false);
  });
});
