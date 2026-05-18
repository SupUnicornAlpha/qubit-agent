/**
 * 各视觉风格的设计提示词摘要（参考 https://www.uiprompt.site/zh/styles ）
 * 仅供文档 / 后续 AI 生成界面时引用，不参与运行时逻辑。
 */
export const STYLE_PROMPTS: Record<string, string> = {
  default:
    "现代 IDE 式量化平台：黑紫深色为默认，可选纯白与天蓝浅色；清晰层级、细滚动条、紫/蓝强调色，信息密度适中。",
  glassmorphism:
    "Glassmorphism 玻璃态：半透明磨砂面板（backdrop-filter blur + saturate），柔和体积光与渐变背景，细白描边，大圆角，层次悬浮；主色冷蓝紫，避免厚重实心块。",
  "generative-art":
    "生成艺术：流动渐变光斑、噪点纹理叠加、有机粉/紫/青配色，卡片略带不规则发光边框；背景可缓慢动画，强调数字艺术与实验感。",
  industrial:
    "工业设计：金属灰底 + 功能网格线，安全橙/琥珀强调，等宽小标签、直角或极小圆角，硬朗边框与内阴影；像控制台、机床 HMI、工程软件。",
  "neon-cyberpunk":
    "霓虹赛博朋克：极深紫黑底，霓虹青 #00fff9 与品红 #ff00ff 发光描边与文字阴影，扫描线纹理，透明描边按钮，高对比未来都市感。",
  bauhaus:
    "Bauhaus 包豪斯：米白底、红/蓝/黄原色几何点缀，粗黑 2–3px 描边与硬阴影，零圆角，功能主义排版；活动栏可用黄块，按钮实心蓝/红。",
};
