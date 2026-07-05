import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { loadRoom, engineOf, persist } from './lib';

/**
 * Ops 工具：整批刪除房間（含 sessions 與聊天訊息）。測試房清理用。
 * 用法：npx convex run admin:purgeRooms '{"codes":["XXXX","YYYY"]}' --prod
 */
export const purgeRooms = internalMutation({
  args: { codes: v.array(v.string()) },
  handler: async (ctx, { codes }) => {
    const purged: string[] = [];
    for (const code of codes) {
      const room = await ctx.db
        .query('kindred_rooms')
        .withIndex('by_code', (q) => q.eq('code', code))
        .unique();
      if (!room) continue;
      for (const s of await ctx.db
        .query('kindred_sessions')
        .withIndex('by_room', (q) => q.eq('roomCode', code))
        .collect())
        await ctx.db.delete(s._id);
      for (const m of await ctx.db
        .query('kindred_chatMessages')
        .withIndex('by_room', (q) => q.eq('roomCode', code))
        .collect())
        await ctx.db.delete(m._id);
      await ctx.db.delete(room._id);
      purged.push(code);
    }
    return { purged };
  },
});

/**
 * Ops 工具：放棄房間內所有未回應的效果選擇（效果不套用），解除卡死。
 * 用法：npx convex run admin:forfeitPendingChoices '{"roomCode":"XXXX"}' --prod
 */
export const forfeitPendingChoices = internalMutation({
  args: { roomCode: v.string() },
  handler: async (ctx, { roomCode }) => {
    const room = await loadRoom(ctx, roomCode);
    if (!room) return { ok: false, reason: 'room not found' };
    const engine = engineOf(room);
    const dropped = engine.state.pendingChoices.map(
      (c) => `${c.context.cardId}@${c.context.locationId}:${c.playerId}`,
    );
    if (dropped.length === 0) return { ok: true, dropped };
    engine.state.pendingChoices = [];
    engine.log('（系統修復）未回應的效果選擇已放棄，遊戲繼續');
    await persist(ctx, room, engine);
    return { ok: true, dropped };
  },
});
