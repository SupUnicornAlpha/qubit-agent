import duckdbDylib from "@duckdb/node-bindings-darwin-arm64/libduckdb.dylib" with {
  type: "file",
};
import { join } from "node:path";
import { tmpdir } from "node:os";

// Bun extracts native addons into the OS temp directory. DuckDB's addon resolves
// its companion library through @loader_path, so materialize the embedded asset
// there before importing the application graph that loads duckdb.node.
await Bun.write(join(tmpdir(), "libduckdb.dylib"), Bun.file(duckdbDylib));
await import("../../src/cli");
