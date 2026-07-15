import duckdbDylib from "@duckdb/node-bindings-darwin-x64/libduckdb.dylib" with {
  type: "file",
};
import { join } from "node:path";
import { tmpdir } from "node:os";

await Bun.write(join(tmpdir(), "libduckdb.dylib"), Bun.file(duckdbDylib));
await import("../../src/cli");
