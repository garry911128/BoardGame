import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  // 每房一份完整 GameStateFull（序列化後）存在 state。
  // advanceReady / skipVotes 是 server.ts 原本存在記憶體 Map 的席位協調狀態，
  // 引擎本身不認識它們，故不塞進 GameStateFull，改為 rooms 的額外欄位。
  kindred_rooms: defineTable({
    code: v.string(), // 4 碼房號
    state: v.any(), // GameStateFull（序列化後）
    // 房主 playerId。Convex 儲存會把物件 key 排序，故 state.players 的插入順序
    // 不保證保留；房主不能再用 Object.values(players)[0] 判定，必須顯式記錄。
    hostId: v.string(),
    playbackGen: v.number(), // 演出世代計數，防止舊排程 tick 亂入
    advanceReady: v.array(v.string()), // REVELATION/ROUND_END 已按「確認繼續」的 playerId
    skipVotes: v.array(v.string()), // 結算演出加速投票的 playerId
    updatedAt: v.number(),
  }).index('by_code', ['code']),

  kindred_sessions: defineTable({
    roomCode: v.string(),
    playerId: v.string(), // 沿用「入房時產生、終身不變」語意，改用 crypto id
    name: v.string(),
    token: v.string(),
    lastSeen: v.number(),
  })
    .index('by_room', ['roomCode'])
    .index('by_token', ['token']),

  kindred_chatMessages: defineTable({
    roomCode: v.string(),
    name: v.string(),
    msg: v.string(),
  }).index('by_room', ['roomCode']),
});
