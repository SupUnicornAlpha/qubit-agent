import type {
  AnalystTeamGraphInteraction,
  AnalystTeamGraphMcpCall,
  AnalystTeamGraphNode,
  AnalystTeamGraphToolCall,
} from "../../api/types";

export type CitySkyline = "nyc" | "shanghai" | "hongkong";

/** 猫咪当前动作（像素动画状态机） */
export type CatAction =
  | "idle"
  | "walk"
  | "chat_send"
  | "chat_recv"
  | "tool"
  | "mcp"
  | "skill"
  | "sandbox"
  | "builtin"
  | "at_rack"
  | "at_shelf"
  | "success"
  | "fail"
  | "success_empty"
  | "signal";

export type OfficeEventKind = CatAction | "go_rack" | "go_shelf";

export type OfficeEventOutcome = "success" | "fail" | "success_empty";

export type OfficeEvent = {
  id: string;
  at: number;
  kind: OfficeEventKind;
  role: string;
  peerRole?: string;
  success?: boolean;
  empty?: boolean;
  label?: string;
};

export type CatBreed =
  | "tabby"
  | "black"
  | "white"
  | "calico"
  | "siamese"
  | "british"
  | "tuxedo"
  | "ginger";

/** 工位显示器内容 */
export type ScreenMode =
  | "idle"
  | "chat"
  | "code"
  | "mcp"
  | "skill"
  | "sandbox"
  | "ok"
  | "err"
  | "empty";

export type CatActor = {
  role: string;
  label: string;
  breed: CatBreed;
  /** 工位锚点 */
  homeX: number;
  homeY: number;
  /** 当前世界坐标 */
  x: number;
  y: number;
  action: CatAction;
  actionUntil: number;
  frame: number;
  facing: 1 | -1;
  screenMode: ScreenMode;
  bubble?: string;
  bubbleUntil?: number;
  walkFromX?: number;
  walkFromY?: number;
  walkToX?: number;
  walkToY?: number;
  walkOnDone?: CatAction;
  walkStart?: number;
  /** 纵深 0=远 1=近，用于透视缩放 */
  depth?: number;
  /** 空闲漫步：下次触发时间 */
  nextIdleWander?: number;
  /** 漫步结束后回工位时间 */
  returnHomeAt?: number;
};

export type ChatBeam = {
  from: string;
  to: string;
  until: number;
};

export type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
};

export type PixelOfficeGraphInput = {
  nodes: AnalystTeamGraphNode[];
  interactions: AnalystTeamGraphInteraction[];
  toolCalls: AnalystTeamGraphToolCall[];
  mcpCalls: AnalystTeamGraphMcpCall[];
};

export type DeskSlot = {
  x: number;
  y: number;
  /** 纵深 0=靠窗远 1=镜头近 */
  depth: number;
};

export type OfficeLayout = {
  floorY: number;
  windowH: number;
  cellW: number;
  cellH: number;
  rack: DeskSlot;
  shelf: DeskSlot;
  /** 休息角（靠窗） */
  lounge: DeskSlot;
  /** 咖啡角（侧墙） */
  coffee: DeskSlot;
  /** 工作区标识点 */
  workZone: DeskSlot;
  desks: Map<string, DeskSlot>;
};

export const ACTION_MS: Record<CatAction, number> = {
  idle: 0,
  walk: 900,
  chat_send: 2400,
  chat_recv: 2400,
  tool: 2000,
  mcp: 2200,
  skill: 2200,
  sandbox: 2400,
  builtin: 2000,
  at_rack: 2200,
  at_shelf: 2200,
  success: 1200,
  fail: 1400,
  success_empty: 1400,
  signal: 1800,
};

export const WALK_MS = 850;
