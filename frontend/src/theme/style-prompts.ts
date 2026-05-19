/**
 * 各视觉风格的设计提示词摘要（参考 https://www.uiprompt.site/zh/styles ）
 * 仅供文档 / 后续 AI 生成界面时引用，不参与运行时逻辑。
 */
export const STYLE_PROMPTS: Record<string, string> = {
  default:
    "现代 IDE 式量化平台：黑紫深色为默认，可选纯白与天蓝浅色；清晰层级、细滚动条、紫/蓝强调色，信息密度适中。",
  "glass-holographic":
    "Glass Holographic：磨砂玻璃（backdrop-blur 22~28px、渐变切面描边、悬浮阴影）+ 全息彩膜；背景动态波动（光斑起伏、底部曲面波、光谱带流动、锥形旋转、扫光）；配色冷色 glass-cool / 暖色 glass-warm / 彩虹 glass-rainbow（可见光谱全色 + 少量白色高光）；尊重 prefers-reduced-motion。",
  "retro-futurism":
    "Retro Futurism 复古未来主义 · CLI：纯黑底 + 矩阵绿终端字 + 电蓝线框 + 霓虹橙 CTA；JetBrains Mono 等宽全界面；C:\\路径\\> 提示符、[OK] 状态、TERMINAL 窗标题栏；多层 text-shadow/box-shadow 管线光晕；星空 + 透视网格地平线 + 扫描线；悬停扩散光晕 180ms、按压微沉；合成波 × 80 年代科幻终端 × RETROOS 夜生活氛围。",
  industrial:
    "工业设计 STRATAOS 工控台：炭黑 #0A0A0A + 点阵网格 + 微噪点；安全橙警示色 + 青蓝稳定态读数；Roboto Condensed 大写标题 + JetBrains Mono 技术标注；L 角标 + 四角螺栓 + 警示斜纹顶带；活动栏橙色导轨；主按钮白底按压下沉 160ms；监控 KPI/图表面板内凹硬阴影 + 底部 SYS_STATUS 状态条。",
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
  blueprint:
    "Blueprint 工程蓝图：普鲁士蓝 #0a1628–#1a365d 底 + 白线主次网格；IBM Plex Mono 全大写标注；青色 #22d3ee 交互高亮、橙 #f97316 警告；L 角标图框；hover 青色光晕。",
  "hand-drawn-fabric":
    "手绘涂鸦 · 织物：亚麻/帆布织纹底 + 温暖中性色（亚麻、燕麦、鼠尾草、尘玫瑰）+ 陶土 CTA；Caveat 仅用于标题/区块名，正文 Nunito 保证可读；市场卡片与 Tab 强制浅色高对比；缝线 + 柔和阴影；220ms hover；家居手作质感。",
  "ambient-3d":
    "Ambient 3D · Spatial UI：深蓝底 + 透视网格；壳层平整贴边；KPI/图表/卡片等模块常驻约 8–10° 透视 + 悬停再随光标加深；监控页全宽网格布局；雾面玻璃 + 落地阴影；Outfit；尊重 prefers-reduced-motion。",
  biophilic:
    "Biophilic 亲自然：双配色 bio-green（绿植/绿涨）与 bio-red（柔和红/红涨）；苔绿或尘玫瑰马卡龙色 + 奶油纸底；有机大圆角；自然光渐变 + 纸纤维噪点；Cormorant + DM Sans；高对比墨绿/暖褐文字；平静疗愈氛围。",
};
