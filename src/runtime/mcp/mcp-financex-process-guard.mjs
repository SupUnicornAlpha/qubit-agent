/**
 * Node --import 预加载：在 mcp-financex 注册 fatal handler 之前接管 process.on / exit。
 */
const origExit = process.exit;
process.exit = function guardedExit(code) {
  if (code === 1) {
    console.error(
      "[mcp-financex-guard] suppressed process.exit(1) — keeping stdio session alive"
    );
    return;
  }
  return origExit.call(process, code);
};

const origOn = process.on.bind(process);
process.on = function patchedOn(event, listener) {
  if (event === "uncaughtException" || event === "unhandledRejection") {
    return origOn(event, (reason) => {
      console.error(`[mcp-financex-guard] swallowed ${event}:`, reason);
    });
  }
  return origOn(event, listener);
};
