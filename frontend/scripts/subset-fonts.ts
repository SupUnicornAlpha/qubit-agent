#!/usr/bin/env bun
/**
 * 扫描 frontend/src/**\/*.{ts,tsx,css} 抽出所有非 ASCII 字符 + 完整 ASCII，
 * 用 subset-font (harfbuzz) 把 ArkPixel 800KB 字体裁到只保留实际用到的字形。
 *
 * 输出：
 *   - src/assets/fonts/ark-pixel-12px-proportional-latin.subset.woff2
 *   - src/assets/fonts/ark-pixel-12px-proportional-zh_cn.subset.woff2
 *   - src/assets/fonts/.subset-chars.txt（调试用）
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import subsetFont from "subset-font";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const FONTS = join(ROOT, "src/assets/fonts");

const TARGET_EXTS = [".ts", ".tsx", ".css", ".html"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".vite", "fonts"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (TARGET_EXTS.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

function collectChars(): { latin: string; cjk: string; all: string } {
  const chars = new Set<string>();

  // 完整 ASCII 可打印字符（避免动态文本/数字遗漏）
  for (let i = 0x20; i < 0x7f; i++) chars.add(String.fromCharCode(i));
  for (const c of "·…—–•◆●○✓✗←→↑↓") chars.add(c);

  const files = walk(SRC);
  for (const f of files) {
    const txt = readFileSync(f, "utf8");
    for (const ch of txt) {
      const cp = ch.codePointAt(0)!;
      // CJK / 中日韩兼容 / 全角标点 / Emoji 留给系统字体（不打进 ArkPixel）
      if (cp > 0x7f && cp < 0x10000) chars.add(ch);
    }
  }

  const latin: string[] = [];
  const cjk: string[] = [];
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x100) latin.push(ch);
    else cjk.push(ch);
  }
  const sortedLatin = [...latin].sort().join("");
  const sortedCjk = [...cjk].sort().join("");
  return {
    latin: sortedLatin,
    cjk: sortedCjk,
    all: sortedLatin + sortedCjk,
  };
}

async function subset(srcPath: string, outPath: string, chars: string): Promise<{ in: number; out: number }> {
  const buf = readFileSync(srcPath);
  const out = await subsetFont(buf, chars, { targetFormat: "woff2" });
  writeFileSync(outPath, out);
  return { in: buf.byteLength, out: out.byteLength };
}

async function main() {
  const { latin, cjk, all } = collectChars();
  console.log(`[subset-fonts] scanned latin glyphs: ${latin.length}, cjk glyphs: ${cjk.length}`);
  writeFileSync(join(FONTS, ".subset-chars.txt"), all);

  const latinSrc = join(FONTS, "ark-pixel-12px-proportional-latin.woff2");
  const cjkSrc = join(FONTS, "ark-pixel-12px-proportional-zh_cn.woff2");
  const latinOut = join(FONTS, "ark-pixel-12px-proportional-latin.subset.woff2");
  const cjkOut = join(FONTS, "ark-pixel-12px-proportional-zh_cn.subset.woff2");

  // Latin subset 至少包含 ASCII；为安全合并 cjk 引号等
  const latinChars = latin + "—–·…";
  const cjkChars = cjk;

  const a = await subset(latinSrc, latinOut, latinChars);
  const b = await subset(cjkSrc, cjkOut, cjkChars);

  const human = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`[subset-fonts] latin: ${human(a.in)} → ${human(a.out)} (${((1 - a.out / a.in) * 100).toFixed(1)}% off)`);
  console.log(`[subset-fonts] cjk  : ${human(b.in)} → ${human(b.out)} (${((1 - b.out / b.in) * 100).toFixed(1)}% off)`);
  console.log(`[subset-fonts] wrote ${relative(ROOT, latinOut)}`);
  console.log(`[subset-fonts] wrote ${relative(ROOT, cjkOut)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
