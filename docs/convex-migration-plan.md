# Convex + Vercel 遷移計畫

**目標**：把 Express + Socket.IO 伺服器（記憶體內房間狀態）遷移到 Convex（資料庫 + 即時訂閱），
前端部署到 Vercel。遊戲狀態永久保存（重啟不掉局、玩家可隨時重連），免伺服器管理，免費額度即可營運。

**日期**：2026-07-05
**現況**：`server/` 589 行 socket 處理 + 2,069 行 GameEngine（純狀態機）+ 完整 vitest 測試套件。

---

## 0. 架構決策（已定案）

| 決策 | 選擇 | 理由 |
|---|---|---|
| 狀態存放 | 每房一份完整 `GameStateFull` 存在 `rooms.state`（`v.any()`） | 引擎已是單一可序列化物件；mutation 內 load → 跑引擎 → save，改動最小。文件上限 1MB，牌庫+log 遠低於此（log 需上限裁切） |
| 引擎位置 | 原地保留 `server/src/gameEngine.ts` + `cardData.ts`，`convex/` 直接 import | Convex esbuild 可打包 convex/ 外的 import；測試套件不必搬家，import 路徑不變，port 風險最低 |
| 身分驗證 | 延用現有 token 模型：join 時發 `{ playerId, token }`，client 存 sessionStorage，query/mutation 帶著驗證 | 與現行 rejoin 機制同構，hobby 遊戲夠用；不引入 Convex Auth 降低範圍 |
| 隱藏資訊 | `getClientState(playerId)` 投影邏輯照搬進 query；沒有合法 token 就給 `getSpectatorState()` | 已有現成投影函式，Convex query 天然 per-client |
| 結算演出 | `ctx.scheduler.runAfter` 自我排程的 internal mutation `effectTick` 逐步推進 `activeEffect`；skipVotes 全票 → 立即跑完剩餘 | 取代 server.ts 的 `playResolutionEffects` tick 計時器 |
| 斷線寬限計時器 | **整組刪除** | 狀態永久保存後「掉線 60 秒踢人」失去意義：玩家隨時可用 token 歸位。大廳幽靈玩家改用 lastSeen 心跳 + 顯示離線標記（不自動踢） |
| chat | 新 `chatMessages` 表 + query 訂閱 | 原本是 ephemeral broadcast，Convex 沒有 ephemeral event，落表最自然 |
| notification / error | mutation 回傳值 / ConvexError；client 以現有 toast 機制顯示 | 原 socket `notification`/`error` 事件的對應物 |
| assets（卡圖） | build 時把 `assets.zip` 解到 `client/public/`，Vercel 靜態伺服 `/assets/*` | zip 內已是 `assets/...` 結構，路徑與現行 `/assets/brujah/card_01.webp` 完全相容 |

### 已知序列化地雷
- `GameStateFull.forestallImmune: Record<string, Set<string>>` — **唯一**非 JSON 欄位。
  改成 `Record<string, string[]>`（shared/src/index.ts + gameEngine.ts 讀寫處 + 相關測試）。

---

## 1. Convex 後端（Phase 1 — backend agent）

### 1.1 專案設置
- 根目錄 `npm i convex`（root workspace devDep 或 dep 皆可，client 也要 `convex` 依賴供 React hooks）。
- 建 `convex/` 於 repo 根目錄；`convex.json` 不需特殊設定。
- 型別產生：`npx convex codegen`（免登入）。若需本地跑：`CONVEX_AGENT_MODE=anonymous npx convex dev --once`。
- **不要**嘗試 `npx convex login` — 那是使用者手動步驟（見 §4）。

### 1.2 Schema（`convex/schema.ts`）
```ts
rooms: defineTable({
  code: v.string(),               // 4 碼房號
  state: v.any(),                 // GameStateFull（序列化後）
  playbackGen: v.number(),        // 演出世代計數，防重複排程推進
  updatedAt: v.number(),
}).index('by_code', ['code']),

sessions: defineTable({
  roomCode: v.string(),
  playerId: v.string(),           // 沿用「入房時產生、終身不變」語意，改用 crypto id
  name: v.string(),
  token: v.string(),
  lastSeen: v.number(),
}).index('by_room', ['roomCode']).index('by_token', ['token']),

chatMessages: defineTable({
  roomCode: v.string(),
  name: v.string(),
  msg: v.string(),
}).index('by_room', ['roomCode']),
```

