/**
 * Regression: 未回應的效果選擇（pendingChoices）絕不能被確認票推進到下一地點。
 *
 * 生產事故（房 OMJS）：rack 結算後 VE09 狩獵選擇未回應，
 * 演出期間搶先按下的確認票 + readyAdvance 不檢查 pendingChoices，
 * 使遊戲帶著殘留選擇進入下一地點 WITHDRAW —— waitingFor 被選擇持有者
 * 佔據，所有人的撤退按鈕都被 UI 判定為「已提交」而消失，全房軟鎖。
 *
 * 對齊舊 socket server 語意：選擇未回應時，確認票被忽略。
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import { api } from '../_generated/api';
import schema from '../schema';

const modules = import.meta.glob('../**/*.*s');

async function setupChoicePendingRevelation() {
  const t = convexTest(schema, modules);
  const p1 = await t.mutation(api.rooms.create, { name: 'Alice' });
  const p2 = await t.mutation(api.rooms.join, { code: p1.roomCode, name: 'Bob' });
  const p3 = await t.mutation(api.rooms.join, { code: p1.roomCode, name: 'Carol' });

  // 直接鍛造中局狀態：loc0 已結算，VE09 選擇等待 p2 回應，
  // loc1 還有 p1 的未撤部署（因此 hasMoreLocations = true），
  // advanceReady 已有 p1/p3 的「演出期間搶先確認」殘票。
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
    s.currentLocResolved = true;
    for (const p of Object.values(s.players) as Array<{ isReady: boolean }>)
      p.isReady = true;
    s.deployments[locIds[1]] = [
      { playerId: p1.playerId, cardId: 'BR03', faceDown: true, bloodTokens: 1, withdrawn: false, effectivePower: 0 },
    ];
    s.pendingChoices = [
      {
        id: '0',
        playerId: p2.playerId,
        prompt_zh: '【Ventrue 狩獵】測試選擇：',
        options: [
          { key: 'give_blood', label_zh: '被偷取 2💧' },
          { key: 'give_influence', label_zh: '給予 1 影響力' },
        ],
        context: { cardId: 'VE09', locationId: locIds[0], sourcePlayerId: p1.playerId, sourceName: 'Alice' },
        choiceKey: `VE09:${locIds[0]}:${p2.playerId}`,
      },
    ];
    await ctx.db.patch(room!._id, {
      state: s,
      advanceReady: [p1.playerId, p3.playerId],
    });
  });
  return { t, p1, p2, p3, locIds };
}

describe('pendingChoices 與確認/加速票的互斥（軟鎖回歸）', () => {
  it('選擇未回應時 readyAdvance 全員投票也不得推進地點', async () => {
    const { t, p1, p2, p3 } = await setupChoicePendingRevelation();

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
    // 生產事故中這裡是 WITHDRAW + 殘留選擇 → 軟鎖
    expect(s!.phase).toBe('REVELATION');
    expect(s!.hasPendingChoices).toBe(true);
    expect(s!.waitingFor).toEqual([p2.playerId]);
  });

  it('選擇未回應時 skipEffects 全員投票也不得結束演出/跳過結算', async () => {
    const { t, p1, p2, p3 } = await setupChoicePendingRevelation();

    for (const p of [p1, p2, p3]) {
      await t.mutation(api.game.skipEffects, {
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
    expect(s!.phase).toBe('REVELATION');
    expect(s!.hasPendingChoices).toBe(true);
  });

  it('選擇回應後流程恢復：確認 ×3 → 下一地點 WITHDRAW，waitingFor 僅含有部署者', async () => {
    const { t, p1, p2, p3, locIds } = await setupChoicePendingRevelation();

    // 殘票先到（會被忽略）
    await t.mutation(api.game.readyAdvance, { roomCode: p1.roomCode, playerId: p1.playerId, token: p1.token });

    // p2 回應選擇 → finishReveal 清空 advanceReady
    await t.mutation(api.game.respondChoice, {
      roomCode: p1.roomCode,
      playerId: p2.playerId,
      token: p2.token,
      choiceId: '0',
      option: 'give_influence',
    });

    // 全員重新確認 → 推進到 loc1 的 WITHDRAW
    for (const p of [p1, p2, p3]) {
      await t.mutation(api.game.readyAdvance, { roomCode: p1.roomCode, playerId: p.playerId, token: p.token });
    }

    const s = await t.query(api.game.state, {
      roomCode: p1.roomCode,
      playerId: p1.playerId,
      token: p1.token,
    });
    expect(s!.phase).toBe('WITHDRAW');
    expect(s!.currentLocIndex).toBe(locIds.indexOf(locIds[1]));
    expect(s!.hasPendingChoices).toBe(false);
    // 軟鎖不變量：等待名單必須恰為「此地點有未撤部署」的玩家
    expect(s!.waitingFor).toEqual([p1.playerId]);
  });
});
