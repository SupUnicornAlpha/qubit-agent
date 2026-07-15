import duckdbLibrary from "@duckdb/node-bindings-linux-arm64/libduckdb.so" with {
  type: "file",
};
import { join } from "node:path";
import { tmpdir } from "node:os";

await Bun.write(join(tmpdir(), "libduckdb.so"), Bun.file(duckdbLibrary));
await import("../../src/cli");
