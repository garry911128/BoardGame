import { ConvexError } from 'convex/values';
import { GameEngine } from '../server/src/gameEngine';
import type { GameStateFull } from '@kindred/shared';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

export type RoomDoc = Doc<'kindred_rooms'>;

/** 依房號取房間文件（房號一律大寫化）。 */
export async function loadRoom(
  ctx: QueryCtx | MutationCtx,
  roomCode: string,
): Promise<RoomDoc | null> {
  const code = (roomCode ?? '').toUpperCase();
  return await ctx.db
    .query('kindred_rooms')
    .withIndex('by_code', (q) => q.eq('code', code))
    .unique();
}

/** 把房間 state 掛回引擎。 */
export function engineOf(room: RoomDoc): GameEngine {
  return GameEngine.fromState(room.state as GameStateFull);
}

/**
 * 驗證 {roomCode, playerId, token} 對應到合法席位。
 * 房間不存在 → ConvexError('找不到房間')；憑證無效 → ConvexError('工作階段無效，請重新加入')。
 * 成功回傳 room 文件與掛好的引擎。
 */
export async function authPlayer(
  ctx: MutationCtx,
  args: { roomCode: string; playerId: string; token: string },
): Promise<{ room: RoomDoc; engine: GameEngine }> {
  const room = await loadRoom(ctx, args.roomCode);
  if (!room) throw new ConvexError('找不到房間');

  const session = await ctx.db
    .query('kindred_sessions')
    .withIndex('by_token', (q) => q.eq('token', args.token))
    .unique();
  if (
    !session ||
    session.playerId !== args.playerId ||
    session.roomCode !== room.code
  ) {
    throw new ConvexError('工作階段無效，請重新加入');
  }

  const engine = engineOf(room);
  if (!engine.state.players[args.playerId]) {
    throw new ConvexError('工作階段無效，請重新加入');
  }
  return { room, engine };
}

/** 寫回引擎 state（含 updatedAt），可附帶 advanceReady/skipVotes/playbackGen 變更。 */
export async function persist(
  ctx: MutationCtx,
  room: RoomDoc,
  engine: GameEngine,
  extra?: Partial<Pick<RoomDoc, 'advanceReady' | 'skipVotes' | 'playbackGen'>>,
): Promise<void> {
  await ctx.db.patch(room._id, {
    state: engine.state,
    updatedAt: Date.now(),
    ...extra,
  });
}

/** 產生 4 碼房號。 */
export function makeRoomCode(): string {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

/** 產生席位重連憑證。 */
export function makeToken(): string {
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

/** 產生終身不變的 playerId。 */
export function makePlayerId(): string {
  // crypto.randomUUID 在 Convex runtime 可用
  return crypto.randomUUID();
}
