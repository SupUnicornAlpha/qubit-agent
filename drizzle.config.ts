import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/sqlite/schema.ts",
  out: "./src/db/sqlite/migrations",
  dbCredentials: {
    url: `${process.env["HOME"] ?? "~"}/.quant-agent/db/core.sqlite`,
  },
});
