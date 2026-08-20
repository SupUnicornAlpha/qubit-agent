import { describe, expect, test } from "bun:test";
import { defaultKlineLogicalRange } from "./klineViewport";

describe("default K-line viewport", () => {
  test("keeps a dense recent window instead of fitting all historical bars", () => {
    expect(defaultKlineLogicalRange(1_200)).toEqual({ from: 1104, to: 1205 });
  });

  test("does not create an invalid viewport for an empty series", () => {
    expect(defaultKlineLogicalRange(0)).toBeNull();
  });
});