### 1.3 函式對照表（socket 事件 → Convex 函式）

所有 mutation 統一簽名前綴 `{ roomCode, playerId, token }`，內部以 helper `authPlayer(ctx, args)` 驗證。

| 原 socket 事件 | Convex 函式 | 備註 |
|---|---|---|
| `createRoom` | `rooms.create` mutation → `{ roomCode, playerId, token }` | 取代 `roomCreated` + `session` 事件 |
| `joinRoom` | `rooms.join` mutation → 同上 | 房滿/不存在丟 ConvexError |
| `rejoinRoom` | 不需要 — `game.state` query 驗 token，失敗回 `null`（= 原 `rejoinFailed`） | |
| `watchRoom` | `game.state` 不帶 token → spectator 投影 | |
| `readyStart` | `game.readyStart` mutation | 內含原 `tryAdvance` 相位推進邏輯 |
| `selectClan` | `game.selectClan` | |
| `selectHandCard` | `game.selectHandCard` | |
| `drainAlly` | `game.drainAlly` | |
| `submitDeployment` | `game.submitDeployment` | |
| `submitWithdraw` | `game.submitWithdraw` | 全交齊觸發 `finishLocWithdraw` → 排程演出 |
| `respondChoice` | `game.respondChoice` | |
| `readyAdvance` | `game.readyAdvance` | 原 `checkAdvanceReady` |
| `skipEffects` | `game.skipEffects` | 全票 → 立即結清剩餘演出 |
| `chat` | `chat.send` mutation + `chat.list` query（最近 50 則） | |
| （server 內部）`playResolutionEffects` | `internal.game.effectTick`（internalMutation，scheduler 自排程） | 用 `playbackGen` 防舊排程亂入 |
| `gameState` 廣播 | `game.state` query — Convex 自動 reactive，mutation 寫入即全員更新 | 原 `broadcast()` 整個消失 |

### 1.4 狀態推進邏輯搬遷
`server.ts` 的編排函式（`tryAdvance`、`finishLocWithdraw`、`runCurrentLocResolution`、
`finishReveal`、`checkAdvanceReady`）搬進 `convex/game.ts` 為普通 TS 函式，
在對應 mutation 內呼叫。引擎方法呼叫方式不變。

**引擎 hydrate 模式**（每個 mutation 的骨架）：
```ts
const room = await ctx.db.query('rooms').withIndex('by_code', q => q.eq('code', roomCode)).unique();
const engine = GameEngine.fromState(room.state);   // 新增靜態工廠：直接掛回 state
// ...呼叫引擎方法 / 編排邏輯...
await ctx.db.patch(room._id, { state: engine.state, updatedAt: Date.now() });
```
`GameEngine.fromState()` 是唯一需要加進引擎的新 API（constructor 目前只吃 roomCode）。

### 1.5 驗收標準（Phase 1 完成定義)
- `npx convex codegen` 與 `npx tsc`（convex 目錄）零錯誤。
- `npm test -w server` 全綠（引擎測試不得因 port 而壞；`forestallImmune` 改型後同步修測試）。
- 新增 `convex/__tests__/` 基本流程測試（convex-test 套件）：建房 → 入房 ×2 → ready → 選氏族，驗證 state query 投影正確、token 驗證會擋。

---

## 2. 前端遷移（Phase 2 — client agent）

### 2.1 原則
**`GameStateClient` 形狀完全不變** — query 回傳同一介面，六個 screen 的渲染邏輯零改動，
只換資料來源與動作發送方式。

### 2.2 改動清單
- `client/src/main.tsx`：包 `<ConvexProvider client={new ConvexReactClient(import.meta.env.VITE_CONVEX_URL)}>`。
- 刪 `client/src/socket.ts` → 新 `client/src/convexGame.ts`：
  - `useGameState(roomCode, session)` → `useQuery(api.game.state, ...)`
  - `useGameActions()` → 包好的 `useMutation` 集合，簽名對齊原 `socket.emit` 呼叫點
  - session 管理：沿用現行 sessionStorage 憑證邏輯（`{ playerId, roomCode, token }`）
