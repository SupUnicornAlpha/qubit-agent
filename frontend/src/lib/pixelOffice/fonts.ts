import zhCnFont from "../../assets/fonts/ark-pixel-12px-proportional-zh_cn.subset.woff2";
import latinFont from "../../assets/fonts/ark-pixel-12px-proportional-latin.subset.woff2";

/** ArkPixel 字体族名（Star Office 同款） */
export const ARK_PIXEL_FAMILY = "ArkPixel";

/** Canvas 文本统一字体串：优先 ArkPixel，回落系统等宽 */
export function pixelFont(sizePx: number, weight: number | "bold" | "" = ""): string {
  const w = weight ? `${weight} ` : "";
  return `${w}${Math.max(8, Math.floor(sizePx))}px ${ARK_PIXEL_FAMILY}, "Courier New", ui-monospace, monospace`;
}

let injected = false;
let ready: Promise<void> | null = null;

/** 注入 @font-face 并等待字体可用（多次调用安全） */
export function ensureArkPixelLoaded(): Promise<void> {
  if (ready) return ready;
  if (typeof document === "undefined") return Promise.resolve();

  if (!injected) {
    injected = true;
    const style = document.createElement("style");
    style.setAttribute("data-qb-arkpixel", "true");
    style.textContent = `
@font-face {
  font-family: '${ARK_PIXEL_FAMILY}';
  src: url('${latinFont}') format('woff2');
  unicode-range: U+0020-007F, U+00A0-024F, U+2010-205E, U+2070-209F, U+2190-21FF, U+2200-22FF, U+2300-23FF;
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: '${ARK_PIXEL_FAMILY}';
  src: url('${zhCnFont}') format('woff2');
  unicode-range: U+3000-303F, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FF00-FFEF;
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}
.qb-pixel-office, .qb-pixel-office * {
  font-family: '${ARK_PIXEL_FAMILY}', "Courier New", ui-monospace, monospace !important;
}
`;
    document.head.appendChild(style);
  }

  if (typeof (document as Document & { fonts?: FontFaceSet }).fonts?.load === "function") {
    ready = Promise.all([
      document.fonts.load(`12px ${ARK_PIXEL_FAMILY}`, "Aa中文"),
      document.fonts.load(`bold 14px ${ARK_PIXEL_FAMILY}`, "办公室"),
    ])
      .then(() => undefined)
      .catch(() => undefined);
  } else {
    ready = Promise.resolve();
  }
  return ready;
}
