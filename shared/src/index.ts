// ─────────────────────────────────────────────
//  共用型別（前後端共用）
// ─────────────────────────────────────────────

export type ClanId = 'brujah' | 'nosferatu' | 'toreador' | 'tremere' | 'malkavian' | 'gangrel' | 'ventrue';
export type CardType = 'conflict' | 'preparation' | 'aftermath' | 'passive';

export type GamePhase =
  | 'LOBBY'
  | 'CLAN_SELECT'
  | 'HAND_BUILD'
  | 'PLANNING'
  | 'WITHDRAW'
  | 'REVELATION'
  | 'CONFLICT'
  | 'ROUND_END'
  | 'GAME_OVER';

// ─── 卡牌 ───────────────────────────────────

export interface CardDef {
  id: string;
  name_en: string;
  name_zh: string;
  clan: ClanId | 'neutral';
  type: CardType;
  power: number;
  effect_en: string | null;
  effect_zh: string | null;
  is_starter: boolean;
}

// ─── 地點 ───────────────────────────────────

export interface LocationDef {
  id: string;
  name: string;
  // influence[round-1][rank-1]: round=1..3, rank=1..2
  influence: number[][];
  isPrinces: boolean;
}

// ─── 盟友牌 ──────────────────────────────────

export interface AllyCard {
  id: string;
  name: string;
  type: 'human' | 'vampire';
  influence: number;
  feedBlood: number;
  drainBlood: number;
  drainInfluence: number;
  effect_zh?: string | null;
  drained?: boolean;
}

// ─── 部署 ────────────────────────────────────

export interface Deployment {
  locationId: string;
  cardId: string;
  faceDown: boolean;
  bloodTokens: number;
}

export interface SlotFull {
  playerId: string;
  cardId: string;
  faceDown: boolean;
  bloodTokens: number;
  withdrawn: boolean;
  effectivePower: number;
  skipEffects?: boolean;  // VE03: rival chose to skip prep/aftermath
}

export interface PendingChoice {
  id: string;
  playerId: string;
  prompt_zh: string;
  options: { key: string; label_zh: string }[];
  context: { cardId: string; locationId: string; sourcePlayerId: string; sourceName: string };
  choiceKey: string; // 用於 resolvedChoices 查詢：`${cardId}:${locationId}:${playerId}`
}

export interface SlotVisible {
  playerId: string;
  cardId: string | null;
  faceDown: boolean;
  bloodTokensHidden: boolean;
  bloodTokens: number;
  withdrawn: boolean;
  effectivePower: number | null;
}

// ─── 玩家狀態 ────────────────────────────────

export interface PlayerPublic {
  id: string;
  name: string;
  clan: ClanId | null;
  blood: number;
  influence: number;
  handCount: number;
  allianceCount: number;
  diablerie: number;
  deploymentsLeft: number;
  isReady: boolean;
}

export interface PlayerPrivate extends PlayerPublic {
  hand: CardDef[];
  deck: CardDef[];
  alliance: AllyCard[];
  // 手牌建造：等待選擇的兩張牌
  handBuildDraft: CardDef[];
}

// ─── 結算結果 ────────────────────────────────

/** 單一效果事件，攜帶來源卡與數值變化，供 UI 顯示因果關係 */
export interface StepEvent {
  text: string;
  sourceCardId?: string;
  sourcePlayerName?: string;
  targetPlayerName?: string;
  delta?: {
    blood?: number;
    influence?: number;
    power?: number;
  };
}

export interface ConflictResult {
  locationId: string;
  winner: string | null;
  second: string | null;
  scores: Record<string, number>;
  influenceGained: Record<string, number>;
  bloodEvents: StepEvent[];
  /** 分步驟的效果紀錄，供 UI 逐步顯示用 */
  stepEvents: {
    prepare: StepEvent[];
    conflict: StepEvent[];
    aftermath: StepEvent[];
  };
  tie: boolean;
}

export interface ActiveEffect {
  locationId: string;
  step: 'reveal' | 'prepare' | 'conflict' | 'aftermath' | 'complete';
  eventIndex: number;
  eventCount: number;
  sourceCardId?: string;
  sourcePlayerName?: string;
  targetPlayerName?: string;
  text: string;
  delta?: {
    blood?: number;
    influence?: number;
    power?: number;
  };
}

// ─── Server 完整狀態 ──────────────────────────

