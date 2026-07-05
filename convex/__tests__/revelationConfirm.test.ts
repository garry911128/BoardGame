/**
 * Regression: REVELATION 確認等待期的 waitingFor 與收票判定。
 *
 * QA 事故（deterministic）：撤退後全員 isReady=true，結算演出播完進入確認步，
 * advanceReady=[] 且舊判定式 `advanceReady.length > 0` 不成立 → waitingFor
 * 沿用引擎的 isReady 清單 = 空 → 全員 UI 顯示「已確認」、確認鈕不渲染、
 * 第一票永遠投不出來 → 全房死鎖，遊戲無法通過第一個地點。
 *
 * 舊 socket server 以「wait-set 是否存在」界定等待期（空集合也算等待中）；
 * 修正改用 awaitingConfirm()：REVELATION + 已結算 + 無演出 + 無選擇，或 ROUND_END。
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import { api } from '../_generated/api';
import schema from '../schema';

const modules = import.meta.glob('../**/*.*s');

type ForgeOpts = { resolved: boolean; activeEffect?: object | null };

async function setupRevelation({ resolved, activeEffect = null }: ForgeOpts) {
  const t = convexTest(schema, modules);
  const p1 = await t.mutation(api.rooms.create, { name: 'Alice' });
  const p2 = await t.mutation(api.rooms.join, { code: p1.roomCode, name: 'Bob' });
  const p3 = await t.mutation(api.rooms.join, { code: p1.roomCode, name: 'Carol' });

  let locIds: string[] = [];
  await t.run(async (ctx) => {
    const room = await ctx.db
      .query('kindred_rooms')
      .withIndex('by_code', (q) => q.eq('code', p1.roomCode))
      .unique();
    const s = room!.state;
    locIds = s.locations.map((l: { id: string }) => l.id);
    s.phase = 'REVELATION';
    s.round = 1;
    s.currentLocIndex = 0;
    s.currentLocResolved = resolved;
    s.activeEffect = activeEffect;
    // 撤退後的真實狀態：所有人 isReady=true（提交過或自動通過）
    for (const p of Object.values(s.players) as Array<{ isReady: boolean }>)
      p.isReady = true;
    // loc1 尚有未撤部署 → hasMoreLocations
    s.deployments[locIds[1]] = [
      { playerId: p1.playerId, cardId: 'BR03', faceDown: true, bloodTokens: 1, withdrawn: false, effectivePower: 0 },
    ];
    await ctx.db.patch(room!._id, { state: s, advanceReady: [] });
  });
  return { t, p1, p2, p3, locIds };
}

async function readRoom(t: ReturnType<typeof convexTest>, code: string) {
  return t.run(async (ctx: any) =>
    ctx.db
      .query('kindred_rooms')
      .withIndex('by_code', (q: any) => q.eq('code', code))
      .unique(),
  );
}

describe('REVELATION 確認等待期（死鎖回歸）', () => {
  it('演出播完、無人投票時，waitingFor 必須是全員（確認鈕才會渲染）', async () => {
    const { t, p1, p2, p3 } = await setupRevelation({ resolved: true });
    const s = await t.query(api.game.state, {
      roomCode: p1.roomCode,
      playerId: p1.playerId,
      token: p1.token,
    });
    // 死鎖版本這裡是 []（人人「已確認」、無人有按鈕）
    expect([...s!.waitingFor].sort()).toEqual(
      [p1.playerId, p2.playerId, p3.playerId].sort(),
    );
  });

  it('全員確認 → 推進到下一地點 WITHDRAW', async () => {
    const { t, p1, p2, p3, locIds } = await setupRevelation({ resolved: true });
    for (const p of [p1, p2, p3]) {
      await t.mutation(api.game.readyAdvance, {
        roomCode: p1.roomCode,
        playerId: p.playerId,
        token: p.token,
      });
    }
    const s = await t.query(api.game.state, {
      roomCode: p1.roomCode,
      playerId: p1.playerId,
      token: p1.token,
    });
    expect(s!.phase).toBe('WITHDRAW');
    expect(s!.currentLocIndex).toBe(locIds.indexOf(locIds[1]));
  });

  it('揭牌空窗（未結算）不收確認票，不得跳過結算推進', async () => {
    const { t, p1, p2, p3 } = await setupRevelation({ resolved: false });
    for (const p of [p1, p2, p3]) {
      await t.mutation(api.game.readyAdvance, {
        roomCode: p1.roomCode,
        playerId: p.playerId,
        token: p.token,
      });
    }
    const room = await readRoom(t, p1.roomCode);
    expect(room!.advanceReady).toEqual([]); // 票全數作廢
    expect(room!.state.phase).toBe('REVELATION'); // 未推進
  });

  it('演出進行中（activeEffect 非空）不收確認票', async () => {
    const { t, p1, p2, p3 } = await setupRevelation({
      resolved: true,
      activeEffect: { locationId: 'rack', step: 'conflict', eventIndex: 0, eventCount: 2, text: 'x' },
    });
    for (const p of [p1, p2, p3]) {
      await t.mutation(api.game.readyAdvance, {
        roomCode: p1.roomCode,
        playerId: p.playerId,
        token: p.token,
      });
    }
    const room = await readRoom(t, p1.roomCode);
    expect(room!.advanceReady).toEqual([]);
    expect(room!.state.phase).toBe('REVELATION');
  });
});
