#!/usr/bin/env bun
/**
 * QUBIT CLI entry point.
 * Compiled to a single binary via: bun build --compile src/cli.ts --outfile dist/qubit
 */

const [, , command, ...args] = process.argv;

async function main() {
  switch (command) {
    case "start":
    case undefined:
      await import("./index");
      break;

    case "migrate":
      await (await import("./db/sqlite/migrate")).runMigrations();
      break;

    case "bootstrap": {
      const { runPlatformBootstrap } = await import("./runtime/bootstrap/packaged-setup");
      const result = await runPlatformBootstrap();
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "version":
      console.log("QUBIT v0.1.0");
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log(`
Usage: qubit <command>

Commands:
  start     Start the QUBIT platform (default)
  migrate   Run database migrations
  bootstrap Migrate DB, seed agents/MCP/tools, setup Python venv if needed
  version   Show version
`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