export interface GameStateFull {
  roomCode: string;
  phase: GamePhase;
  round: number;
  ambitionHolder: string;
  playerOrder: string[];
  currentTurnPlayerId: string;
  currentLocIndex: number;       // 當前結算中的地點索引（-1 = 未在結算）
  currentLocResolved: boolean;   // 當前地點的戰鬥是否已結算完
  locations: LocationDef[];
  players: Record<string, PlayerPrivate>;
  deployments: Record<string, SlotFull[]>;
  withdrawChoices: Record<string, Record<string, boolean>>;
  locationAllies: Record<string, AllyCard | null>;
  allyDeck: AllyCard[];
  victimDeck: AllyCard[];
  lastConflictResults: ConflictResult[];
  winner: string | null;
  log: string[];
  pendingChoices: PendingChoice[];
  resolvedChoices: Record<string, string>;
  activeEffect: ActiveEffect | null;
  // VE07 先發制人：key = playerId，value = 免疫的 cardId 陣列（當回合有效）
  // 注意：改為陣列而非 Set 以保持 JSON 可序列化（Convex state 需純 JSON）
  forestallImmune: Record<string, string[]>;
}

// ─── Client 收到的狀態 ────────────────────────

export interface GameStateClient {
  roomCode: string;
  phase: GamePhase;
  round: number;
  ambitionHolder: string;
  /**
   * 房主 playerId。房主身分存在 Convex rooms 文件（引擎 state 不認識），
   * 由 game.state query 注入投影；LOBBY 顯示「開始遊戲」按鈕與房主標記用。
   * （不可用 players 物件 key 順序判定房主：Convex 儲存會排序 key。）
   */
  hostId?: string;
  playerOrder: string[];
  currentTurnPlayerId: string;
  currentLocIndex: number;       // 當前結算中的地點索引（-1 = 未在結算）
  locations: LocationDef[];
  players: Record<string, PlayerPublic>;
  myHand: CardDef[];
  myHandBuildDraft: CardDef[];   // HAND_BUILD phase 用
  myBlood: number;
  myAlliance: AllyCard[];
  myDiablerieTokens: number;
  deployments: Record<string, SlotVisible[]>;
  locationAllies: Record<string, AllyCard | null>;
  waitingFor: string[];
  lastConflictResults: ConflictResult[];
  winner: string | null;
  log: string[];
  myPendingChoice: PendingChoice | null;
  activeEffect: ActiveEffect | null;
  /** 房間內是否有任何玩家仍有待回應的選擇（供其他玩家顯示等待提示用） */
  hasPendingChoices: boolean;
  /** 公開的「誰正在做卡牌選擇」（只含是誰、為哪張牌，不含選項內容） */
  activeChoosers: Array<{ playerId: string; cardId: string; locationId: string }>;
  /** 結算演出加速投票（playerId 列表）；全員投票即跳過剩餘演出 */
  skipVotes: string[];
}

// ─── Socket 事件 ──────────────────────────────

export interface ClientToServer {
  createRoom: (payload: { name: string }) => void;
  joinRoom: (payload: { code: string; name: string }) => void;
  readyStart: () => void;
  selectClan: (clan: ClanId) => void;
  selectHandCard: (cardId: string) => void;          // HAND_BUILD: 選擇保留哪張
  submitDeployment: (deployment: Deployment | { skip: true }) => void;
  submitWithdraw: (payload: { locationId: string; withdraw: boolean }) => void;
  drainAlly: (allyId: string) => void;               // 汲取同盟牌
  readyAdvance: () => void;                          // REVELATION/ROUND_END 確認繼續
  respondChoice: (payload: { choiceId: string; option: string }) => void;
  watchRoom: (code: string) => void;                 // 觀戰：加入房間但不參與
  chat: (msg: string) => void;
  /** 斷線重連：以 session 憑證重新綁定原本的席位 */
  rejoinRoom: (payload: { roomCode: string; playerId: string; token: string }) => void;
  /** 結算演出加速投票：全員投票後立即播完剩餘演出 */
  skipEffects: () => void;
}

export interface ServerToClient {
  roomCreated: (code: string) => void;
  gameState: (state: GameStateClient) => void;
  notification: (msg: string) => void;
  chat: (payload: { name: string; msg: string }) => void;
  error: (msg: string) => void;
  /** 入房 / 重連成功時發放的席位憑證，client 存 sessionStorage 供重整後歸位 */
  session: (payload: { playerId: string; roomCode: string; token: string }) => void;
  /** 重連失敗（房間不存在 / 席位已被移除 / 憑證錯誤） */
  rejoinFailed: () => void;
}
