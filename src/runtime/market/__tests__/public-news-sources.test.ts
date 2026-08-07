import { describe, expect, test } from "bun:test";
import { parseRssHeadlineItems } from "../rss-headlines";

describe("public news RSS parse", () => {
  test("parses Yahoo-style item blocks", () => {
    const xml = `<?xml version="1.0"?>
    <rss><channel>
      <item><title><![CDATA[AMD beats estimates]]></title>
        <link>https://example.com/a</link>
        <pubDate>Wed, 06 Aug 2025 12:00:00 GMT</pubDate></item>
      <item><title>NVDA outlook</title>
        <link>https://example.com/b</link>
        <pubDate>Wed, 06 Aug 2025 11:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const items = parseRssHeadlineItems(xml, 10);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toContain("AMD");
    expect(items[0]?.link).toContain("example.com/a");
  });
});
