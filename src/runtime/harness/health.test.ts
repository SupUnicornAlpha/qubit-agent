import { afterEach, describe, expect, test } from "bun:test";
import {
  isHarnessProfileCircuitOpen,
  listHarnessProfileHealth,
  recordHarnessProfileFailure,
  resetHarnessProfileHealthForTest,
} from "./health";

afterEach(() => resetHarnessProfileHealthForTest());

describe("Harness profile health circuit", () => {
  test("opens after repeated failures and preserves legacy fallback eligibility", () => {
    resetHarnessProfileHealthForTest();
    recordHarnessProfileFailure(["example.docs.default"], "composition conflict");
    recordHarnessProfileFailure(["example.docs.default"], "composition conflict");
    expect(isHarnessProfileCircuitOpen("example.docs.default")).toBe(false);
    recordHarnessProfileFailure(["example.docs.default"], "composition conflict");
    expect(isHarnessProfileCircuitOpen("example.docs.default")).toBe(true);
    expect(
      listHarnessProfileHealth().find((item) => item.profileId === "example.docs.default")
    ).toMatchObject({
      profileId: "example.docs.default",
      state: "open",
      failuresInWindow: 3,
    });
  });
});
