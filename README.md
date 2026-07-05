# Kindred — 桌遊線上版

多人即時桌遊。前端 React + Vite，後端 [Convex](https://convex.dev)（資料庫 + 即時訂閱 + 遊戲邏輯），
前端託管於 Vercel。**兩者免費方案即可完整營運**，不需要自己管伺服器。

> 目前的示範站（由 fork 維護者託管）：https://kindred-boardgame.vercel.app
> 要自己架一份，照著下面「自行架設」做，約 15 分鐘。

## 架構總覽

```
shared/   共用型別（GameStateFull / GameStateClient / 卡牌…）
server/   GameEngine 純狀態機 + 引擎測試 4300+（express server.ts 為遺留，已不再使用）
convex/   Convex 後端：schema、rooms/game/chat 函式、結算演出排程、admin ops 工具
client/   React 前端，convexGame.ts 封裝 Convex hooks
assets.zip  卡圖資產（版控來源；解壓後的 client/public/assets/ 不進版控）
```

遊戲狀態整包存於 `kindred_rooms.state`，mutation 內 `GameEngine.fromState()` 載入 → 執行 → 寫回；
`game.state` 是 reactive query，依 token 做每位玩家的隱藏資訊投影，玩家畫面自動即時同步。
設計決策與移植紀錄詳見 `docs/convex-migration-plan.md`。

## 本機開發

需求：Node 20+、npm。

```bash
npm install
unzip assets.zip -d client/public          # 卡圖（Windows：用檔案總管解壓到 client/public）
npx convex dev                             # 第一次會問：登入 Convex 帳號，或選匿名本地模式
```

`convex dev` 會把部署資訊寫進根目錄 `.env.local`（gitignored）。
接著建立 `client/.env.local`（gitignored），指向同一個部署：

```bash
# 匿名本地模式：
echo 'VITE_CONVEX_URL=http://127.0.0.1:3210' > client/.env.local
# 或雲端 dev 部署：把根目錄 .env.local 裡的 CONVEX_URL 值抄過來
```

之後日常開發只要：

```bash
npm run dev        # 同時啟動 convex dev（後端熱更新）+ vite（前端 http://localhost:5173）
```

開兩個瀏覽器分頁即可自己測多人（sessionStorage 每分頁獨立，各佔一個席位）。

## 測試

```bash
npm test -w server                               # 遊戲引擎測試（4300+）
npm test -w client                               # 前端元件測試
npx vitest run --config convex/vitest.config.ts  # Convex 函式測試（含軟鎖回歸）
```

## 自行架設（Production）

### 1. Convex 後端（免費）

```bash
npx convex login          # GitHub OAuth
npx convex deploy         # 第一次會引導建立專案；完成後印出 prod URL
```

記下印出的網址，長得像 `https://<兩個單字-數字>.convex.cloud` —— 這是你的後端。
之後每次改了 `convex/`、`server/src/gameEngine.ts` 或 `shared/`，重跑 `npx convex deploy` 即可。

### 2. Vercel 前端（免費）

方法 A —— CLI（最快）：

```bash
npm i -g vercel
vercel login
vercel link --yes --project <小寫專案名>    # 注意：Vercel 專案名必須全小寫
vercel env add VITE_CONVEX_URL production   # 貼上步驟 1 的 convex.cloud 網址
vercel env add VITE_CONVEX_URL preview      # 同上（可選）
vercel deploy --prod --yes
```

方法 B —— 網頁：vercel.com → Add New Project → import 你的 GitHub repo →
不用選 framework（根目錄的 `vercel.json` 已定義 build）→
Environment Variables 加 `VITE_CONVEX_URL` = 步驟 1 的網址 → Deploy。

`vercel.json` 的 build 流程會自動：解壓 `assets.zip` 到 `client/public`、build shared、build client。

### 3.（可選）讓 Vercel build 時自動同步部署 Convex 函式

預設流程下，後端（`npx convex deploy`）跟前端（`vercel deploy`）是分開部署的。
想要一次到位：到 Convex dashboard → 你的專案 → Production 部署 → Settings →
**Deploy Keys** → 產生一把 production deploy key，然後：

```bash
vercel env add CONVEX_DEPLOY_KEY production   # 貼上 key（這是機密，別進版控）
```

`vercel.json` 偵測到 `CONVEX_DEPLOY_KEY` 存在時，會改跑
`npx convex deploy --cmd 'npm run build -w client'`：先推 Convex 函式、
再自動注入正確的 `VITE_CONVEX_URL` 給前端 build —— 之後只要 `vercel deploy --prod` 一條指令。

> 也可以用 Vercel Marketplace 的 Convex 整合自動完成這一段，但注意：
> 一個整合資源 = 一個 Convex 專案；不要把同一個資源接到多個不同的 app 上
> （`convex deploy` 會整組替換部署上的函式，兩個 codebase 會互相覆蓋）。

### 營運小工具（internal mutations，只有你能跑）

```bash
# 房間卡死時：放棄所有未回應的效果選擇，讓遊戲繼續
npx convex run admin:forfeitPendingChoices '{"roomCode":"XXXX"}' --prod
# 清測試房（連同 sessions 與聊天訊息）
npx convex run admin:purgeRooms '{"codes":["XXXX","YYYY"]}' --prod
# 直接看資料
npx convex data kindred_rooms --prod
```

## 給 Claude / AI 助手的注意事項

這些是實際踩過的坑，改碼前先讀：

1. **Convex 會排序物件的 key。** 任何 `Record<string, …>` 存進資料庫再讀出來，key 都變字典序。
   絕對不要用 `Object.keys(state.players)[0]` 之類的「插入順序」邏輯 ——
   房主用 `rooms.hostId`，席位順序用 `state.playerOrder` 陣列（前端統一走 `client/src/playerOrder.ts`）。
2. **遊戲狀態必須可 JSON 序列化。** 引擎 state 不能放 `Set`/`Map`/函式
   （歷史教訓：`forestallImmune` 原本是 `Set`）。有 round-trip 測試把關（`server/src/__tests__/roundTrip.test.ts`）。
3. **「等待全員確認」的語意由 `awaitingConfirm()`（convex/game.ts）統一判定。**
   確認票（readyAdvance）與加速票（skipEffects）只在該狀態下有效；
   演出中、揭牌空窗、效果選擇未回應時投的票一律作廢。
   動這段前先跑 `convex/__tests__/pendingChoiceLock.test.ts` 與 `revelationConfirm.test.ts` ——
   這兩個檔案對應兩次真實的全房軟鎖事故。
4. **引擎（`server/src/gameEngine.ts`）被 convex/ 直接 import 打包**，改引擎 = 要重新 `npx convex deploy`。
   4300+ 個引擎測試是安全網，改完必跑。
5. **Vercel 專案名必須全小寫**；`CONVEX_DEPLOY_KEY` 是機密（Vercel 上標記 sensitive 後讀不回來，正常）。
6. **Convex 的 preview deployment 是付費功能**：`vercel.json` 在沒有 deploy key 的環境（如 preview build）
   會自動退回純前端 build，靠 `VITE_CONVEX_URL` 環境變數。
7. 表名有 `kindred_` 前綴，是為了在共用 Convex 部署時避免撞名 —— 沿用即可。
8. e2e（Playwright spec）目前停用：舊的 `__mockSocket` harness 隨 socket.io 移除而失效，
   `client/playwright.config.ts` 裡有 TODO。單元測試與 convex-test 覆蓋仍完整。
