import duckdbLibrary from "@duckdb/node-bindings-win32-x64/duckdb.dll" with {
  type: "file",
};
import { join } from "node:path";
import { tmpdir } from "node:os";

await Bun.write(join(tmpdir(), "duckdb.dll"), Bun.file(duckdbLibrary));
await import("../../src/cli");
