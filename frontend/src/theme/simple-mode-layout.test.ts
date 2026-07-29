import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("./simple-mode.css", import.meta.url)).text();
const workspaceSource = await Bun.file(
  new URL("../components/layout/SimpleWorkspace.tsx", import.meta.url)
).text();

const ruleFor = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
};

describe("simple mode viewport contract", () => {
  test("keeps the composer inside the viewport and messages scrollable", () => {
    expect(ruleFor(".qb-simple-shell")).toContain(
      "grid-template-rows: auto minmax(0, 1fr) auto"
    );
    expect(ruleFor(".qb-simple-main")).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(ruleFor(".qb-simple-shell .qb-chat-panel--simple")).toContain("height: 100%");

    const chatLayout = ruleFor(".qb-simple-shell .qb-simple-chat-layout");
    expect(chatLayout).toContain("flex: 1 1 0%");
    expect(chatLayout).toContain("height: auto");

    const messages = ruleFor(".qb-simple-shell .qb-chat-messages");
    expect(messages).toContain("min-height: 0 !important");
    expect(messages).toContain("overflow-y: auto !important");
  });

  test("preserves a native desktop drag region in simple mode", () => {
    expect(workspaceSource).toContain(
      '<header className="qb-simple-header" data-tauri-drag-region>'
    );
  });
});
