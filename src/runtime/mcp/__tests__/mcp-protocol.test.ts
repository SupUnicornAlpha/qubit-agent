import { describe, expect, test } from "bun:test";
import {
  MCP_DEFAULT_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  isSupportedMcpProtocolVersion,
  isUnsupportedProtocolVersionError,
  negotiateServerProtocolVersion,
} from "../mcp-protocol";

describe("MCP_SUPPORTED_PROTOCOL_VERSIONS", () => {
  test("ordered newest → oldest, includes 2024-11-05 fallback", () => {
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS[0]).toBe("2025-06-18");
    expect(MCP_DEFAULT_PROTOCOL_VERSION).toBe("2025-06-18");
    expect(MCP_LEGACY_PROTOCOL_VERSION).toBe("2024-11-05");
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toContain("2024-11-05");
  });
});

describe("isSupportedMcpProtocolVersion", () => {
  test("accepts each version in the list", () => {
    for (const v of MCP_SUPPORTED_PROTOCOL_VERSIONS) {
      expect(isSupportedMcpProtocolVersion(v)).toBe(true);
    }
  });
  test("rejects unknown or non-string values", () => {
    expect(isSupportedMcpProtocolVersion("2023-01-01")).toBe(false);
    expect(isSupportedMcpProtocolVersion("")).toBe(false);
    expect(isSupportedMcpProtocolVersion(null)).toBe(false);
    expect(isSupportedMcpProtocolVersion(undefined)).toBe(false);
    expect(isSupportedMcpProtocolVersion(20241105)).toBe(false);
  });
});

describe("isUnsupportedProtocolVersionError", () => {
  test("matches real-world error messages from MCP servers", () => {
    expect(
      isUnsupportedProtocolVersionError("Unsupported MCP protocol version: 2024-11-05")
    ).toBe(true);
    expect(isUnsupportedProtocolVersionError("Unsupported protocol version")).toBe(true);
    expect(
      isUnsupportedProtocolVersionError("Protocol version not supported by server")
    ).toBe(true);
    expect(
      isUnsupportedProtocolVersionError("MCP HTTP 400: Unsupported MCP protocol version")
    ).toBe(true);
  });

  test("ignores unrelated errors", () => {
    expect(isUnsupportedProtocolVersionError("HTTP 500: server error")).toBe(false);
    expect(isUnsupportedProtocolVersionError("ECONNREFUSED")).toBe(false);
    expect(isUnsupportedProtocolVersionError("")).toBe(false);
    expect(isUnsupportedProtocolVersionError(null)).toBe(false);
    expect(isUnsupportedProtocolVersionError(undefined)).toBe(false);
  });
});

describe("negotiateServerProtocolVersion", () => {
  test("echoes client version when supported", () => {
    expect(negotiateServerProtocolVersion("2024-11-05")).toBe("2024-11-05");
    expect(negotiateServerProtocolVersion("2025-03-26")).toBe("2025-03-26");
    expect(negotiateServerProtocolVersion("2025-06-18")).toBe("2025-06-18");
  });

  test("falls back to default when client version is unknown / missing", () => {
    expect(negotiateServerProtocolVersion("2023-01-01")).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
    expect(negotiateServerProtocolVersion(undefined)).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
    expect(negotiateServerProtocolVersion(null)).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
    expect(negotiateServerProtocolVersion(20241105)).toBe(MCP_DEFAULT_PROTOCOL_VERSION);
  });
});
