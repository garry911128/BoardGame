import { describe, it, expect } from 'vitest';
import { GameEngine } from '../gameEngine';
import { makePlayer, makeSlot } from './helpers';

const LOC = 'rack';

function aftermath(engine: GameEngine, winner: string | null = null) {
  const s = engine.state;
  const active = s.deployments[LOC].filter(sl => !sl.withdrawn);
  const result = {
    bloodEvents: [], stepEvents: { prepare: [], conflict: [], aftermath: [] },
    locationId: LOC, winner, second: null, scores: {}, influenceGained: {}, tie: false,
  };
  (engine as any).applyAftermath(LOC, active, result);
  return { result, active };
}

function setup2() {
  const engine = new GameEngine('TEST');
  engine.state.players['p1'] = makePlayer('p1', { blood: 10, alliance: [] });
  engine.state.players['p2'] = makePlayer('p2', { blood: 10, alliance: [] });
  return engine;
}

describe('applyAftermath', () => {
  describe('Hunt 類牌 (BR09/NO09/TO09/MA09/GA09) — 從每個對手偷 1 血', () => {
    for (const cardId of ['BR09', 'NO09', 'TO09', 'MA09', 'GA09']) {
      it(`${cardId}：對手扣 1，持牌者 +1`, () => {
        const engine = setup2();
        engine.state.deployments[LOC] = [makeSlot('p1', cardId), makeSlot('p2', 'VE08')];
        aftermath(engine);
        expect(engine.state.players['p1'].blood).toBe(11);
        expect(engine.state.players['p2'].blood).toBe(9);
      });
    }

    it('對手血液為 0：不偷', () => {
      const engine = setup2();
      engine.state.players['p2'].blood = 0;
      engine.state.deployments[LOC] = [makeSlot('p1', 'BR09'), makeSlot('p2', 'VE08')];
      aftermath(engine);
      expect(engine.state.players['p1'].blood).toBe(10);
    });
  });

  describe('TR09 狩獵(Tremere) — 消耗 1 血，從每個對手偷 1', () => {
    it('有血可消耗：-1 +1（一個對手）', () => {
      const engine = setup2();
      engine.state.deployments[LOC] = [makeSlot('p1', 'TR09'), makeSlot('p2', 'VE08')];
      aftermath(engine);
      expect(engine.state.players['p1'].blood).toBe(10); // -1+1=0 net
      expect(engine.state.players['p2'].blood).toBe(9);
    });

    it('血量為 0：不啟動', () => {
      const engine = setup2();
      engine.state.players['p1'].blood = 0;
      engine.state.deployments[LOC] = [makeSlot('p1', 'TR09'), makeSlot('p2', 'VE08')];
      aftermath(engine);
      expect(engine.state.players['p2'].blood).toBe(10); // not stolen
    });
  });

  describe('BR04 該隱之拳 — 對手失去 round 數量的血', () => {
    it('第 2 回合：對手失去 2', () => {
      const engine = setup2();
      engine.state.round = 2;
      engine.state.deployments[LOC] = [makeSlot('p1', 'BR04'), makeSlot('p2', 'VE08')];
      aftermath(engine);
      expect(engine.state.players['p2'].blood).toBe(8);
    });

    it('血量不足：不低於 0', () => {
      const engine = setup2();
      engine.state.round = 15;
      engine.state.players['p2'].blood = 3;
      engine.state.deployments[LOC] = [makeSlot('p1', 'BR04'), makeSlot('p2', 'VE08')];
      aftermath(engine);
      expect(engine.state.players['p2'].blood).toBe(0);
    });
  });

  describe('BR05 打倒體制 — 勝者時對手失去 4；否則 2', () => {
    it('持牌者是勝者：對手失去 4', () => {
      const engine = setup2();
      engine.state.deployments[LOC] = [makeSlot('p1', 'BR05'), makeSlot('p2', 'VE08')];
      aftermath(engine, 'p1');
      expect(engine.state.players['p2'].blood).toBe(6);
    });

    it('持牌者非勝者：對手失去 2', () => {
      const engine = setup2();
      engine.state.deployments[LOC] = [makeSlot('p1', 'BR05'), makeSlot('p2', 'VE08')];
      aftermath(engine, 'p2');
      expect(engine.state.players['p2'].blood).toBe(8);
    });
  });

  describe('BR06 地震衝擊 — 對手失去 floor(總部署血液/2)', () => {
    it('總部署血液 6：對手失去 3', () => {
      const engine = setup2();
      engine.state.deployments[LOC] = [
        makeSlot('p1', 'BR06', { bloodTokens: 4 }),
        makeSlot('p2', 'VE08', { bloodTokens: 2 }),
      ];
      aftermath(engine);
      expect(engine.state.players['p2'].blood).toBe(7); // 10-3
    });

    it('總部署血液 1：floor(1/2)=0，無效果', () => {
      const engine = setup2();
      engine.state.deployments[LOC] = [
        makeSlot('p1', 'BR06', { bloodTokens: 1 }),
        makeSlot('p2', 'VE08', { bloodTokens: 0 }),
      ];
      aftermath(engine);
      expect(engine.state.players['p2'].blood).toBe(10);
    });
  });

  describe('GA01 融入大地 — 回收自己所有部署血液', () => {
    it('部署 3 血液代幣：全回收到資源池', () => {
      const engine = setup2();
      const slot = makeSlot('p1', 'GA01', { bloodTokens: 3 });
      engine.state.deployments[LOC] = [slot];
      aftermath(engine);
      expect(engine.state.players['p1'].blood).toBe(13);
      expect(slot.bloodTokens).toBe(0);
    });
  });

  describe('GA07 迷霧型態 — 移動部署血液一半至另一地點', () => {
    it('4 個代幣：移動 ceil(4/2)=2 至目標地點', () => {
      const engine = setup2();
      const targetLoc = 'asylum';
      engine.state.resolvedChoices[`GA07:${LOC}:p1`] = targetLoc;
      const slot = makeSlot('p1', 'GA07', { bloodTokens: 4 });
      engine.state.deployments[LOC] = [slot];
      aftermath(engine);
      expect(slot.bloodTokens).toBe(2);
      const targetSlot = engine.state.deployments[targetLoc].find(sl => sl.playerId === 'p1');
      expect(targetSlot?.bloodTokens).toBe(2);
    });
  });

  describe('TO01 敬畏 — 從每個對手偷 floor(同盟數/2) 血', () => {
    it('4 個同盟：偷 2', () => {
      const engine = setup2();
      engine.state.players['p1'].alliance = Array.from({ length: 4 }, (_, i) => ({
        id: `a${i}`, name: `A${i}`, type: 'human' as const, drainBlood: 1, influence: 1, drained: false,
      }));
      engine.state.deployments[LOC] = [makeSlot('p1', 'TO01'), makeSlot('p2', 'VE08')];
      aftermath(engine);
      expect(engine.state.players['p2'].blood).toBe(8);
      expect(engine.state.players['p1'].blood).toBe(12);
    });

    it('1 個同盟：floor(1/2)=0，不偷', () => {
      const engine = setup2();
      engine.state.players['p1'].alliance = [{ id: 'a1', name: 'A1', type: 'human', drainBlood: 1, influence: 1, drained: false }];
      engine.state.deployments[LOC] = [makeSlot('p1', 'TO01'), makeSlot('p2', 'VE08')];
      aftermath(engine);
      expect(engine.state.players['p2'].blood).toBe(10);
    });
  });

  describe('TO04 召喚 — 勝者獲得額外受害者牌', () => {
    it('持牌者是勝者：抽一張受害者牌', () => {
      const engine = setup2();
      const origLen = engine.state.victimDeck.length;
      engine.state.deployments[LOC] = [makeSlot('p1', 'TO04')];
      aftermath(engine, 'p1');
      expect(engine.state.players['p1'].alliance.length).toBe(1);
      expect(engine.state.victimDeck.length).toBe(origLen - 1);
    });

    it('持牌者非勝者：不抽', () => {
      const engine = setup2();
      engine.state.deployments[LOC] = [makeSlot('p1', 'TO04')];
      aftermath(engine, 'p2');
      expect(engine.state.players['p1'].alliance.length).toBe(0);
    });
  });

  describe('NO01 隱形通道 — 移至王子避難所', () => {
    it('在非 haven 地點：移至 haven', () => {
      const engine = setup2();
      const slot = makeSlot('p1', 'NO01');
      engine.state.deployments[LOC] = [slot];
      aftermath(engine);
      expect(engine.state.deployments[LOC].some(sl => sl === slot)).toBe(false);
      expect(engine.state.deployments['haven'].some(sl => sl.playerId === 'p1' && sl.cardId === 'NO01')).toBe(true);
    });

    it('已在 haven：不重複移動', () => {
      const engine = setup2();
      const slot = makeSlot('p1', 'NO01');
      engine.state.deployments['haven'] = [slot];
      const { aftermath: aftermathFn } = (() => {
        const s = engine.state;
        const active = s.deployments['haven'].filter(sl => !sl.withdrawn);
        const result = { bloodEvents: [], stepEvents: { prepare: [], conflict: [], aftermath: [] }, locationId: 'haven', winner: null, second: null, scores: {}, influenceGained: {}, tie: false };
        (engine as any).applyAftermath('haven', active, result);
        return { result, active };
      })();
      expect(engine.state.deployments['haven'].filter(sl => sl.cardId === 'NO01').length).toBe(1); // not duplicated
    });
  });

  describe('NO06 領先一步 — 對手每張面朝下牌付 2 血液或翻面', () => {
    it('對手有面朝下牌且有血：扣 2 血', () => {
      const engine = setup2();
      const rivalFdSlot = makeSlot('p2', 'VE08', { faceDown: true });
      engine.state.deployments[LOC] = [makeSlot('p1', 'NO06'), rivalFdSlot];
      aftermath(engine);
      expect(engine.state.players['p2'].blood).toBe(8);
      expect(rivalFdSlot.faceDown).toBe(true); // paid, so stays face-down
    });

    it('對手血量不足付 2：強制翻面', () => {
      const engine = setup2();
      engine.state.players['p2'].blood = 1;
      const rivalFdSlot = makeSlot('p2', 'VE08', { faceDown: true });
      engine.state.deployments[LOC] = [makeSlot('p1', 'NO06'), rivalFdSlot];
      aftermath(engine);
      expect(rivalFdSlot.faceDown).toBe(false); // forced flip
      expect(engine.state.players['p2'].blood).toBe(0);
    });
  });

  describe('MA06 馬爾卡夫詛咒 — 抽頂牌至此地點', () => {
    it('有牌組：抽頂牌部署到此地點', () => {
      const engine = setup2();
      engine.state.players['p1'].deck = [{ id: 'VE08', name_en: 'Ready', name_zh: '備戰', clan: 'ventrue', type: 'conflict', power: 2, is_starter: true }];
      engine.state.deployments[LOC] = [makeSlot('p1', 'MA06')];
      aftermath(engine);
      expect(engine.state.deployments[LOC].some(sl => sl.cardId === 'VE08' && sl.playerId === 'p1')).toBe(true);
      expect(engine.state.players['p1'].deck.length).toBe(0);
    });

    it('牌組為空：無效果', () => {
      const engine = setup2();
      engine.state.players['p1'].deck = [];
      engine.state.deployments[LOC] = [makeSlot('p1', 'MA06')];
      const before = engine.state.deployments[LOC].length;
      aftermath(engine);
      expect(engine.state.deployments[LOC].length).toBe(before);
    });
  });

  describe('VE07 先發制人 — 選擇對手面朝上牌，獲得其印刷戰力血液並免疫', () => {
    it('選擇目標：獲得印刷戰力血液', () => {
      const engine = setup2();
      engine.state.resolvedChoices[`VE07:${LOC}:p1`] = 'p2:BR01'; // BR01 power=6
      engine.state.deployments[LOC] = [makeSlot('p1', 'VE07'), makeSlot('p2', 'BR01')];
      aftermath(engine);
      expect(engine.state.players['p1'].blood).toBe(16); // 10+6
    });

    it('選擇目標：免疫設定', () => {
      const engine = setup2();
      engine.state.resolvedChoices[`VE07:${LOC}:p1`] = 'p2:BR01';
      engine.state.deployments[LOC] = [makeSlot('p1', 'VE07'), makeSlot('p2', 'BR01')];
      aftermath(engine);
      expect(engine.state.forestallImmune['p1']?.includes('BR01')).toBe(true);
    });

    it('未選擇目標：自動選最高印刷戰力', () => {
      const engine = setup2();
      engine.state.deployments[LOC] = [makeSlot('p1', 'VE07'), makeSlot('p2', 'BR01')]; // BR01 power=6
      aftermath(engine);
      expect(engine.state.players['p1'].blood).toBe(16);
    });
  });

  describe('TR05 血液坩堝 — 選擇付一半血，對手失去 4 血', () => {
    it('選擇啟動：付一半血，對手失去 4', () => {
      const engine = setup2();
      engine.state.players['p1'].blood = 8;
      engine.state.resolvedChoices[`TR05:${LOC}:p1`] = 'pay';
      engine.state.deployments[LOC] = [makeSlot('p1', 'TR05'), makeSlot('p2', 'VE08')];
      aftermath(engine);
      expect(engine.state.players['p1'].blood).toBe(4); // 8-4
      expect(engine.state.players['p2'].blood).toBe(6); // 10-4
    });

    it('選擇不啟動：無效果', () => {
      const engine = setup2();
      engine.state.resolvedChoices[`TR05:${LOC}:p1`] = 'skip';
      engine.state.deployments[LOC] = [makeSlot('p1', 'TR05'), makeSlot('p2', 'VE08')];
      aftermath(engine);
      expect(engine.state.players['p1'].blood).toBe(10);
      expect(engine.state.players['p2'].blood).toBe(10);
    });
  });

  describe('VE09 狩獵(Ventrue) — 勝者選擇被偷 2 血或給 1 影響力', () => {
    it('勝者選擇失去 2 血（預設）', () => {
      const engine = setup2();
      engine.state.deployments[LOC] = [makeSlot('p1', 'VE09'), makeSlot('p2', 'VE08')];
      aftermath(engine, 'p2'); // p2 is winner, VE09 belongs to p1
      expect(engine.state.players['p2'].blood).toBe(8); // 10-2
      expect(engine.state.players['p1'].blood).toBe(12); // 10+2
    });

    it('勝者選擇給予 1 影響力', () => {
      const engine = setup2();
      engine.state.players['p2'].influence = 3;
      engine.state.resolvedChoices[`VE09:${LOC}:p2`] = 'give_influence';
      engine.state.deployments[LOC] = [makeSlot('p1', 'VE09'), makeSlot('p2', 'VE08')];
      aftermath(engine, 'p2');
      expect(engine.state.players['p2'].influence).toBe(2); // 3-1
      expect(engine.state.players['p1'].influence).toBe(1); // 0+1
    });
  });
});
