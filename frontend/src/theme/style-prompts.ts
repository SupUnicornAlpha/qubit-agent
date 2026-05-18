/**
 * 各视觉风格的设计提示词摘要（参考 https://www.uiprompt.site/zh/styles ）
 * 仅供文档 / 后续 AI 生成界面时引用，不参与运行时逻辑。
 */
export const STYLE_PROMPTS: Record<string, string> = {
  default:
    "现代 IDE 式量化平台：黑紫深色为默认，可选纯白与天蓝浅色；清晰层级、细滚动条、紫/蓝强调色，信息密度适中。",
  glassmorphism:
    "Glassmorphism 玻璃态：深色渐变底 + 紫/蓝/粉大光斑；卡片 rgba(255,255,255,0.05~0.12) + backdrop-blur 22~28px；1px 渐变高光描边（上亮下暗）；内阴影切面 + 大扩散外阴影悬浮；圆角 16~18px；主按钮紫蓝渐变半透明；hover 透明度↑阴影↑微上浮，active scale(0.98)。",
  "retro-futurism":
    "Retro Futurism 复古未来主义：深紫星空 + 底部透视网格地平线引向消失点；洋红/青/电蓝霓虹线框与外发光；标题大霓虹字；悬停亮度与光晕增强、低节奏星空闪烁与网格律动；橙/绿可作 RETRO 终端点缀；像合成波专辑封面与老科幻片头。",
  industrial:
    "工业设计 NEXUS 控制台：炭黑 #0D0D0D 底 + 细网格十字准星；安全橙 #FF5722 强调与 L 角标；JetBrains Mono 全大写模块编号；白底黑字主按钮 hover 变橙；KPI/日志/Event Stream 工业仪表盘。",
  "neon-cyberpunk":
    "霓虹赛博朋克：极深紫黑底，霓虹青 #00fff9 与品红 #ff00ff 发光描边与文字阴影，扫描线纹理，透明描边按钮，高对比未来都市感。",
  bauhaus:
    "Bauhaus 包豪斯：米白底、红/蓝/黄原色几何点缀，粗黑 2–3px 描边与硬阴影，零圆角，功能主义排版；活动栏可用黄块，按钮实心蓝/红。",
  "sci-fi-hud":
    "Sci-Fi HUD 科幻抬头显示：深海军蓝渐变底 #020617–#0f172a，半透明玻璃面板 rgba(15,23,42,0.72)，青蓝发光描边 #22D3EE/#0EA5E9，网格与水平扫描线，L 型角标面板，状态灯脉冲；主文本 #E5F2FF，警告橙/成功绿状态色；悬停发光增强、按压微缩，适合监控大屏与舰桥控制台。",
  "comic-book":
    "Comic Book 漫画书：CMYK 原色、粗黑描边、硬阴影、半色调网点与速度线，Bangers + Comic Neue 字体，hover POW 弹跳。",
  "anti-design":
    "Anti-Design 反设计：低饱和对撞色（赤陶红、赭黄、鼠尾草绿、灰蓝）+ 墨黑/米白底；粗描边与平移硬阴影；条纹背景；Archivo Black + IBM Plex Mono；刻意倾斜错位；hover 短促抖动；保持可读对比。",
  holographic:
    "Holographic 全息彩膜：黑灰蓝底 + 紫罗兰彩膜；CSS 动态虹彩（光斑漂移、锥形旋转、扫光、边框渐变流动）；磨砂玻璃面板；紫→丁香→青渐变；尊重 prefers-reduced-motion。",
  blueprint:
    "Blueprint 工程蓝图：普鲁士蓝 #0a1628–#1a365d 底 + 白线主次网格；IBM Plex Mono 全大写标注；青色 #22d3ee 交互高亮、橙 #f97316 警告；L 角标图框；hover 青色光晕。",
};
