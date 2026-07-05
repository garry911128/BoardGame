import { mutation, internalMutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { v, ConvexError } from 'convex/values';
import { authPlayer, engineOf, loadRoom, persist, type RoomDoc } from './lib';
import type { GameEngine } from '../server/src/gameEngine';
import type {
  GameStateFull,
  GameStateClient,
  StepEvent,
  ActiveEffect,
} from '@kindred/shared';

// 演出時序（原 server.ts 的 setTimeout 延遲）
const REVEAL_DELAY_MS = 1500;
const CHOICE_SCAN_DELAY_MS = 500;
const TICK_MS = 1200;
const FINISH_DELAY_MS = 900;

const authArgs = {
  roomCode: v.string(),
  playerId: v.string(),
  token: v.string(),
} as const;

// ─── State query（隱藏資訊投影 + 協調狀態覆蓋） ─────────────

export const state = query({
  args: {
    roomCode: v.string(),
    playerId: v.optional(v.string()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<GameStateClient | null> => {
    const room = await loadRoom(ctx, args.roomCode);
    if (!room) return null; // client 視為 rejoinFailed
    const engine = engineOf(room);

    // 驗 token → 個人化投影；否則觀戰投影
    let authed = false;
    if (args.playerId && args.token) {
      const session = await ctx.db
        .query('kindred_sessions')
        .withIndex('by_token', (q) => q.eq('token', args.token!))
        .unique();
      authed =
        !!session &&
        session.playerId === args.playerId &&
        session.roomCode === room.code &&
        !!engine.state.players[args.playerId];
    }

    const projection = authed
      ? engine.getClientState(args.playerId!)
      : engine.getSpectatorState();

    // 房主身分存在 rooms 文件（引擎 state 不認識），注入投影供大廳判定房主
    projection.hostId = room.hostId;

    // 原 broadcast() 的後處理：確認等待期 waitingFor = 尚未確認者。
    // 舊 server 以「wait-set 是否存在」判定等待期（空集合也算等待中）；
    // 這裡不能用 advanceReady.length > 0 —— 全員撤退後 isReady 皆 true，
    // 引擎 waitingFor 為空、按鈕不顯示、沒人能投出第一票 → 死鎖。
    if (awaitingConfirm(engine)) {
      const ready = new Set(room.advanceReady);
      projection.waitingFor = Object.keys(engine.state.players).filter(
        (id) => !ready.has(id),
      );
    }
    projection.skipVotes = room.skipVotes;
    return projection;
  },
});

// ─── 演出時間軸（自 lastConflictResults 決定性重建） ─────────

type TimelineStep = 'prepare' | 'conflict' | 'aftermath' | 'complete';

function buildTimeline(
  s: GameStateFull,
): Array<{ step: TimelineStep; event: StepEvent }> {
  const result = s.lastConflictResults[s.lastConflictResults.length - 1];
  if (!result) return [];
  const timeline: Array<{ step: TimelineStep; event: StepEvent }> = [
    ...result.stepEvents.prepare.map((event) => ({
      step: 'prepare' as const,
      event,
    })),
    ...result.stepEvents.conflict.map((event) => ({
      step: 'conflict' as const,
      event,
    })),
    ...result.stepEvents.aftermath.map((event) => ({
      step: 'aftermath' as const,
      event,
    })),
  ];
  const locName =
    s.locations.find((l) => l.id === result.locationId)?.name ??
    result.locationId;
  const winner = result.winner ? s.players[result.winner] : null;
  timeline.push({
    step: 'complete',
    event: {
      text: result.tie
        ? `${locName} 平手，無人獲得影響力`
        : `${winner?.name ?? '無人'} 贏得 ${locName}`,
      delta: result.winner
        ? { influence: result.influenceGained[result.winner] ?? 0 }
        : undefined,
    },
  });
  return timeline;
}

function timelineEffect(
  s: GameStateFull,
  timeline: Array<{ step: TimelineStep; event: StepEvent }>,
  index: number,
): ActiveEffect {
  const result = s.lastConflictResults[s.lastConflictResults.length - 1];
  const item = timeline[index];
  return {
    locationId: result.locationId,
    step: item.step,
    eventIndex: index,
    eventCount: timeline.length,
    sourceCardId: item.event.sourceCardId,
    sourcePlayerName: item.event.sourcePlayerName,
    targetPlayerName: item.event.targetPlayerName,
    text: item.event.text,
    delta: item.event.delta,
  };
}

// ─── 編排函式（原 server.ts） ──────────────────────────────

/** 相位自動推進；一律持久化本次動作造成的 state 變化。 */
/**
 * 是否處於「等待全員確認」狀態（= 舊 server 的 advanceReady wait-set 存在）。
 * REVELATION：本地點已結算、演出播完、無未回應選擇；ROUND_END：一律等待。
 * 唯有此狀態收確認票 / 覆寫 waitingFor —— 揭牌空窗與演出期間的票一律作廢，
 * 否則會在結算前推進地點（跳過結算）或湊票帶著未答選擇前進（軟鎖）。
 */
function awaitingConfirm(engine: GameEngine): boolean {
  const s = engine.state;
  if (s.pendingChoices.length > 0) return false;
  if (s.phase === 'ROUND_END') return true;
  return (
    s.phase === 'REVELATION' &&
    s.currentLocResolved &&
    s.activeEffect === null
  );
}

async function tryAdvance(
  ctx: any,
  room: RoomDoc,
  engine: GameEngine,
): Promise<void> {
  const s = engine.state;

  if (s.phase === 'CLAN_SELECT' && engine.allClansSelected()) {
    const playerIds = Object.keys(s.players);
    s.ambitionHolder = playerIds[Math.floor(Math.random() * playerIds.length)];
    engine.log(`隨機選出先手玩家：${s.players[s.ambitionHolder]?.name}`);
    engine.startHandBuild();
    await persist(ctx, room, engine);
    return;
  }
  if (s.phase === 'HAND_BUILD' && engine.allHandBuilt()) {
    engine.startRound();
    await persist(ctx, room, engine);
    return;
  }
  if (s.phase === 'PLANNING' && engine.allDeployed()) {
    engine.startResolutionPhase();
    await persist(ctx, room, engine);
    return;
  }
  if (s.phase === 'WITHDRAW' && engine.allWithdrawSubmitted()) {
    await finishLocWithdraw(ctx, room, engine);
    return;
  }
  await persist(ctx, room, engine);
}

/** 地點撤退全交齊 → 套用撤退，1.5s 後排程進入 REVELATION。 */
async function finishLocWithdraw(
  ctx: any,
  room: RoomDoc,
  engine: GameEngine,
): Promise<void> {
  engine.applyWithdrawals(); // phase 仍為 WITHDRAW，撤退的席位變可見
  const gen = room.playbackGen + 1;
  await persist(ctx, room, engine, { playbackGen: gen });
  await ctx.scheduler.runAfter(REVEAL_DELAY_MS, internal.game.revealStep, {
    roomCode: room.code,
    gen,
  });
}

/** 結算後收尾：偵測勝者選擇 → 等待，否則進入 REVELATION 供確認。 */
async function finishPlaybackInner(
  ctx: any,
  room: RoomDoc,
  engine: GameEngine,
  extra: Partial<Pick<RoomDoc, 'advanceReady' | 'skipVotes' | 'playbackGen'>> = {},
): Promise<void> {
  engine.state.activeEffect = null;
  engine.setupPostResolutionChoices();
  if (engine.state.pendingChoices.length > 0) {
    engine.state.phase = 'REVELATION';
    engine.state.activeEffect = null;
    // 演出期間搶先按下的確認票必須作廢：否則最後一票會在選擇未回應時
    // 湊滿 advanceReady，把未答的選擇帶進下一地點的 WITHDRAW（軟鎖）。
    await persist(ctx, room, engine, { advanceReady: [], skipVotes: [], ...extra });
    return;
  }
  // finishReveal：等待全員確認
  engine.state.phase = 'REVELATION';
  engine.state.activeEffect = null;
  await persist(ctx, room, engine, { advanceReady: [], skipVotes: [], ...extra });
}

/** 執行當前地點結算並啟動演出播放（scheduler 自排程 effectTick）。 */
async function runCurrentLocResolution(
  ctx: any,
  room: RoomDoc,
  engine: GameEngine,
): Promise<void> {
  engine.resolveCurrentLocation();
  const timeline = buildTimeline(engine.state);
  const gen = room.playbackGen + 1;

  if (timeline.length === 0) {
    await finishPlaybackInner(ctx, room, engine, { playbackGen: gen });
    return;
  }

  engine.state.phase = 'REVELATION';
  engine.state.activeEffect = timelineEffect(engine.state, timeline, 0);
  await persist(ctx, room, engine, { skipVotes: [], playbackGen: gen });

  if (timeline.length === 1) {
    await ctx.scheduler.runAfter(FINISH_DELAY_MS, internal.game.finishPlayback, {
      roomCode: room.code,
      gen,
    });
  } else {
    await ctx.scheduler.runAfter(TICK_MS, internal.game.effectTick, {
      roomCode: room.code,
      index: 1,
      gen,
    });
  }
}

/** REVELATION 全員確認：推進到下一地點或結束回合。 */
async function checkAdvanceReady(
  ctx: any,
  room: RoomDoc,
  engine: GameEngine,
): Promise<void> {
  // 防禦：選擇未回應時絕不推進地點，否則殘留選擇會污染下一階段的 waitingFor
  if (engine.state.pendingChoices.length > 0) return;
  if (engine.state.phase === 'REVELATION') {
    if (engine.hasMoreLocations()) {
      engine.advanceToNextLocation();
      await persist(ctx, room, engine, { advanceReady: [] });
      return;
    }
    engine.endRound();
    // ROUND_END 或 GAME_OVER 都清空 advanceReady；ROUND_END 會再等一次確認
    await persist(ctx, room, engine, { advanceReady: [] });
  } else if (engine.state.phase === 'ROUND_END') {
    engine.startHandBuild();
    await persist(ctx, room, engine, { advanceReady: [] });
  }
}

async function finishReveal(
  ctx: any,
  room: RoomDoc,
  engine: GameEngine,
): Promise<void> {
  engine.state.phase = 'REVELATION';
  engine.state.activeEffect = null;
  await persist(ctx, room, engine, { advanceReady: [] });
}

// ─── 排程 internal mutations（演出推進） ───────────────────

export const revealStep = internalMutation({
  args: { roomCode: v.string(), gen: v.number() },
  handler: async (ctx, { roomCode, gen }) => {
    const room = await loadRoom(ctx, roomCode);
    if (!room || room.playbackGen !== gen) return; // 舊排程失效
    const engine = engineOf(room);
    const s = engine.state;
    s.phase = 'REVELATION';
    const loc = s.locations[s.currentLocIndex];
    if (loc) {
      const revealed = engine.revealLocation(loc.id);
      s.activeEffect =
        revealed > 0
          ? {
              locationId: loc.id,
              step: 'reveal',
              eventIndex: 0,
              eventCount: revealed,
              text: `揭開 ${loc.name} 的 ${revealed} 張暗牌`,
            }
          : null;
    }
    await persist(ctx, room, engine);
    await ctx.scheduler.runAfter(
      CHOICE_SCAN_DELAY_MS,
      internal.game.postRevealStep,
      { roomCode, gen },
    );
  },
});

export const postRevealStep = internalMutation({
  args: { roomCode: v.string(), gen: v.number() },
  handler: async (ctx, { roomCode, gen }) => {
    const room = await loadRoom(ctx, roomCode);
    if (!room || room.playbackGen !== gen) return;
    const engine = engineOf(room);
    engine.setupPendingChoices();
    if (engine.state.pendingChoices.length > 0) {
      engine.state.activeEffect = null;
      await persist(ctx, room, engine);
      return;
    }
    await runCurrentLocResolution(ctx, room, engine);
  },
});

export const effectTick = internalMutation({
  args: { roomCode: v.string(), index: v.number(), gen: v.number() },
  handler: async (ctx, { roomCode, index, gen }) => {
    const room = await loadRoom(ctx, roomCode);
    if (!room || room.playbackGen !== gen) return; // skip / restart 後失效
    const engine = engineOf(room);
    const timeline = buildTimeline(engine.state);
    if (index >= timeline.length) {
      await finishPlaybackInner(ctx, room, engine);
      return;
    }
    engine.state.phase = 'REVELATION';
    engine.state.activeEffect = timelineEffect(engine.state, timeline, index);
    await persist(ctx, room, engine);
    if (index === timeline.length - 1) {
      await ctx.scheduler.runAfter(
        FINISH_DELAY_MS,
        internal.game.finishPlayback,
        { roomCode, gen },
      );
    } else {
      await ctx.scheduler.runAfter(TICK_MS, internal.game.effectTick, {
        roomCode,
        index: index + 1,
        gen,
      });
    }
  },
});

export const finishPlayback = internalMutation({
  args: { roomCode: v.string(), gen: v.number() },
  handler: async (ctx, { roomCode, gen }) => {
    const room = await loadRoom(ctx, roomCode);
    if (!room || room.playbackGen !== gen) return;
    const engine = engineOf(room);
    await finishPlaybackInner(ctx, room, engine);
  },
});

// ─── 玩家動作 mutations ────────────────────────────────────

export const readyStart = mutation({
  args: authArgs,
  handler: async (ctx, args) => {
    const { room, engine } = await authPlayer(ctx, args);
    if (engine.state.phase !== 'LOBBY') return null;
    const players = Object.values(engine.state.players);
    if (players.length < 2) throw new ConvexError('至少需要 2 名玩家');
    // 房主判定用 room.hostId（不可依賴 players 物件 key 順序，Convex 會排序）
    if (room.hostId !== args.playerId)
      throw new ConvexError('只有房主可以開始遊戲');
    engine.startClanSelect();
    await persist(ctx, room, engine);
    return null;
  },
});

export const selectClan = mutation({
  args: { ...authArgs, clan: v.string() },
  handler: async (ctx, args) => {
    const { room, engine } = await authPlayer(ctx, args);
    const ok = engine.selectClan(args.playerId, args.clan as any);
    if (!ok) throw new ConvexError('氏族已被選走或不合法');
    engine.setReady(args.playerId);
    await tryAdvance(ctx, room, engine);
    return null;
  },
});

export const selectHandCard = mutation({
  args: { ...authArgs, cardId: v.string() },
  handler: async (ctx, args) => {
    const { room, engine } = await authPlayer(ctx, args);
    const ok = engine.selectHandCard(args.playerId, args.cardId);
    if (!ok) throw new ConvexError('手牌選擇失敗');
    await tryAdvance(ctx, room, engine);
    return null;
  },
});

export const drainAlly = mutation({
  args: { ...authArgs, allyId: v.string() },
  handler: async (ctx, args) => {
    const { room, engine } = await authPlayer(ctx, args);
    const ok = engine.drainAlly(args.playerId, args.allyId);
    if (!ok) throw new ConvexError('汲取失敗');
    await persist(ctx, room, engine);
    return null;
  },
});

export const submitDeployment = mutation({
  args: {
    ...authArgs,
    deployment: v.union(
      v.object({
        locationId: v.string(),
        cardId: v.string(),
        faceDown: v.boolean(),
        bloodTokens: v.number(),
      }),
      v.object({ skip: v.literal(true) }),
    ),
  },
  handler: async (ctx, args) => {
    const { room, engine } = await authPlayer(ctx, args);
    const ok = engine.submitDeployment(args.playerId, args.deployment);
    if (!ok)
      throw new ConvexError(
        '部署失敗（血液不足 / 牌不在手中 / 血液代幣超過 3）',
      );
    await tryAdvance(ctx, room, engine);
    return null;
  },
});

export const submitWithdraw = mutation({
  args: { ...authArgs, locationId: v.string(), withdraw: v.boolean() },
  handler: async (ctx, args) => {
    const { room, engine } = await authPlayer(ctx, args);
    engine.submitWithdraw(args.playerId, args.locationId, args.withdraw);
    await tryAdvance(ctx, room, engine);
    return null;
  },
});

export const respondChoice = mutation({
  args: { ...authArgs, choiceId: v.string(), option: v.string() },
  handler: async (ctx, args) => {
    const { room, engine } = await authPlayer(ctx, args);
    const choice = engine.state.pendingChoices.find(
      (c) => c.id === args.choiceId && c.playerId === args.playerId,
    );
    if (!choice) return null; // 不屬於此玩家：靜默忽略（同 server.ts）
    engine.applyPendingChoice(args.choiceId, args.option);
    if (engine.state.pendingChoices.length === 0) {
      if (!engine.state.currentLocResolved) {
        await runCurrentLocResolution(ctx, room, engine);
      } else {
        await finishReveal(ctx, room, engine);
      }
    } else {
      await persist(ctx, room, engine);
    }
    return null;
  },
});

export const readyAdvance = mutation({
  args: authArgs,
  handler: async (ctx, args) => {
    const { room, engine } = await authPlayer(ctx, args);
    // 僅在確認等待期收票（對齊舊 server：wait-set 不存在時忽略投票）
    if (!awaitingConfirm(engine)) return null;
    const advanceReady = room.advanceReady.includes(args.playerId)
      ? room.advanceReady
      : [...room.advanceReady, args.playerId];
    const allPlayerIds = Object.keys(engine.state.players);

    if (!allPlayerIds.every((pid) => advanceReady.includes(pid))) {
      // 尚未全員：僅記錄確認人數（reactive query 會更新 waitingFor）
      await ctx.db.patch(room._id, { advanceReady, updatedAt: Date.now() });
      return null;
    }
    // 全員確認 → 推進（advanceReady 清空由 checkAdvanceReady 負責）
    await checkAdvanceReady(ctx, room, engine);
    return null;
  },
});

export const skipEffects = mutation({
  args: authArgs,
  handler: async (ctx, args) => {
    const { room, engine } = await authPlayer(ctx, args);
    // 僅在演出真正進行中才有意義（對齊舊 server：無 playback 時 finish() 是 no-op）。
    // 否則在揭牌/選擇等待期全票會直接跳過結算本身，留下未解的狀態。
    if (
      engine.state.phase !== 'REVELATION' ||
      engine.state.activeEffect === null ||
      engine.state.activeEffect.step === 'reveal' ||
      engine.state.pendingChoices.length > 0
    )
      return null;
    const votes = room.skipVotes.includes(args.playerId)
      ? room.skipVotes
      : [...room.skipVotes, args.playerId];
    const everyone = Object.keys(engine.state.players).every((id) =>
      votes.includes(id),
    );
    if (everyone) {
      // 全票 → 立即結清剩餘演出；bump playbackGen 使已排程 tick 失效
      await finishPlaybackInner(ctx, room, engine, {
        playbackGen: room.playbackGen + 1,
      });
    } else {
      await ctx.db.patch(room._id, { skipVotes: votes, updatedAt: Date.now() });
    }
    return null;
  },
});
