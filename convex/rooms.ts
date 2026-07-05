import { mutation } from './_generated/server';
import { v, ConvexError } from 'convex/values';
import { GameEngine } from '../server/src/gameEngine';
import {
  authPlayer,
  loadRoom,
  makePlayerId,
  makeRoomCode,
  makeToken,
  persist,
} from './lib';

/** createRoom：建房並成為房主，回傳席位憑證。 */
export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    // 產生不重複的房號
    let code = makeRoomCode();
    while (await loadRoom(ctx, code)) code = makeRoomCode();

    const engine = new GameEngine(code);
    const playerId = makePlayerId();
    const token = makeToken();
    engine.addPlayer(playerId, name.slice(0, 16));

    await ctx.db.insert('kindred_rooms', {
      code,
      state: engine.state,
      hostId: playerId, // 建房者為房主
      playbackGen: 0,
      advanceReady: [],
      skipVotes: [],
      updatedAt: Date.now(),
    });
    await ctx.db.insert('kindred_sessions', {
      roomCode: code,
      playerId,
      name: name.slice(0, 16),
      token,
      lastSeen: Date.now(),
    });

    return { roomCode: code, playerId, token };
  },
});

/** joinRoom：加入既有房間，回傳席位憑證。 */
export const join = mutation({
  args: { code: v.string(), name: v.string() },
  handler: async (ctx, { code, name }) => {
    const room = await loadRoom(ctx, code);
    if (!room) throw new ConvexError('找不到房間');

    const engine = GameEngine.fromState(room.state);
    if (Object.keys(engine.state.players).length >= 6) {
      throw new ConvexError('房間已滿（最多 6 人）');
    }
    if (!['LOBBY', 'CLAN_SELECT'].includes(engine.state.phase)) {
      throw new ConvexError('遊戲已開始');
    }

    const playerId = makePlayerId();
    const token = makeToken();
    engine.addPlayer(playerId, name.slice(0, 16));

    await persist(ctx, room, engine);
    await ctx.db.insert('kindred_sessions', {
      roomCode: room.code,
      playerId,
      name: name.slice(0, 16),
      token,
      lastSeen: Date.now(),
    });

    return { roomCode: room.code, playerId, token };
  },
});

/** lastSeen 心跳：不自動踢人，僅供大廳顯示離線標記用。 */
export const heartbeat = mutation({
  args: { roomCode: v.string(), playerId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('kindred_sessions')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .unique();
    if (session && session.playerId === args.playerId) {
      await ctx.db.patch(session._id, { lastSeen: Date.now() });
    }
    return null;
  },
});

/**
 * 明確離開（大廳/終局）：移除席位。
 * 保留 server.ts removePlayerNow 的引擎呼叫（handlePlayerLeft + removePlayer），
 * 但不含斷線寬限計時器（狀態永久保存，玩家隨時可用 token 歸位）。
 */
export const leave = mutation({
  args: { roomCode: v.string(), playerId: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const { room, engine } = await authPlayer(ctx, args);
    const name = engine.state.players[args.playerId]?.name;
    if (name) engine.log(`${name} 離開了遊戲`);
    engine.handlePlayerLeft(args.playerId);
    engine.removePlayer(args.playerId);

    const advanceReady = room.advanceReady.filter((id) => id !== args.playerId);
    const skipVotes = room.skipVotes.filter((id) => id !== args.playerId);

    // 刪除該席位的 session
    const session = await ctx.db
      .query('kindred_sessions')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .unique();
    if (session) await ctx.db.delete(session._id);

    if (Object.keys(engine.state.players).length === 0) {
      // 房間清空：刪房 + 殘留 session + chat
      await ctx.db.delete(room._id);
      for (const s of await ctx.db
        .query('kindred_sessions')
        .withIndex('by_room', (q) => q.eq('roomCode', room.code))
        .collect()) {
        await ctx.db.delete(s._id);
      }
      for (const m of await ctx.db
        .query('kindred_chatMessages')
        .withIndex('by_room', (q) => q.eq('roomCode', room.code))
        .collect()) {
        await ctx.db.delete(m._id);
      }
      return null;
    }

    // 房主離開 → 移交給任一剩餘玩家（key 已被 Convex 排序，取第一個即可）
    const remaining = Object.keys(engine.state.players);
    const hostId =
      room.hostId === args.playerId ? remaining[0] : room.hostId;

    // bump playbackGen：讓任何已排程的演出 tick 失效
    await ctx.db.patch(room._id, {
      state: engine.state,
      updatedAt: Date.now(),
      advanceReady,
      skipVotes,
      hostId,
      playbackGen: room.playbackGen + 1,
    });
    return null;
  },
});
