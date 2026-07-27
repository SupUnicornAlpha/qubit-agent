import { describe, expect, test } from "bun:test";
import { classifyToolFailureForMonitoring } from "../tools-summary";

describe("classifyToolFailureForMonitoring", () => {
  test("does not call a team dispatch timeout no-data", () => {
    expect(
      classifyToolFailureForMonitoring("semantic_data_failure:dispatch_timeout_data_unknown")
    ).toBe("dispatch_timeout");
    expect(
      classifyToolFailureForMonitoring("team_dispatch_timeout: market_data did not reply")
    ).toBe("dispatch_timeout");
  });

  test("recognizes semantic empty data", () => {
    expect(classifyToolFailureForMonitoring("semantic_data_failure:items_empty")).toBe("no_data");
    expect(classifyToolFailureForMonitoring("factor.compute: no_factor_values_written")).toBe(
      "no_data"
    );
  });

  test("leaves configuration and transport errors in the other bucket", () => {
    expect(
      classifyToolFailureForMonitoring('mcp server "fsi-mtnewswires" not found or disabled')
    ).toBe("other");
    expect(classifyToolFailureForMonitoring("HTTP 503")).toBe("other");
  });
});
