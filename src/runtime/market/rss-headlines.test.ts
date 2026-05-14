import { describe, expect, test } from "bun:test";
import { parseRssHeadlineItems } from "./rss-headlines";

describe("parseRssHeadlineItems", () => {
  test("parses CDATA title/link/pubDate", () => {
    const xml = `<?xml version="1.0"?>
<rss><channel>
<item>
<title><![CDATA[Hello & Co]]></title>
<link><![CDATA[https://example.com/a]]></link>
<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
</item>
</channel></rss>`;
    const items = parseRssHeadlineItems(xml, 5);
    expect(items.length).toBe(1);
    expect(items[0].title).toBe("Hello & Co");
    expect(items[0].link).toBe("https://example.com/a");
    expect(items[0].publishedAt).toContain("2024");
  });

  test("respects limit", () => {
    const xml = Array.from({ length: 5 })
      .map(
        (_, i) => `<item><title>T${i}</title><link>https://x/${i}</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>`
      )
      .join("");
    expect(parseRssHeadlineItems(xml, 2).length).toBe(2);
  });
});