- `App.tsx` + 六個 screen：`socket.emit('x', payload)` → `actions.x(payload)`；
  `socket.on('gameState')` → `useGameState` 回傳值。
- chat / notification / error：mutation try-catch 顯示 toast；chat 訂閱 `chat.list`。
- debug 攔截層（`dlog`）：搬到 `convexGame.ts` 的 action wrapper 與 useEffect on state 變化。
- 移除 `socket.io-client` 依賴與 vite proxy 設定（保留 `/assets` 本地 dev 用法：改為直接放 `client/public/assets`，dev/prod 一致）。

### 2.3 驗收標準
- `npm run build -w client` 零錯誤。
- `npm test -w client` 全綠（socket mock 換成 convex-test 或 hook mock；e2e 的 `__mockSocket` 機制改為 mock hooks，工作量大就先跳過 e2e、標記 TODO）。
- 本地全流程手動驗證：`npx convex dev`（匿名模式）+ `npm run dev -w client`，兩個分頁完整跑一局到 GAME_OVER。

---

## 3. 部署（Phase 3 — 驗證 + 部署設定）

- 根目錄 `vercel.json`（**已改用 Convex marketplace 整合流程** — 2026-07-05 使用者已在 Vercel 安裝
  Convex 整合，`CONVEX_DEPLOY_KEY` 已存在於 Production/Preview，sensitive、僅 build 時可用）：
  ```json
  {
    "installCommand": "npm install",
    "buildCommand": "unzip -o assets.zip -d client/public && npx convex deploy --cmd 'npm run build -w client' --cmd-url-env-var-name VITE_CONVEX_URL",
    "outputDirectory": "client/dist"
  }
  ```
  build 時 `convex deploy` 用 deploy key 推送 convex/ 函式到整合建立的 prod 部署，
  並自動注入 `VITE_CONVEX_URL` 給 client build — **不需手動設環境變數、不需手動 convex deploy**。
  （zip 內已含 `assets/` 前綴，解到 public 即得 `/assets/*` 路徑。）
  ⚠️ Phase 3 才切換 buildCommand — Phase 1/2 期間 convex/ 未完成，先維持純 client build。
- `npm run build -w client` 的 tsc 不得依賴 server workspace。
- README / CLAUDE.md 更新開發流程（`npx convex dev` + `npm run dev -w client`）。
- 清理：`server/package.json` 移除 express/socket.io 執行腳本（引擎與測試保留）；根 `dev` script 改為 concurrently convex dev + client dev。

---

## 4. 使用者手動步驟（狀態更新 2026-07-05）

1. ~~Convex 帳號登入~~ ✅ 已完成（`npx convex login`）。
2. ~~建立 prod 部署 / 設 VITE_CONVEX_URL~~ ✅ 由 Vercel Convex marketplace 整合接手
   （`CONVEX_DEPLOY_KEY` 已設，build 時自動 deploy + 注入 URL，見 §3）。
3. Vercel 專案 ✅ 已建立並可部署：`kindred-boardgame`（https://kindred-boardgame.vercel.app）。
4. 待確認：Convex 整合資源同時連到另一個 Vercel 專案（agrism）——
   請在 Convex dashboard 確認 kindred-boardgame 有自己獨立的 Convex 專案，避免與 agrism 共用資料庫。

---

## 5. 風險與緩解

| 風險 | 緩解 |
|---|---|
| 引擎某處偷用非序列化結構（除已知的 Set） | Phase 1 加 round-trip 測試：`JSON.parse(JSON.stringify(state))` 後引擎行為一致 |
| `state` 文件超過 1MB | `log` 裁到最近 200 條；牌庫是 id 陣列，遠低於上限 |
| 演出排程競態（skip 票 vs tick） | `playbackGen` 世代計數，舊排程進來先比對再動作；Convex mutation 天然序列化執行，無真併發 |
| e2e 測試依賴 `__mockSocket` | Phase 2 允許先停用 e2e、開 TODO issue，不擋遷移 |
| Convex 免費額度 | 回合制遊戲流量極低；playback tick 最密集也是每房每秒 1 mutation，可忽略 |
