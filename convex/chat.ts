import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import { authPlayer } from './lib';

/** chat：發送訊息（落 chatMessages 表，取代原 ephemeral broadcast）。 */
export const send = mutation({
  args: {
    roomCode: v.string(),
    playerId: v.string(),
    token: v.string(),
    msg: v.string(),
  },
  handler: async (ctx, args) => {
    const { engine } = await authPlayer(ctx, args);
    const name = engine.state.players[args.playerId]?.name ?? '???';
    await ctx.db.insert('kindred_chatMessages', {
      roomCode: args.roomCode.toUpperCase(),
      name,
      msg: String(args.msg).slice(0, 200),
    });
    return null;
  },
});

/** chat.list：最近 50 則（依插入順序，舊→新）。 */
export const list = query({
  args: { roomCode: v.string() },
  handler: async (ctx, { roomCode }) => {
    const rows = await ctx.db
      .query('kindred_chatMessages')
      .withIndex('by_room', (q) => q.eq('roomCode', roomCode.toUpperCase()))
      .order('desc')
      .take(50);
    return rows.reverse().map((r) => ({ name: r.name, msg: r.msg }));
  },
});
