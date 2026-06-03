/**
 * 中文（简体）—— 项目源语言。
 * 当其他语言包缺失某个 key 时，会自动回退到这里。
 *
 * 约定：
 * - key 用 dot 风格按「模块.场景.含义」组织；
 * - 占位符使用 `{name}` 风格，参见 `t("xx.yy", { name: "Alice" })`；
 * - 新增 key 时请在所有语言包中同步补齐（缺失会在 dev 控制台告警）。
 */
import type { LocalePack } from "../types";

const pack: LocalePack = {
  id: "zh-CN",
  name: "中文（简体）",
  englishName: "Chinese (Simplified)",
  dir: "ltr",
  translations: {
    common: {
      backend: {
        connected: "Backend Connected",
        offline: "Backend Offline",
      },
      action: {
        refresh: "刷新",
        send: "发送",
        save: "保存",
        delete: "删除",
        cancel: "取消",
        confirmAgain: "再次确认",
      },
      status: {
        loading: "加载中…",
      },
    },
    app: {
      hint: {
        tauriBackendNotReady: "内置后端未就绪，可点击顶部「重启后端」或稍候自动重试。",
        webBackendDisconnected: "后端未连接：请在项目根目录启动 `bun run dev`。",
        webModeBootstrap: "当前为 Web 模式，不会自动拉起后端，请先执行 `bun run dev`。",
      },
    },
    topbar: {
      brandSubtitle: "量化研究 Agent 平台",
      navAriaLabel: "主导航",
      style: { label: "界面风格" },
      palette: {
        label: "配色",
        lockedTitle: "切换回「默认」、Glass Holographic 或 Biophilic 风格后可改配色",
        glassTitle: "Glass 底色（冷 / 暖 / 彩虹）",
        biophilicTitle: "亲自然配色（绿植绿涨 / 柔和红涨）",
        defaultTitle: "配色",
      },
      language: { label: "界面语言", title: "界面语言" },
      restart: {
        button: "重启后端",
        running: "重启中…",
        title: "重启内置后端（{url}）",
        progress: "正在重启内置后端…",
        failure: "重启失败，请确认本机未占用 {url} 对应端口。",
      },
      status: {
        connectedTauri: "内置后端已连接（127.0.0.1:17385）",
        connectedWeb: "后端健康检查通过，可正常调用 API",
        offlineTauri: "内置后端未响应，可点击「重启后端」",
        offlineWeb: "后端未响应：请检查本机是否已启动开发服务",
      },
    },
    sidebar: {
      brand: { title: "Explorer", meta: "QUBIT IDE" },
      group: {
        nav: "导航",
        configSub: "配置子项",
        quantSub: "量化子项",
        currentContext: "当前上下文",
      },
      context: { moduleLabel: "模块：{name}" },
      explorer: {
        expand: "展开 Explorer",
        collapse: "收起 Explorer",
        activityHintCollapseAgain: "{label}（再次点击收起 Explorer）",
        activityHintExpand: "{label}（点击展开 Explorer）",
      },
      nav: {
        ide: "研究工作台",
        team: "研究团队",
        trader: "实时交易Agent",
        quant: "量化工作台",
        chart: "资讯",
        chat: "对话",
        monitor: "运行监控",
        broker: "券商账户配置",
        config: "配置中心",
      },
      quant: {
        factor: "因子工坊",
        discovery: "挖掘工坊",
        composer: "组合工坊",
        backtest: "回测工坊",
      },
      config: {
        llm: "LLM",
        datasources: "数据源",
        mcp: "MCP",
        skills: "Skills",
        agent: "Agent",
        providers: "Providers",
        integration: "集成 / IM",
        schedule: "定时任务",
        env: "环境管理",
      },
    },
    theme: {
      styles: {
        default: "默认",
        "feishu-clean": "简洁",
        "glass-holographic": "Glass Holographic",
        "retro-futurism": "复古未来主义 · CLI",
        industrial: "工业设计",
        "neon-cyberpunk": "霓虹赛博朋克",
        bauhaus: "Bauhaus 包豪斯",
        "sci-fi-hud": "科幻 HUD",
        "comic-book": "Comic Book 漫画书",
        "anti-design": "反设计 Anti-Design",
        blueprint: "Blueprint 工程蓝图",
        "hand-drawn-fabric": "手绘涂鸦 · 织物",
        "ambient-3d": "Ambient 3D · 柔光空间",
        biophilic: "Biophilic 亲自然",
      },
      palettes: {
        "dark-purple": "黑紫",
        "light-white": "白",
        "light-sky": "天蓝",
        "glass-cool": "冷色",
        "glass-warm": "暖色",
        "glass-rainbow": "彩虹",
        "bio-green": "绿植（绿涨）",
        "bio-red": "柔和红（红涨）",
      },
    },
    ide: {
      workbench: {
        gutterAriaLabel: "调整对话与 K 线宽度",
        emptyCenter: "已隐藏 K 线 / 回测。在上方工具栏打开「K线」或「回测」即可恢复。",
      },
      leftColumn: {
        ariaLabel: "左侧工作台模式",
        chat: "对话工作台",
        indicator: "指标 IDE",
      },
      toolbar: {
        labels: {
          watchlist: "自选",
          symbol: "代码",
          symbolAria: "品种代码",
          period: "周期",
          periodTitle: "K 线周期：{tf}",
          bars: "条数",
          barsTitle: "拉取 K 线根数上限",
          indicators: "指标模板",
          indicatorsTitle: "研究侧加载的指标脚本模板",
          refresh: "刷新数据",
          refreshTitle: "按当前自选与周期重新请求 K 线",
          mainOverlay: "主图叠加",
          panels: "面板",
        },
        overlays: {
          sma20: "SMA20 主图均线",
          ema20: "EMA20 主图均线",
          rsi14: "RSI14 副图",
          macd: "MACD 副图（与 RSI 二选一）",
          bb20: "布林带（20, 2）主图叠加",
        },
        panelToggles: {
          left: "显示或隐藏左侧会话列",
          chart: "显示或隐藏 K 线主图",
          backtest: "显示或隐藏回测停靠栏",
          quickTrade: "打开或关闭快捷交易侧栏",
        },
      },
      indicators: {
        none: "（未选指标）",
        smaCross: "双均线交叉",
        rsiRange: "RSI 区间",
        macdHist: "MACD 柱",
        boll: "布林带",
      },
      backtest: {
        dockAriaLabel: "回测与调参",
        tabs: { backtest: "回测参数", tune: "智能调参" },
        kind: {
          label: "策略来源",
          python: "左侧 Python 脚本（on_init/on_bar）",
          sma: "固定 SMA 双均线（fast/slow）",
        },
        fields: {
          fastPeriod: "快线周期",
          slowPeriod: "慢线周期",
          initialCapital: "初始资金",
          commission: "手续费率",
          startDate: "开始日期",
          endDate: "结束日期",
          customRange: "自定义日期区间（否则使用当前「条数」推导区间）",
        },
        run: {
          button: "运行回测",
          running: "运行中…",
          failedDefault: "回测失败",
          summary:
            "收益 {ret}% · 最大回撤 {dd}% · Sharpe≈{sharpe} · 成交 {trades} 笔 · K线 {bars} 根{posTail}",
          posTail: " · 末仓位 {pos}",
          pythonPathHint: "执行左侧 on_init/on_bar（真实 bar-by-bar 撮合）",
          smaPathHint: "固定 SMA 双均线（左侧代码不参与）",
          symbolFromToolbar: "标的取自工具条",
          stdoutSummary: "策略 print 输出（{n} 字符）",
          runtimeHint:
            "纸面/实盘策略运行时：在「实时交易」页勾选策略后启动，或调用 POST /api/v1/strategy-runtimes",
        },
        tune: {
          intro:
            "Structured scan（Grid）：在快线/慢线周期集合上搜索较优参数（最多 50 组试算，后端限制）。",
          fastList: "快线候选（逗号分隔）",
          slowList: "慢线候选（逗号分隔）",
          run: "运行智能调参（Grid）",
          running: "扫描中…",
          regimeRun: "盘势检测（Regime）",
          regimeRunning: "检测中…",
          errorPrefix: "错误: {err}",
        },
      },
      indicatorIde: {
        title: "代码编辑器",
        defaultScriptName: "策略稿",
        badge: { saved: "已入库 · {name}", unsaved: "本地草稿 · 未保存", unnamed: "未命名" },
        meta: {
          session: "关联会话",
          sessionEmpty: "（未选择会话）",
          sessionWarn: "请在「对话工作台」选中会话",
          run: "研究团队 Run",
          runEmpty: "（不关联具体 Run）",
          purpose: "用途",
          name: "策略名",
          namePlaceholder: "保存时使用的名称",
          saved: "已保存",
          savedEmpty: "（选择已保存策略…）",
        },
        purpose: {
          research: "研究 / 对话产出",
          live: "量化交易执行",
          both: "研究 + 交易",
        },
        actions: {
          refresh: "刷新列表",
          newDraft: "新建草稿",
          saveUpdate: "保存更新",
          saveToSession: "保存到会话",
          delete: "删除",
        },
        errors: {
          needSession: "请先在对话工作台选择会话后再保存。",
          needName: "请填写策略名称。",
          confirmDelete: "确定删除当前已保存的策略稿？",
        },
        signal: { summary: "Python 信号脚本（底部「代码策略」回测共用）" },
        ai: {
          title: "AI 生成（自然语言 → 策略）",
          placeholder: "用自然语言描述你想实现的指标或买卖逻辑…",
          send: "生成并带入对话",
          hint: "保存时会一并记录此描述与当前图表标的，便于研究与交易模块复用。",
          chatBlock:
            "请根据以下「自然语言需求」与「指标/策略草稿」继续完善、检查风险点，并说明需要哪些行情数据或 API：\n\n【需求】\n{prompt}\n\n【当前草稿】\n```python\n{code}\n```",
          promptEmpty: "（未填写自然语言描述）",
        },
        editor: { ariaSource: "策略与指标源码", ariaSignal: "Python 信号 buy sell" },
      },
      quickTrade: {
        ariaLabel: "快捷交易",
        title: "快捷交易",
        intro:
          "与左侧 Agent 流、上方 K 线联动：纸面下单走统一执行管道（风控 → execution_task → 纸面成交）。",
        amountLabel: "名义金额（示意，用于估算数量）",
        qtyEstimate: "预估数量约 {qty} 股/张 · 纸面模式",
        backendOffline: "在实时交易页连接后端后可用",
        long: "做多",
        short: "做空",
        submitting: "提交中…",
        cancelLast: "撤上一单 ({id}…)",
        orderKind: { market: "市价", limit: "限价" },
        leverage: "杠杆 {n}x",
        margin: { cross: "全仓", isolated: "逐仓" },
        tp: "止盈价",
        sl: "止损价",
        tpslPlaceholder: "可选（后续版本）",
        currentKindPrefix: "当前订单类型：",
        currentKindSuffix: "。止盈止损与实盘券商将在后续版本接入。",
        logTitle: "快捷交易参数变更",
        logBody:
          "订单类型={kind} · 名义比例={pct}% · 杠杆={lev}x · 保证金={margin}\n品种 {symbol} / {exchange} · {tf}",
      },
    },
    chart: {
      kline: {
        title: "资讯",
        importToChat: "带入对话分析",
        codeLabel: "代码",
        marketLabel: "市场",
        periodLabel: "周期",
        barsLabel: "条数",
        sourceCompact: "来源 {source} · 返回 {got}/{want}{loadingTail}",
        sourceFull: "来源 {source} · 周期 {tf} / {period} · 返回 {got} / 请求 {want}{tail}",
        loadingTail: " · 加载中…",
        ohlcTail: " · 末根 OHLC={o}/{h}/{l}/{c} · vol={v}",
      },
    },
    chat: {
      sidebar: {
        newSession: "新建会话",
        defaultSessionTitle: "默认会话",
        confirmDeletePending: "再次点击确认硬删除会话 {title}",
        deleteSession: "硬删除会话 {title}",
        confirmDeleteTitle:
          "再次点击确认硬删除（含全部工作流/消息/checkpoint，不可恢复）。3 秒内未确认将自动取消。",
        deleteSessionTitle: "硬删除会话（含全部工作流，不可恢复）",
        resizerAria: "拖动调整会话列表与对话区宽度",
        resizerTitle: "拖动调整宽度",
      },
      board: {
        show: "显示会话看板",
        hide: "隐藏会话看板",
        showTitle: "显示会话 Agent 看板",
        hideTitle: "隐藏右侧会话 Agent 看板",
      },
      bubble: {
        streaming: "(流式生成中…)",
        empty: "（暂无回复内容）",
      },
      form: {
        loopLabel: "Loop",
        loopOptions: { native: "Native", claude: "Claude CLI", codex: "Codex CLI" },
        hitlLabel: "HITL",
        hitlTitle:
          "对话 HITL 触发策略：\n  • 智能（默认）：仅高危工具（下单 / 写入外部状态）触发，普通调用不打扰\n  • 关闭：完全跳过；高危工具仍走硬规则兜底\n  • 每次：每个工具调用都需要人工确认（旧版行为）",
        hitlOptions: { ai: "智能", off: "关闭", always: "每次" },
        placeholder: "输入任务目标，发送给主 Agent",
      },
      errors: {
        createSession: "新建会话失败",
        hitlAction: "HITL 操作失败",
      },
    },
  },
};

export default pack;
