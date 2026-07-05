/**
 * Basic Convex flow test (plan §1.5):
 *   建房 → 入房 ×2 → ready → 選氏族
 * Verifies:
 *   - rooms.create / rooms.join return { roomCode, playerId, token }
 *   - game.state projects hidden information per-player (private vs spectator)
 *   - token validation blocks: wrong/missing token → spectator projection;
 *     mutations with a bad token reject
 *   - the tryAdvance orchestration advances CLAN_SELECT → HAND_BUILD
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import { api } from '../_generated/api';
import schema from '../schema';

const modules = import.meta.glob('../**/*.*s');

describe('convex flow: create → join ×2 → ready → selectClan', () => {
  it('runs the lobby flow with correct projections and token gating', async () => {
    const t = convexTest(schema, modules);

    // 建房
    const p1 = await t.mutation(api.rooms.create, { name: 'Alice' });
    expect(p1.roomCode).toMatch(/^[A-Z0-9]{4}$/);
    expect(typeof p1.playerId).toBe('string');
    expect(typeof p1.token).toBe('string');

    // 入房 ×2
    const p2 = await t.mutation(api.rooms.join, { code: p1.roomCode, name: 'Bob' });
    const p3 = await t.mutation(api.rooms.join, { code: p1.roomCode, name: 'Carol' });
    expect(p2.roomCode).toBe(p1.roomCode);
    expect(p2.playerId).not.toBe(p1.playerId);
    expect(p3.playerId).not.toBe(p2.playerId);

    // 房間不存在 → null（client 視為 rejoinFailed）
    expect(await t.query(api.game.state, { roomCode: 'ZZZZ' })).toBeNull();

    // 非房主 ready（仍在 LOBBY）→ 擋（'只有房主可以開始遊戲'）
    await expect(
      t.mutation(api.game.readyStart, {
        roomCode: p1.roomCode,
        playerId: p2.playerId,
        token: p2.token,
      }),
    ).rejects.toThrow('只有房主可以開始遊戲');

    // ready（房主 p1 開始）→ CLAN_SELECT
    await t.mutation(api.game.readyStart, {
      roomCode: p1.roomCode,
      playerId: p1.playerId,
      token: p1.token,
    });
    let s1 = await t.query(api.game.state, {
      roomCode: p1.roomCode,
      playerId: p1.playerId,
      token: p1.token,
    });
    expect(s1!.phase).toBe('CLAN_SELECT');
    expect(Object.keys(s1!.players)).toHaveLength(3);

    // 選氏族 ×3 → 全選完 tryAdvance 進 HAND_BUILD
    await t.mutation(api.game.selectClan, { roomCode: p1.roomCode, playerId: p1.playerId, token: p1.token, clan: 'brujah' });
    await t.mutation(api.game.selectClan, { roomCode: p1.roomCode, playerId: p2.playerId, token: p2.token, clan: 'ventrue' });

    // 重複氏族 → 擋（'氏族已被選走或不合法'）
    await expect(
      t.mutation(api.game.selectClan, { roomCode: p1.roomCode, playerId: p3.playerId, token: p3.token, clan: 'brujah' }),
    ).rejects.toThrow('氏族已被選走或不合法');

    await t.mutation(api.game.selectClan, { roomCode: p1.roomCode, playerId: p3.playerId, token: p3.token, clan: 'toreador' });

    // 全員選完 → HAND_BUILD，且發了手牌選擇草稿（私人資訊）
    s1 = await t.query(api.game.state, { roomCode: p1.roomCode, playerId: p1.playerId, token: p1.token });
    expect(s1!.phase).toBe('HAND_BUILD');
    expect(s1!.players[p1.playerId].clan).toBe('brujah');
    expect(s1!.myHandBuildDraft.length).toBeGreaterThan(0); // 私人草稿可見

    // ─── 隱藏資訊：合法 token 看得到自己的私人狀態 ───
    const priv = await t.query(api.game.state, { roomCode: p1.roomCode, playerId: p1.playerId, token: p1.token });
    expect(priv!.myHandBuildDraft.length).toBeGreaterThan(0);
    expect(priv!.myBlood).toBeGreaterThan(0);

    // ─── 沒帶 token → 觀戰投影（無私人手牌/血液） ───
    const spec = await t.query(api.game.state, { roomCode: p1.roomCode });
    expect(spec!.myHandBuildDraft).toHaveLength(0);
    expect(spec!.myBlood).toBe(0);
    // 但公開資訊仍在
    expect(Object.keys(spec!.players)).toHaveLength(3);

    // ─── 錯誤 token → 也只給觀戰投影（不洩漏私人狀態） ───
    const forged = await t.query(api.game.state, {
      roomCode: p1.roomCode,
      playerId: p1.playerId,
      token: 'not-a-real-token',
    });
    expect(forged!.myHandBuildDraft).toHaveLength(0);
    expect(forged!.myBlood).toBe(0);

    // ─── 錯誤 token 的 mutation → 直接拒絕 ───
    await expect(
      t.mutation(api.game.selectHandCard, {
        roomCode: p1.roomCode,
        playerId: p1.playerId,
        token: 'not-a-real-token',
        cardId: priv!.myHandBuildDraft[0].id,
      }),
    ).rejects.toThrow();
  });

  it('chat.send + chat.list round-trips through the messages table', async () => {
    const t = convexTest(schema, modules);
    const p1 = await t.mutation(api.rooms.create, { name: 'Alice' });
    await t.mutation(api.chat.send, {
      roomCode: p1.roomCode,
      playerId: p1.playerId,
      token: p1.token,
      msg: 'hello',
    });
    const msgs = await t.query(api.chat.list, { roomCode: p1.roomCode });
    expect(msgs).toEqual([{ name: 'Alice', msg: 'hello' }]);
  });
});
