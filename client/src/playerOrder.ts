import type { GameStateClient, PlayerPublic } from '@kindred/shared'

// ── 座位順序單一真相 ──────────────────────────────────────────
// Convex 儲存會把 state.players 的物件 key 依字典序排序，插入（加入）順序不保證保留。
// 因此任何「依座位排列」的邏輯都不能用 Object.keys(players)，一律改用 state.playerOrder。
// playerOrder 於開局（startRound）才填入；LOBBY/CLAN_SELECT/HAND_BUILD 為空，
// 此時退回 Object.keys（僅影響大廳/選氏族的 chip 排列，純視覺、無正確性問題）。

/** 依座位順序回傳玩家 id 陣列。 */
export function seatIds(gs: GameStateClient): string[] {
  const ordered = gs.playerOrder.filter((id) => gs.players[id])
  if (ordered.length === Object.keys(gs.players).length) return ordered
  // playerOrder 尚未填入（或缺人）→ 補上未列入者，維持穩定顯示
  const extra = Object.keys(gs.players).filter((id) => !ordered.includes(id))
  return [...ordered, ...extra]
}

/** 依座位順序回傳玩家物件陣列。 */
export function seatPlayers(gs: GameStateClient): PlayerPublic[] {
  return seatIds(gs).map((id) => gs.players[id])
}
