import {
  GameStateFull, GameStateClient,
  PlayerPrivate, SlotFull, SlotVisible,
  ConflictResult, StepEvent, Deployment, ClanId, CardDef, LocationDef,
  PendingChoice,
} from '@kindred/shared';

/** 建立結構化事件，cardId 為觸發來源，delta 為數值變化 */
function ev(
  text: string,
  opts?: {
    cardId?: string;
    sourcePlayerName?: string;
    targetPlayerName?: string;
    delta?: { blood?: number; influence?: number; power?: number };
  }
): StepEvent {
  return {
    text,
    sourceCardId: opts?.cardId,
    sourcePlayerName: opts?.sourcePlayerName,
    targetPlayerName: opts?.targetPlayerName,
    delta: opts?.delta,
  };
}
import {
  LOCATIONS, CLAN_DEFS, CLAN_STARTERS, CLAN_DECKS,
  ALLY_POOL, VICTIM_POOL,
  getCardById, shuffle,
} from './cardData';
import { dlog } from './debug';

function drawCards(deck: CardDef[], n: number): { drawn: CardDef[]; rest: CardDef[] } {
  return { drawn: deck.slice(0, n), rest: deck.slice(n) };
}

export class GameEngine {
  state: GameStateFull;

  constructor(roomCode: string) {
    this.state = {
      roomCode,
      phase: 'LOBBY',
      round: 0,
      ambitionHolder: '',
      playerOrder: [],
      currentTurnPlayerId: '',
      currentLocIndex: -1,
      currentLocResolved: false,
      locations: LOCATIONS,
      players: {},
      deployments: Object.fromEntries(LOCATIONS.map(l => [l.id, []])),
      withdrawChoices: Object.fromEntries(LOCATIONS.map(l => [l.id, {}])),
      locationAllies: Object.fromEntries(LOCATIONS.map(l => [l.id, null])),
      allyDeck: shuffle([...ALLY_POOL]),
      victimDeck: shuffle([...VICTIM_POOL]),
      lastConflictResults: [],
      winner: null,
      log: [],
      pendingChoices: [],
      resolvedChoices: {},
      activeEffect: null,
      forestallImmune: {},
    };
  }

  /**
   * 從既有（已序列化）的 GameStateFull 直接掛回引擎，不重建初始狀態。
   * Convex mutation 每次 load → hydrate → 跑引擎 → save 的入口。
   * 繞過 constructor（後者只吃 roomCode 並重建全新狀態）。
   */
  static fromState(state: GameStateFull): GameEngine {
    const engine = Object.create(GameEngine.prototype) as GameEngine;
    engine.state = state;
    return engine;
  }

  // ─── 玩家管理 ───────────────────────────────

  addPlayer(id: string, name: string): void {
    this.state.players[id] = {
      id, name, clan: null,
      blood: 6, influence: 3,
      handCount: 0, allianceCount: 1, diablerie: 0,
      deploymentsLeft: 0, isReady: false,
      hand: [], deck: [], handBuildDraft: [],
      alliance: [{ id: 'v_start', name: 'Kine', type: 'human', influence: 1, feedBlood: 1, drainBlood: 2, drainInfluence: 0 }],
    };
    this.log(`${name} 加入了房間`);
  }

  removePlayer(id: string): void {
    const p = this.state.players[id];
    if (p) { this.log(`${p.name} 離開了房間`); delete this.state.players[id]; }
  }

  /** 斷線後清理：更新輪序、移轉野心代幣、若輪到此人則推進 */
  handlePlayerLeft(playerId: string): void {
    const s = this.state;
    s.playerOrder = s.playerOrder.filter(pid => pid !== playerId);
    if (s.ambitionHolder === playerId) {
      s.ambitionHolder = s.playerOrder.find(pid => s.players[pid]) ?? '';
      if (s.ambitionHolder) this.log(`${s.players[s.ambitionHolder]?.name} 繼承野心代幣`);
    }
    if (s.phase === 'PLANNING' && s.currentTurnPlayerId === playerId) {
      this.advanceTurn();
    }
  }

  /** 弒親 / 狂暴淘汰統一入口 */
  private eliminatePlayer(playerId: string): void {
    const s = this.state;
    const p = s.players[playerId];
    if (!p) return;
    this.log(`☠️ ${p.name} 因弒親代幣達 3，被逐出芝加哥！`);
    // 清除此玩家的部署
    for (const loc of s.locations) {
      s.deployments[loc.id] = s.deployments[loc.id].filter(sl => sl.playerId !== playerId);
    }
    // 更新輪序與野心代幣
    s.playerOrder = s.playerOrder.filter(pid => pid !== playerId);
    if (s.ambitionHolder === playerId) {
      s.ambitionHolder = s.playerOrder.find(pid => s.players[pid]) ?? '';
      if (s.ambitionHolder) this.log(`${s.players[s.ambitionHolder]?.name} 繼承野心代幣`);
    }
    const wasCurrent = s.currentTurnPlayerId === playerId;
    delete s.players[playerId];
    // 若只剩 1 名玩家，直接結束遊戲
    if (Object.keys(s.players).length <= 1) {
      this.endGame();
      return;
    }
    if (wasCurrent) this.advanceTurn();
  }

  selectClan(playerId: string, clan: ClanId): boolean {
    const p = this.state.players[playerId];
    if (!p || this.state.phase !== 'CLAN_SELECT') return false;
    const taken = Object.values(this.state.players).some(pl => pl.id !== playerId && pl.clan === clan);
    if (taken) return false;
    p.clan = clan;
    p.blood = CLAN_DEFS[clan].startBlood;
    p.influence = CLAN_DEFS[clan].startInfluence;
    this.log(`${p.name} 選擇了 ${CLAN_DEFS[clan].name_zh}`);
    return true;
  }

  setReady(playerId: string): void {
    const p = this.state.players[playerId];
    if (p) p.isReady = true;
  }

  allClansSelected(): boolean {
    const players = Object.values(this.state.players);
    return players.length >= 2 && players.every(p => p.clan !== null);
  }

  // ─── 遊戲流程 ───────────────────────────────

  startClanSelect(): void {
    const s = this.state;
    s.phase = 'CLAN_SELECT';
    Object.values(s.players).forEach(p => (p.isReady = false));

    // 依人數決定使用的地點：3–4 人用 3 個，5–6 人用 4 個
    const playerCount = Object.keys(s.players).length;
    const locCount = playerCount >= 5 ? 4 : 3;
    s.locations = LOCATIONS.slice(0, locCount - 1).concat(LOCATIONS.filter(l => l.isPrinces));
    s.deployments = Object.fromEntries(s.locations.map(l => [l.id, []]));
    s.withdrawChoices = Object.fromEntries(s.locations.map(l => [l.id, {}]));
    s.locationAllies = Object.fromEntries(s.locations.map(l => [l.id, null]));

    this.log('請各玩家選擇氏族');
  }

  // ─── 手牌建造 ────────────────────────────────

  startHandBuild(): void {
    const s = this.state;
    // 回合數在手牌建造開始時遞增:建造與其後的規劃/結算屬同一回合(1-based)
    s.round += 1;
    s.phase = 'HAND_BUILD';
    const is3p = Object.keys(s.players).length === 3;

    Object.values(s.players).forEach(p => {
      p.isReady = false;
      p.handBuildDraft = [];

      if (s.round === 1) {
        // 第一輪：初始化牌組，起始手牌固定（Hunt + Ready）
        p.deck = shuffle([...CLAN_DECKS[p.clan!]]);
        p.hand = [...CLAN_STARTERS[p.clan!]];
      }

      // 3 人第 1 輪：抽 3 選 2；其他：抽 2 選 1
      const drawCount = (is3p && s.round === 1) ? 3 : 2;
      const { drawn, rest } = drawCards(p.deck, drawCount);
      p.handBuildDraft = drawn;
      p.deck = rest;
    });

    this.log('手牌建造：請各玩家選擇要保留的牌');
  }

  allHandBuilt(): boolean {
    return Object.values(this.state.players).every(p => p.isReady);
  }

  selectHandCard(playerId: string, cardId: string): boolean {
    const s = this.state;
    if (s.phase !== 'HAND_BUILD') return false;
    const p = s.players[playerId];
    if (!p || p.isReady) return false;

    const is3p = Object.keys(s.players).length === 3;
    const keepCount = (is3p && s.round === 1) ? 2 : 1;

    const idx = p.handBuildDraft.findIndex(c => c.id === cardId);
    if (idx === -1) return false;

    const kept = p.handBuildDraft.splice(idx, 1)[0];
    p.hand.push(kept);

    // 剩餘的牌放回牌組底部
    if (p.hand.filter(c => !p.handBuildDraft.includes(c)).length >= keepCount + (s.round === 1 ? 2 : 0)) {
      // 已選夠：把 draft 剩餘放回底部
      p.deck = [...p.deck, ...p.handBuildDraft];
      p.handBuildDraft = [];
      p.isReady = true;
      p.handCount = p.hand.length;
      this.log(`${p.name} 完成手牌建造（${p.hand.length} 張）`);
    }

    return true;
  }

  // ─── 汲取同盟 ────────────────────────────────

  drainAlly(playerId: string, allyId: string): boolean {
    const s = this.state;
    if (!['PLANNING'].includes(s.phase)) return false;
    const p = s.players[playerId];
    if (!p) return false;

    const ally = p.alliance.find(a => a.id === allyId && !a.drained);
    if (!ally) return false;

    ally.drained = true;
    p.blood += ally.drainBlood;
    // 汲取不立即改變影響力:卡翻面後終局計分改用殘值 drainInfluence(endGame 處理)
    const drainGain = `+${ally.drainBlood}💧（終局影響力 ${ally.influence}→${ally.drainInfluence}）`;

    // 汲取吸血鬼盟友需承受弒親代幣
    if (ally.type === 'vampire') {
      p.diablerie += 1;
      this.log(`${p.name} 汲取 ${ally.name}（吸血鬼）→ ${drainGain}，承受 1 弒親代幣（共 ${p.diablerie}）`);
      if (p.diablerie >= 3) {
        p.allianceCount = p.alliance.length;
        this.eliminatePlayer(p.id);
        return true;
      }
    } else {
      this.log(`${p.name} 汲取 ${ally.name} → ${drainGain}`);
    }

    p.allianceCount = p.alliance.length;
    return true;
  }

  startRound(): void {
    const s = this.state;
    s.phase = 'PLANNING';
    s.lastConflictResults = [];
    s.activeEffect = null;

    // Reset deployments & withdrawals
    s.deployments = Object.fromEntries(LOCATIONS.map(l => [l.id, []]));
    s.withdrawChoices = Object.fromEntries(LOCATIONS.map(l => [l.id, {}]));

    // Place ally cards at each location
    s.locationAllies = {};
    for (const loc of LOCATIONS) {
      if (s.allyDeck.length > 0) {
        s.locationAllies[loc.id] = s.allyDeck.shift()!;
      } else {
        s.locationAllies[loc.id] = null;
      }
    }

    // 3 人特殊：第 1/2/3 回合各 3/4/5 次；其他：2/3/4 次
    const is3p = Object.keys(s.players).length === 3;
    const deployLimit = is3p
      ? ([0, 3, 4, 5][s.round] ?? 5)
      : ([0, 2, 3, 4][s.round] ?? 4);
    this.log(`── 第 ${s.round} / 3 回合開始 ──`);

    // 建立出牌順序（從 ambitionHolder 開始順序排列）
    const playerIds = Object.keys(s.players);
    const ambIdx = playerIds.indexOf(s.ambitionHolder);
    s.playerOrder = ambIdx >= 0
      ? [...playerIds.slice(ambIdx), ...playerIds.slice(0, ambIdx)]
      : [...playerIds];
    s.currentTurnPlayerId = s.playerOrder[0] ?? '';
    this.log(`出牌順序：${s.playerOrder.map(id => s.players[id]?.name ?? id).join(' → ')}`);

    Object.values(s.players).forEach(p => {
      p.isReady = false;
      p.deploymentsLeft = deployLimit;

      // Feed phase: gain blood from alliance (cap at 13);已汲取(翻面)的卡不餵食
      const feedGain = p.alliance.filter(a => !a.drained).reduce((sum, a) => sum + a.feedBlood, 0);
      p.blood = Math.max(0, Math.min(13, p.blood + feedGain));
      if (feedGain > 0) this.log(`${p.name} 從同盟獲得 +${feedGain} 血液`);
      else if (feedGain < 0) this.log(`${p.name} 支付同盟維持成本 ${feedGain} 血液`);

      // Feed phase: reset drained allies (回合結束後可再次使用)
      // NOTE: 根據規則，汲取應該是一次性的行為，汲取後的牌持續到遊戲結束
      // p.alliance.forEach(a => { a.drained = false; });
      p.handCount = p.hand.length;
      p.allianceCount = p.alliance.length;
    });

    this.log(`規劃階段：每位玩家可部署 ${deployLimit} 張牌`);
  }

  allDeployed(): boolean {
    return Object.values(this.state.players).every(p => p.isReady);
  }

  submitDeployment(playerId: string, deploy: Deployment | { skip: true }): boolean {
    const s = this.state;
    if (s.phase !== 'PLANNING') return false;
    const p = s.players[playerId];
    if (!p || p.isReady) return false;

    // 輪序控制：只有當前輪到的玩家才能部署
    if (s.currentTurnPlayerId !== playerId) return false;

    if ('skip' in deploy) {
      p.isReady = true;
      p.deploymentsLeft = 0;
      this.log(`${p.name} 結束本回合部署`);
      this.advanceTurn();
      return true;
    }

    const { locationId, cardId, faceDown, bloodTokens } = deploy;
    const cardIdx = p.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return false;

    // Face-down costs 1 blood (Nosferatu免費)
    const faceDownCost = (p.clan === 'nosferatu') ? 0 : (faceDown ? 1 : 0);
    const totalBloodCost = faceDownCost + bloodTokens;
    if (bloodTokens > 3) return false; // max 3 blood per deployment
    if (p.blood < totalBloodCost) return false;

    p.blood -= totalBloodCost;

    // TR04: Dark Pact — 消耗血液改部署至 TR04 所在地點
    if (totalBloodCost > 0) {
      for (const [locId, slots] of Object.entries(s.deployments)) {
        const tr04Slot = slots.find(sl => sl.cardId === 'TR04' && sl.playerId === playerId && !sl.faceDown);
        if (tr04Slot && locId !== locationId) {
          tr04Slot.bloodTokens += totalBloodCost;
          this.log(`${p.name} 黑暗契約：${totalBloodCost}💧 部署至 ${this.locName(locId)}`);
          break;
        }
      }
    }

    p.hand.splice(cardIdx, 1);
    p.handCount = p.hand.length;

    s.deployments[locationId].push({
      playerId, cardId, faceDown, bloodTokens,
      withdrawn: false, effectivePower: 0,
    });

    p.deploymentsLeft -= 1;
    if (p.deploymentsLeft <= 0 || p.hand.length === 0) {
      p.isReady = true;
      p.deploymentsLeft = 0;
    }

    this.log(`${p.name} 在 ${this.locName(locationId)} ${faceDown ? '秘密' : ''}部署了一張牌${bloodTokens > 0 ? `（+${bloodTokens}💧）` : ''}${p.isReady ? '（手牌耗盡）' : ''}`);

    // ── PLANNING 被動觸發 ────────────────────────────────────────────

    // GA06: On the Prowl — 對手在此地點出牌，GA06 擁有者 +1 血液代幣
    const ga06Slot = s.deployments[locationId].find(sl =>
      sl.cardId === 'GA06' && sl.playerId !== playerId && !sl.faceDown
    );
    if (ga06Slot) {
      ga06Slot.bloodTokens += 1;
      this.log(`${s.players[ga06Slot.playerId]?.name} 的正在狩獵：+1💧`);
    }

    // NO03: Eyes in the Dark — 對手在此地點出牌須面朝下，且 NO03 擁有者獲 +1 血液代幣
    const no03Slot = s.deployments[locationId].find(sl =>
      sl.cardId === 'NO03' && sl.playerId !== playerId && !sl.faceDown
    );
    if (no03Slot) {
      s.deployments[locationId][s.deployments[locationId].length - 1].faceDown = true;
      no03Slot.bloodTokens += 1;
      this.log(`${s.players[no03Slot.playerId]?.name} 的暗中眼目：強制面朝下，+1💧`);
    }

    // BR03: Challenge — 對手在「不同」地點出牌，各失去 1 血液
    Object.entries(s.deployments).forEach(([locId, slots]) => {
      if (locId === locationId) return;
      slots.forEach(sl => {
        if (sl.cardId === 'BR03' && sl.playerId !== playerId && !sl.faceDown) {
          if (p.blood > 0) {
            p.blood -= 1;
            this.log(`${p.name} 被 ${s.players[sl.playerId]?.name} 的挑戰宣言扣除 1💧`);
          }
        }
      });
    });

    // 每出一張牌就推進到下一位（round-robin）
    this.advanceTurn();

    return true;
  }

  private advanceTurn(): void {
    const s = this.state;
    // 取得仍未完成的玩家（按出牌順序）
    const activePlayers = s.playerOrder.filter(pid => {
      const p = s.players[pid];
      return p && !p.isReady;
    });
    if (activePlayers.length === 0) {
      s.currentTurnPlayerId = '';
      return;
    }
    const currentIdx = activePlayers.indexOf(s.currentTurnPlayerId);
    // 若當前玩家已不在 active 清單中（剛剛變 ready），indexOf 回傳 -1 → nextIdx = 0
    const nextIdx = (currentIdx + 1) % activePlayers.length;
    s.currentTurnPlayerId = activePlayers[nextIdx];
  }

  // ─── Resolution ─────────────────────────────

  // 進入結算階段的入口：先觸發 VE01，再從第一個地點開始撤退
  startResolutionPhase(): void {
    const s = this.state;
    s.lastConflictResults = [];
    s.withdrawChoices = Object.fromEntries(s.locations.map(l => [l.id, {}]));
    s.activeEffect = null;

    // VE01: Master Plan — 規劃結束時，此地點無部署的對手失去 1 影響力
    s.locations.forEach(loc => {
      const ve01Slot = s.deployments[loc.id].find(sl => sl.cardId === 'VE01' && !sl.faceDown);
      if (!ve01Slot) return;
      const owner = s.players[ve01Slot.playerId];
      if (!owner) return;
      const rivals = Object.values(s.players).filter(p => p.id !== ve01Slot.playerId);
      rivals.forEach(r => {
        const hasCard = s.deployments[loc.id].some(sl => sl.playerId === r.id);
        if (!hasCard) {
          r.influence = Math.max(0, r.influence - 1);
          this.log(`${r.name} 因 ${owner.name} 的縝密計畫失去 1 影響力`);
        }
      });
    });

    s.currentLocIndex = -1;
    this.advanceToNextLocation();
  }

  // 開始某個地點的撤退階段
  startLocWithdraw(locIndex: number): void {
    const s = this.state;
    const loc = s.locations[locIndex];
    if (!loc) return;

    s.phase = 'WITHDRAW';
    s.currentLocIndex = locIndex;
    s.currentLocResolved = false;
    Object.values(s.players).forEach(p => (p.isReady = false));

    // 在此地點沒有部署的玩家自動 ready
    Object.values(s.players).forEach(p => {
      const hasHere = s.deployments[loc.id].some(sl => sl.playerId === p.id && !sl.withdrawn);
      if (!hasHere) p.isReady = true;
    });

    this.log(`【${loc.name}】撤退階段`);
  }

  hasMoreLocations(): boolean {
    const s = this.state;
    return s.locations.some((loc, i) => i > s.currentLocIndex && s.deployments[loc.id]?.some(sl => !sl.withdrawn));
  }

  advanceToNextLocation(): void {
    const s = this.state;
    const nextIdx = s.locations.findIndex((loc, i) => i > s.currentLocIndex && s.deployments[loc.id]?.some(sl => !sl.withdrawn));
    if (nextIdx !== -1) this.startLocWithdraw(nextIdx);
  }

  submitWithdraw(playerId: string, locationId: string, withdraw: boolean): boolean {
    const s = this.state;
    if (s.phase !== 'WITHDRAW') return false;
    const p = s.players[playerId];
    if (!p) return false;

    // 只接受當前結算地點的選擇
    const currentLoc = s.locations[s.currentLocIndex];
    if (!currentLoc || locationId !== currentLoc.id) return false;

    const hasDeployment = s.deployments[locationId].some(sl => sl.playerId === playerId && !sl.withdrawn);
    if (!hasDeployment) return true;

    s.withdrawChoices[locationId][playerId] = withdraw;

    if (withdraw) this.log(`${p.name} 在 ${this.locName(locationId)} 選擇撤退`);
    else this.log(`${p.name} 在 ${this.locName(locationId)} 選擇留守`);

    // 此地點已作答即標記 ready
    p.isReady = true;

    return true;
  }

  allWithdrawSubmitted(): boolean {
    return Object.values(this.state.players).every(p => p.isReady);
  }

  // ─── Apply Withdrawals (pre-resolution step) ──────────────────
  // Marks slots as withdrawn and returns blood tokens WITHOUT running combat.
  // Called before resolveCurrentLocation() so players can see who withdrew first.
  applyWithdrawals(): void {
    const s = this.state;
    const haven = s.deployments['haven'];

    // 只處理當前結算地點
    const locations = [s.locations[s.currentLocIndex]].filter(Boolean);
    for (const loc of locations) {
      const choices = s.withdrawChoices[loc.id];
      const withdrawingIds = [...new Set(
        s.deployments[loc.id]
          .filter(sl => choices[sl.playerId] && !sl.withdrawn)
          .map(sl => sl.playerId)
      )];

      for (const playerId of withdrawingIds) {
        const p = s.players[playerId];
        if (!p) continue;

        const mySlots = s.deployments[loc.id].filter(sl => sl.playerId === playerId && !sl.withdrawn);
        if (mySlots.length === 0) continue;

        // 王子之地撤退：牌與血液全部取回，不參與戰鬥
        if (loc.isPrinces) {
          mySlots.forEach(sl => {
            sl.withdrawn = true;
            p.blood += sl.bloodTokens;
            sl.bloodTokens = 0;
            // 牌在 endRound 時自動回手
          });
          this.log(`${p.name} 從王子之地撤退，取回所有牌與血液`);
          continue;
        }

        // NO02: Cloak of Shadows — 移至 NO02 所在地點（翻開，血液歸還）
        const no02Loc = s.locations.find(l =>
          s.deployments[l.id].some(sl => sl.cardId === 'NO02' && sl.playerId === playerId && !sl.faceDown)
        );
        if (no02Loc && no02Loc.id !== loc.id) {
          mySlots.forEach(sl => {
            sl.withdrawn = true;
            const existing = s.deployments[no02Loc.id].find(ex => ex.playerId === playerId && ex.cardId === sl.cardId);
            if (existing) existing.bloodTokens += sl.bloodTokens;
            else s.deployments[no02Loc.id].push({ ...sl, faceDown: false, bloodTokens: sl.bloodTokens, withdrawn: false });
            sl.bloodTokens = 0;
          });
          this.log(`${p.name} 的陰影披風：撤退牌移至 ${no02Loc.name}`);
          continue;
        }

        // NO04: Feral Whispers — 血液歸還玩家，+2💧至 NO04 地點
        const no04Loc = s.locations.find(l =>
          s.deployments[l.id].some(sl => sl.cardId === 'NO04' && sl.playerId === playerId && !sl.faceDown)
        );
        if (no04Loc && no04Loc.id !== loc.id) {
          mySlots.forEach(sl => {
            sl.withdrawn = true;
            p.blood += sl.bloodTokens;
            sl.bloodTokens = 0;
          });
          const no04Slot = s.deployments[no04Loc.id].find(sl => sl.playerId === playerId);
          if (no04Slot) no04Slot.bloodTokens += 2;
          else s.deployments[no04Loc.id].push({ playerId: p.id, cardId: '', faceDown: false, bloodTokens: 2, withdrawn: false, effectivePower: 0 });
          this.log(`${p.name} 的野獸低語：撤退後 +2💧至 ${no04Loc.name}`);
          continue;
        }

        // 預設：血液歸還，牌翻成正面移往王子之地
        mySlots.forEach(sl => {
          sl.withdrawn = true;
          p.blood += sl.bloodTokens;
          haven.push({ ...sl, faceDown: false, bloodTokens: 0, withdrawn: false });
        });
        this.log(`${p.name} 在 ${loc.name} 撤退，取回血液，牌翻開移至王子之地`);
      }
    }
  }

  // ─── Full Resolution ─────────────────────────

  // 結算當前地點（逐地點流程用）
  resolveCurrentLocation(): ConflictResult {
    const s = this.state;
    const loc = s.locations[s.currentLocIndex];
    if (!loc) return { locationId: '', winner: null, second: null, scores: {}, influenceGained: {}, bloodEvents: [], stepEvents: { prepare: [], conflict: [], aftermath: [] }, tie: false };

    this.revealLocation(loc.id);
    s.currentLocResolved = true;
    const result = this.resolveLocation(loc);
    s.lastConflictResults.push(result);

    // 血量上限 cap 13
    Object.values(s.players).forEach(p => { p.blood = Math.min(13, p.blood); });
    Object.values(s.players).forEach(p => this.checkFrenzy(p));

    return result;
  }

  revealLocation(locationId: string): number {
    const slots = this.state.deployments[locationId] ?? [];
    let revealed = 0;
    slots.forEach(slot => {
      if (!slot.withdrawn && slot.faceDown) {
        slot.faceDown = false;
        revealed += 1;
      }
    });
    return revealed;
  }

  /** 結算完成後，掃描需要勝者做選擇的效果（VE09）*/
  setupPostResolutionChoices(): void {
    const s = this.state;
    let n = s.pendingChoices.length;

    // Only process the most recently resolved location
    const lastResult = s.lastConflictResults[s.lastConflictResults.length - 1];
    for (const result of (lastResult ? [lastResult] : [])) {
      const locId = result.locationId;
      const active = s.deployments[locId]?.filter(sl=>!sl.withdrawn) ?? [];
      for (const slot of active) {
        const card = getCardById(slot.cardId);
        if (!card || slot.faceDown) continue;
        const owner = s.players[slot.playerId];
        if (!owner) continue;

        if (card.id === 'VE09' && result.winner && result.winner !== slot.playerId) {
          const winner = s.players[result.winner];
          if (!winner) continue;
          const take = Math.min(winner.blood, 2);
          s.pendingChoices.push(this.makeChoice(n++, result.winner,
            `【Ventrue 狩獵】${owner.name} 的狩獵效果：你需選擇：`,
            [{ key:'give_blood',     label_zh:`被偷取 ${take}💧` },
             { key:'give_influence', label_zh:'給予 1 影響力' }],
            card.id, locId, slot.playerId, owner.name));
        }

        // NO09: 諾斯費拉圖狩獵 — 偷血後可選擇移至 Prince's Haven
        if (card.id === 'NO09' && locId !== 'haven') {
          s.pendingChoices.push(this.makeChoice(n++, slot.playerId,
            `【諾斯費拉圖狩獵】將此牌移至王子避難所？`,
            [{ key:'move_haven', label_zh:'移至王子避難所' },
             { key:'stay',       label_zh:'留在此地點' }],
            card.id, locId, slot.playerId, owner.name));
        }
      }
    }
  }

  private resolveLocation(loc: LocationDef): ConflictResult {
    const s = this.state;
    const active = s.deployments[loc.id].filter(sl => !sl.withdrawn);

    const result: ConflictResult = {
      locationId: loc.id,
      winner: null, second: null,
      scores: {}, influenceGained: {},
      bloodEvents: [],
      stepEvents: { prepare: [], conflict: [], aftermath: [] },
      tie: false,
    };

    if (active.length === 0) return result;

    dlog(`[resolve] ${s.roomCode} ── ${loc.name} ──`);
    active.forEach(sl => {
      const p = s.players[sl.playerId];
      const card = getCardById(sl.cardId);
      dlog(`[resolve]   ${p?.name} | ${card?.name_zh ?? sl.cardId}(${sl.cardId}) | ${sl.faceDown ? '面朝下' : '面朝上'} | 血液代幣:${sl.bloodTokens}`);
    });

    // TO06: 精確血量快照 — 在所有效果前記錄 TO06 持有者的血量
    const to06Snapshots: Record<string, number> = {};
    active.forEach(slot => {
      if (slot.cardId === 'TO06' && !slot.faceDown && !slot.withdrawn) {
        const p = s.players[slot.playerId];
        if (p) to06Snapshots[slot.playerId] = p.blood;
      }
    });

    // TR06: 精確血量快照 — 記錄 TR06 持有者在效果前的血量
    const tr06Snapshots: Record<string, number> = {};
    active.forEach(slot => {
      if (slot.cardId === 'TR06' && !slot.faceDown && !slot.withdrawn) {
        const p = s.players[slot.playerId];
        if (p) tr06Snapshots[slot.playerId] = p.blood;
      }
    });

    // TR04: 精確血量快照 — 記錄 TR04 持有者在效果前的血量（用於效果觸發的失血重導向）
    const tr04Snapshots: Record<string, number> = {};
    active.forEach(slot => {
      if (slot.cardId === 'TR04' && !slot.faceDown && !slot.withdrawn) {
        const p = s.players[slot.playerId];
        if (p) tr04Snapshots[slot.playerId] = p.blood;
      }
    });

    // ── Preparation effects ──────────────────────
    const prepStart = result.bloodEvents.length;
    this.applyPreparation(loc.id, active, result);
    result.stepEvents.prepare = result.bloodEvents.slice(prepStart);

    // ── Compute effective power ──────────────────
    active.forEach(slot => {
      const p = s.players[slot.playerId]!;
      if (slot.withdrawn) { slot.effectivePower = 0; return; }
      slot.effectivePower = this.computePower(slot, active, p, loc.id);
      result.scores[slot.playerId] = (result.scores[slot.playerId] ?? 0) + slot.effectivePower;
      const card = getCardById(slot.cardId);
      const cardLabel = card ? `${card.name_zh}(${slot.cardId})` : '(unknown)';
      const faceTag = slot.faceDown ? '[面朝下]' : '';
      const bloodTag = slot.bloodTokens > 0 ? ` +${slot.bloodTokens}💧` : '';
      dlog(`[resolve]   [戰力] ${p.name} | ${cardLabel}${faceTag}${bloodTag} → ${slot.effectivePower}pt (本地累計: ${result.scores[slot.playerId]})`);
    });

    // ── Conflict card effects ────────────────────
    const conflStart = result.bloodEvents.length;
    this.applyConflict(loc.id, active, result);
    result.stepEvents.conflict = result.bloodEvents.slice(conflStart);

    // ── Determine winner ─────────────────────────
    const playerIds = [...new Set(active.map(sl => sl.playerId))];
    const playerScores: Record<string, number> = {};
    playerIds.forEach(pid => {
      playerScores[pid] = active
        .filter(sl => sl.playerId === pid && !sl.withdrawn)
        .reduce((sum, sl) => sum + sl.effectivePower, 0);
    });

    const sorted = Object.entries(playerScores).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      // Tie: ambition holder LOSES (not first priority)
      const aIsAmbition = a[0] === s.ambitionHolder ? 1 : 0;
      const bIsAmbition = b[0] === s.ambitionHolder ? 1 : 0;
      return aIsAmbition - bIsAmbition;
    });

    result.scores = playerScores;

    if (sorted.length >= 1) {
      const [firstId, firstScore] = sorted[0];
      const [, ] = sorted[1] ?? [null, -1]; // secondId/secondScore unused; winner/second set via sorted[1][0]

      if (sorted.length >= 2 && firstScore === sorted[1][1] && firstId !== s.ambitionHolder && sorted[1][0] !== s.ambitionHolder) {
        result.tie = true;
        this.log(`${this.locName(loc.id)} 完全平局，無人獲得影響力`);
      } else {
        result.winner = firstId;
        if (sorted.length >= 2) result.second = sorted[1][0];

        // Influence rewards
        const round = s.round;
        const infTable = loc.influence; // [round-1][rank-1]
        const firstInf = infTable[round - 1]?.[0] ?? 0;
        const secondInf = infTable[round - 1]?.[1] ?? 0;

        const wp = s.players[firstId];
        if (wp) {
          wp.influence += firstInf;
          result.influenceGained[firstId] = firstInf;
        }
        if (result.second) {
          const sp = s.players[result.second];
          if (sp && secondInf > 0) {
            sp.influence += secondInf;
            result.influenceGained[result.second] = secondInf;
          }
        }

        // Win ally/victim
        if (wp) this.awardPrize(loc.id, result.winner!, result.second);

        // If Prince's Haven: transfer ambition token
        if (loc.isPrinces && result.winner) {
          s.ambitionHolder = result.winner;
          this.log(`${wp?.name} 取得野心代幣，成為新的先手玩家`);
        }

        const scoreStr = Object.entries(playerScores)
          .sort((a,b) => b[1]-a[1])
          .map(([pid, sc]) => `${s.players[pid]?.name}:${sc}`)
          .join(' / ');
        this.log(`${this.locName(loc.id)} 勝者：${wp?.name}（${firstScore}点）+${firstInf}Inf ｜ ${scoreStr}`);
      }
    }

    // ── Aftermath effects ───────────────────────
    const afterStart = result.bloodEvents.length;
    this.applyAftermath(loc.id, active, result);

    // TO06: Submission — 精確快照比較，恢復所有被扣除的血液
    Object.entries(to06Snapshots).forEach(([pid, snapBlood]) => {
      const p = s.players[pid];
      if (!p) return;
      const lost = (snapBlood as number) - p.blood;
      if (lost > 0) {
        p.blood += lost;
        result.bloodEvents.push(ev(`${p.name} 服從免疫：+${lost}💧`, { cardId: 'TO06', sourcePlayerName: p.name, delta: { blood: lost } }));
        this.log(`${p.name} 的服從免疫：恢復 ${lost}💧`);
      }
    });

    // TR06: Retaliation — 精確快照比較，對手承受等量損失
    Object.entries(tr06Snapshots).forEach(([pid, snapBlood]) => {
      const p = s.players[pid];
      if (!p) return;
      const lost = (snapBlood as number) - p.blood;
      if (lost > 0) {
        const rivals = Object.values(s.players).filter(x => x.id !== pid);
        rivals.forEach(r => { r.blood = Math.max(0, r.blood - lost); });
        result.bloodEvents.push(ev(`${p.name} 報復：對手各 -${lost}💧`, { cardId: 'TR06', sourcePlayerName: p.name, delta: { blood: -lost } }));
        this.log(`${p.name} 的報復生效：每個對手失去 ${lost}💧`);
      }
    });

    // TR04: Dark Pact — 精確快照比較，將效果造成的失血重導向至 TR04 所在地點
    Object.entries(tr04Snapshots).forEach(([pid, snapBlood]) => {
      const p = s.players[pid];
      if (!p) return;
      const lost = (snapBlood as number) - p.blood;
      if (lost > 0) {
        // 恢復血液，改放到 TR04 slot 作為血液代幣
        p.blood += lost;
        const tr04Slot = active.find(sl => sl.playerId === pid && sl.cardId === 'TR04');
        if (tr04Slot) {
          tr04Slot.bloodTokens += lost;
          result.bloodEvents.push(ev(`${p.name} 黑暗契約：${lost}💧 重導向至此地點`, { cardId: 'TR04', sourcePlayerName: p.name, delta: { blood: lost } }));
          this.log(`${p.name} 的黑暗契約：${lost}💧 重導向`);
        }
      }
    });

    result.stepEvents.aftermath = result.bloodEvents.slice(afterStart);

    // 結算後血量彙總
    const bloodSummary = Object.values(s.players)
      .map(p => `${p.name}:${p.blood}💧/${p.influence}Inf`)
      .join('  ');
    dlog(`[resolve]   [血量] ${bloodSummary}`);

    return result;
  }

  private computePower(slot: SlotFull, allActive: SlotFull[], player: PlayerPrivate, locationId: string): number {
    const card = getCardById(slot.cardId);
    if (!card) return slot.bloodTokens;

    let power = card.power;
    const mySlots = allActive.filter(sl => sl.playerId === slot.playerId);

    // Passive cards only work face-up
    if (card.type === 'passive' && slot.faceDown) return slot.bloodTokens;

    switch (card.id) {
      case 'BR01': // Bloody Fury: -2 if deployed blood > 0
        if (slot.bloodTokens > 0) power -= 2;
        break;
      case 'BR02': // Punk's Posse: +2 per own deployed card
        power += mySlots.length * 2;
        break;
      case 'GA03': // Feral Weapons: blood adds 2 each (handled below)
        break;
      case 'MA04': { // Shadow Strike: +2 if fewest face-up cards
        const faceUpMap: Record<string, number> = {};
        allActive.forEach(sl => {
          if (!sl.faceDown) faceUpMap[sl.playerId] = (faceUpMap[sl.playerId] ?? 0) + 1;
        });
        const myFaceUp = faceUpMap[slot.playerId] ?? 0;
        const minFaceUp = Math.min(...Object.values(faceUpMap), myFaceUp);
        if (myFaceUp <= minFaceUp) power += 2;
        break;
      }
      case 'MA07': // Mindless Assault: face-down cards have power 4
        if (slot.faceDown) power = 4;
        break;
      case 'MA08': // Ready: +1 per own deployed card
        power += mySlots.length;
        break;
      case 'NO08': // Ready: +2 at Prince's Haven
        if (locationId === 'haven') power += 2;
        break;
      case 'TO02': // Entourage: +1 per alliance card (max 7)
        power += Math.min(player.alliance.length, 7);
        break;
      case 'TO05': // Entrancement: +1 per all deployed cards
        power += allActive.length;
        break;
      case 'TR01': // Focus from Hunger: 9 - pool blood
        power = Math.max(0, 9 - player.blood);
        break;
      case 'VE04': { // Majesty: equal to highest printed power
        const maxPrinted = Math.max(...allActive.map(sl => getCardById(sl.cardId)?.power ?? 0));
        power = maxPrinted;
        break;
      }
      case 'VE01': { // Master Plan: +1 per rival at this location
        const rivalsHere = new Set(allActive.filter(sl => sl.playerId !== slot.playerId).map(sl => sl.playerId));
        power += rivalsHere.size;
        break;
      }
      case 'VE08': // Ready: just 2 power
        break;
    }

    // Blood token contribution (Feral Weapons doubles it)
    const hasFeral = mySlots.some(sl => sl.cardId === 'GA03');
    const bloodPower = hasFeral ? slot.bloodTokens * 2 : slot.bloodTokens;

    return Math.max(0, power) + bloodPower;
  }

  private applyPreparation(locationId: string, active: SlotFull[], result: ConflictResult): void {
    const s = this.state;
    active.forEach(slot => {
      const card = getCardById(slot.cardId);
      if (!card || (card.type !== 'preparation' && card.type !== 'passive')) return;
      if (slot.skipEffects) return; // VE03: 選擇跳過效果
      const p = s.players[slot.playerId]!;
      const rivals = Object.values(s.players).filter(x => x.id !== slot.playerId && !s.forestallImmune[x.id]?.includes(card.id));

      switch (card.id) {
        case 'BR07': { // Show of Force: steal 1 from each rival
          let stolen = 0;
          rivals.forEach(r => { if (r.blood > 0) { r.blood--; stolen++; } });
          p.blood += stolen;
          if (stolen > 0) { result.bloodEvents.push(ev(`${p.name} 展示武力：+${stolen}💧`, { cardId: 'BR07', sourcePlayerName: p.name, delta: { blood: stolen } })); this.log(`${p.name} 的展示武力偷取 ${stolen} 血`); }
          break;
        }
        case 'GA04': { // Power of the Pack: steal half rivals' deployed blood (rounded up)
          let stolen = 0;
          active.filter(sl => sl.playerId !== p.id).forEach(sl => {
            const take = Math.ceil(sl.bloodTokens / 2);
            sl.bloodTokens -= take; stolen += take;
          });
          p.blood += stolen;
          if (stolen > 0) { result.bloodEvents.push(ev(`${p.name} 狼群之力：+${stolen}💧`, { cardId: 'GA04', sourcePlayerName: p.name, delta: { blood: stolen } })); this.log(`${p.name} 的狼群之力奪取 ${stolen} 部署血液`); }
          break;
        }
        case 'GA05': { // Fearless: 玩家選擇是否交換
          const key = `GA05:${locationId}:${p.id}`;
          if ((s.resolvedChoices[key] ?? 'swap') === 'swap') {
            const old = slot.bloodTokens;
            slot.bloodTokens = p.blood;
            p.blood = old + 2;
            result.bloodEvents.push(ev(`${p.name} 無懼：交換血液`, { cardId: 'GA05', sourcePlayerName: p.name }));
            this.log(`${p.name} 的無懼：交換資源池(${p.blood-2})與部署血液，+2`);
          } else {
            result.bloodEvents.push(ev(`${p.name} 無懼：選擇不交換`, { cardId: 'GA05', sourcePlayerName: p.name }));
          }
          break;
        }
        case 'GA08': { // Gangrel Ready: take 2 blood from bank to location
          p.blood += 0; // bank is infinite
          slot.bloodTokens += 2;
          result.bloodEvents.push(ev(`${p.name} 備戰：部署+2💧`, { cardId: 'GA08', sourcePlayerName: p.name }));
          this.log(`${p.name} 的備戰從銀行取 2 血液至此地點`);
          break;
        }
        case 'TO03': { // Charisma: rivals discard deployed blood = alliance/2
          const discard = Math.floor(p.alliance.length / 2);
          if (discard > 0) {
            active.filter(sl => sl.playerId !== p.id).forEach(sl => {
              sl.bloodTokens = Math.max(0, sl.bloodTokens - discard);
            });
            result.bloodEvents.push(ev(`${p.name} 魅力：對手棄置${discard}💧`, { cardId: 'TO03', sourcePlayerName: p.name, delta: { blood: -discard } }));
            this.log(`${p.name} 的魅力：對手棄置 ${discard} 部署血液`);
          }
          break;
        }
        case 'TR02': { // Ancient Artifacts: spend half pool or flip face-down
          const cost = Math.floor(p.blood / 2);
          if (cost > 0 && p.blood >= cost) {
            p.blood -= cost;
            result.bloodEvents.push(ev(`${p.name} 古老文物：消耗${cost}💧`, { cardId: 'TR02', sourcePlayerName: p.name, delta: { blood: -cost } }));
            this.log(`${p.name} 的古老文物消耗 ${cost} 血液`);
          } else {
            slot.faceDown = true;
            this.log(`${p.name} 的古老文物因血液不足翻至面朝下`);
          }
          break;
        }
        case 'TR03': { // Theft of Vitae: gain blood to 7
          const gain = p.blood < 7 ? (7 - p.blood) : 1;
          p.blood += gain;
          result.bloodEvents.push(ev(`${p.name} 竊取生命力：+${gain}💧`, { cardId: 'TR03', sourcePlayerName: p.name, delta: { blood: gain } }));
          this.log(`${p.name} 的竊取生命力：+${gain} 血液`);
          break;
        }
        case 'TR07': { // Arcane Drain: 玩家選擇是否啟動
          const key = `TR07:${locationId}:${p.id}`;
          if (s.resolvedChoices[key] === 'pay') {
            const cost = Math.floor(p.blood / 2);
            if (cost > 0) {
              p.blood -= cost;
              let gained = 0;
              active.filter(sl => sl.playerId !== p.id).forEach(sl => {
                const take = Math.ceil(sl.bloodTokens / 2);
                sl.bloodTokens -= take; gained += take;
              });
              p.blood += gained;
              result.bloodEvents.push(ev(`${p.name} 奧術汲取：-${cost}💧 +${gained}💧`, { cardId: 'TR07', sourcePlayerName: p.name, delta: { blood: gained - cost } }));
              this.log(`${p.name} 的奧術汲取：消耗${cost}，奪取${gained}`);
            }
          } else {
            result.bloodEvents.push(ev(`${p.name} 奧術汲取：選擇不啟動`, { cardId: 'TR07', sourcePlayerName: p.name }));
          }
          break;
        }
        case 'NO07': { // Vanish: 玩家選擇是否撤退+偷血
          const key = `NO07:${locationId}:${p.id}`;
          if ((s.resolvedChoices[key] ?? 'stay') === 'withdraw_steal') {
            slot.withdrawn = true;
            let stolen = 0;
            rivals.forEach(r => { if (r.blood > 0) { r.blood--; stolen++; } });
            p.blood += stolen;
            if (stolen > 0) result.bloodEvents.push(ev(`${p.name} 消失於影：撤退+偷 ${stolen}💧`, { cardId: 'NO07', sourcePlayerName: p.name, delta: { blood: stolen } }));
          } else {
            result.bloodEvents.push(ev(`${p.name} 消失於影：選擇不撤退`, { cardId: 'NO07', sourcePlayerName: p.name }));
          }
          break;
        }
        case 'VE06': {
          // Tyrant's Gaze: 效果已在 setupPendingChoices 建立選擇，此處不重複套用
          result.bloodEvents.push(ev(`${p.name} 暴君凝視：已要求對手選擇`, { cardId: 'VE06', sourcePlayerName: p.name }));
          break;
        }
        case 'MA01': { // Mesmerize: 選擇一名對手，將其手牌打至此地點
          const key = `MA01:${locationId}:${p.id}`;
          const targetId = s.resolvedChoices[key];
          const target = targetId ? s.players[targetId] : null;
          if (target && target.hand.length > 0) {
            [...target.hand].forEach(c => {
              s.deployments[locationId].push({ playerId: p.id, cardId: c.id, faceDown: false, bloodTokens: 0, withdrawn: false, effectivePower: 0 });
              active.push(s.deployments[locationId][s.deployments[locationId].length-1]);
            });
            target.hand = []; target.handCount = 0;
            result.bloodEvents.push(ev(`${p.name} 催眠操控：${target.name} 的手牌全部打至此地點`, { cardId: 'MA01', sourcePlayerName: p.name, targetPlayerName: target.name }));
            this.log(`${p.name} 催眠操控 ${target.name}，手牌共 ${target.handCount} 張`);
          } else {
            result.bloodEvents.push(ev(`${p.name} 催眠操控：未選擇目標或目標無手牌`, { cardId: 'MA01', sourcePlayerName: p.name }));
          }
          break;
        }
        case 'MA03': { // Madness Network: play rest of hand here
          // auto-deploy remaining hand face-up (simplified: add as slots with 0 blood)
          [...p.hand].forEach(c => {
            this.state.deployments[locationId].push({
              playerId: p.id, cardId: c.id, faceDown: false,
              bloodTokens: 0, withdrawn: false, effectivePower: 0,
            });
            active.push(this.state.deployments[locationId][this.state.deployments[locationId].length-1]);
          });
          p.hand = [];
          p.handCount = 0;
          result.bloodEvents.push(ev(`${p.name} 瘋狂網絡：手牌全入`, { cardId: 'MA03', sourcePlayerName: p.name }));
          break;
        }
        case 'NO05': { // Backstab: 在此地點放置最多 3 血液代幣
          slot.bloodTokens += 3;
          result.bloodEvents.push(ev(`${p.name} 背刺：+3💧`, { cardId: 'NO05', sourcePlayerName: p.name, delta: { blood: 3 } }));
          this.log(`${p.name} 的背刺：+3 血液代幣至 ${this.locName(locationId)}`);
          break;
        }
        case 'TO07': { // Friends in High Places: 每同盟牌 +1 血液代幣
          const add = p.alliance.length;
          if (add > 0) {
            slot.bloodTokens += add;
            result.bloodEvents.push(ev(`${p.name} 上層友人：+${add}💧`, { cardId: 'TO07', sourcePlayerName: p.name, delta: { blood: add } }));
            this.log(`${p.name} 的上層友人：+${add} 血液代幣`);
          }
          break;
        }
        case 'TO08': { // Ready: 抽一張受害者牌入同盟
          if (s.victimDeck.length > 0) {
            const v = s.victimDeck.shift()!;
            p.alliance.push(v);
            p.allianceCount++;
            result.bloodEvents.push(ev(`${p.name} 備戰：獲得 ${v.name}`, { cardId: 'TO08', sourcePlayerName: p.name }));
            this.log(`${p.name} 的備戰：獲得受害者牌 ${v.name}`);
          }
          break;
        }
        case 'MA05': { // Chaos: 玩家選擇收回幾張部署牌
          const key = `MA05:${locationId}:${p.id}`;
          const takeCount = parseInt(s.resolvedChoices[key] ?? '0', 10);
          if (takeCount === 0) {
            result.bloodEvents.push(ev(`${p.name} 混沌：選擇不收回`, { cardId: 'MA05', sourcePlayerName: p.name }));
            break;
          }
          const mySlots = active.filter(sl => sl.playerId === p.id && !sl.withdrawn);
          const toTake = mySlots.slice(0, takeCount);
          toTake.forEach(sl => {
            sl.withdrawn = true;
            const c = getCardById(sl.cardId);
            if (c) p.hand.push(c);
          });
          p.handCount = p.hand.length;
          let stolen = 0;
          for (let i = 0; i < toTake.length; i++) {
            rivals.forEach(r => { if (r.blood > 0) { r.blood--; stolen++; } });
          }
          p.blood += stolen;
          result.bloodEvents.push(ev(`${p.name} 混沌：收回 ${toTake.length} 張牌，偷取 ${stolen}💧`, { cardId: 'MA05', sourcePlayerName: p.name, delta: { blood: stolen } }));
          this.log(`${p.name} 的混沌：收回 ${toTake.length} 張，偷 ${stolen} 血`);
          break;
        }
      }
    });
  }

  private applyConflict(_locationId: string, active: SlotFull[], result: ConflictResult): void {
    const s = this.state;
    active.forEach(slot => {
      const card = getCardById(slot.cardId);
      if (!card || card.type !== 'conflict') return;
      const p = s.players[slot.playerId]!;

      switch (card.id) {
        case 'VE02': { // Diplomacy: highest printed power (not mine) → 0
          const otherSlots = active.filter(sl => sl.playerId !== p.id);
          if (otherSlots.length === 0) break;
          const maxPow = Math.max(...otherSlots.map(sl => getCardById(sl.cardId)?.power ?? 0));
          otherSlots.forEach(sl => {
            if ((getCardById(sl.cardId)?.power ?? 0) === maxPow) {
              sl.effectivePower = Math.max(0, sl.effectivePower - maxPow);
            }
          });
          result.bloodEvents.push(ev(`${p.name} 外交手腕：最強牌歸零`, { cardId: 'VE02', sourcePlayerName: p.name, delta: { power: -1 } }));
          this.log(`${p.name} 的外交手腕使最高權力牌歸零`);
          break;
        }
        case 'VE03': { // Curfew: 效果已在 setupPendingChoices 前處理
          result.bloodEvents.push(ev(`${p.name} 宵禁令：已要求對手選擇`, { cardId: 'VE03', sourcePlayerName: p.name }));
          break;
        }
        case 'VE05': { // Mass Manipulation: 效果已在 setupPendingChoices 前處理
          result.bloodEvents.push(ev(`${p.name} 大規模操控：已要求對手選擇`, { cardId: 'VE05', sourcePlayerName: p.name }));
          break;
        }
        case 'TR06': {
          // Retaliation: 效果由 resolveLocation 在 aftermath 後以快照比較觸發
          break;
        }
        case 'TR08': { // Ready: 若進入狂暴，可翻面朝下代替消耗同盟牌 → 此處給 +1 血液並標記
          // 在衝突階段預先補血，使其不易進入狂暴
          if (p.blood === 0) {
            p.blood += 1;
            slot.faceDown = true;
            result.bloodEvents.push(ev(`${p.name} 備戰(TR08)：翻面朝下+1💧`, { cardId: 'TR08', sourcePlayerName: p.name, delta: { blood: 1 } }));
            this.log(`${p.name} 的備戰(TR08) 啟動：翻面並補充 1 血液`);
          }
          break;
        }
        case 'GA02': { // Wolf Companion: rivals' printed power halved
          active.filter(sl => sl.playerId !== p.id).forEach(sl => {
            const printed = getCardById(sl.cardId)?.power ?? 0;
            sl.effectivePower = Math.max(0, sl.effectivePower - Math.floor(printed / 2));
          });
          result.bloodEvents.push(ev(`${p.name} 狼族夥伴：對手牌力減半`, { cardId: 'GA02', sourcePlayerName: p.name, delta: { power: -1 } }));
          this.log(`${p.name} 的狼族夥伴使對手部署牌印刷權力減半`);
          break;
        }
      }
    });
  }

  private applyAftermath(locationId: string, active: SlotFull[], result: ConflictResult): void {
    const s = this.state;
    active.forEach(slot => {
      const card = getCardById(slot.cardId);
      if (!card || (card.type !== 'aftermath' && card.type !== 'passive')) return;
      if (slot.skipEffects) return; // VE03: 選擇跳過效果
      const p = s.players[slot.playerId]!;
      const rivals = Object.values(s.players).filter(x => x.id !== slot.playerId && !s.forestallImmune[x.id]?.includes(card.id));
      const isWinner = result.winner === slot.playerId;

      // ── Hunt-type cards (steal 1 from each rival) ──
      const huntIds = ['BR09','NO09','TO09','MA09','GA09'];
      if (huntIds.includes(card.id)) {
        let stolen = 0;
        rivals.forEach(r => { if (r.blood > 0) { r.blood--; stolen++; } });
        p.blood += stolen;
        if (stolen > 0) { result.bloodEvents.push(ev(`${p.name} 狩獵：+${stolen}💧`, { cardId: card.id, sourcePlayerName: p.name, delta: { blood: stolen } })); this.log(`${p.name} 狩獵偷取 ${stolen} 血液`); }
        return;
      }

      switch (card.id) {
        case 'TR09': { // Hunt: spend 1 to steal 1 from each rival
          if (p.blood >= 1) {
            p.blood--;
            let stolen = 0;
            rivals.forEach(r => { if (r.blood > 0) { r.blood--; stolen++; } });
            p.blood += stolen;
            if (stolen > 0) { result.bloodEvents.push(ev(`${p.name} 狩獵(Tremere)：-1+${stolen}💧`, { cardId: 'TR09', sourcePlayerName: p.name, delta: { blood: stolen - 1 } })); }
          }
          break;
        }
        case 'VE09': { // Hunt: 勝者選擇被偷2血或給1影響力
          if (result.winner && result.winner !== p.id) {
            const wp = s.players[result.winner]!;
            const key = `VE09:${locationId}:${result.winner}`; // 勝者做選擇
            const choice = s.resolvedChoices[key];
            if (choice === 'give_influence') {
              wp.influence = Math.max(0, wp.influence - 1); p.influence += 1;
              result.bloodEvents.push(ev(`${wp.name} 選擇給予 1 影響力（Ventrue 狩獵）`, { cardId: 'VE09', sourcePlayerName: p.name, targetPlayerName: wp.name, delta: { influence: -1 } }));
            } else {
              // 預設：失去2血
              const take = Math.min(wp.blood, 2);
              wp.blood -= take; p.blood += take;
              result.bloodEvents.push(ev(`${p.name} 狩獵(Ventrue)：從 ${wp.name} 偷 ${take}💧`, { cardId: 'VE09', sourcePlayerName: p.name, targetPlayerName: wp.name, delta: { blood: take } }));
            }
          }
          break;
        }
        case 'BR04': { // Fist of Caine: rivals lose blood by round
          const loss = s.round;
          rivals.forEach(r => { r.blood = Math.max(0, r.blood - loss); });
          result.bloodEvents.push(ev(`${p.name} 該隱之拳：對手-${loss}💧`, { cardId: 'BR04', sourcePlayerName: p.name, delta: { blood: -loss } }));
          this.log(`${p.name} 的該隱之拳使每個對手失去 ${loss} 血液`);
          break;
        }
        case 'BR05': { // F*ck the System: rivals lose 4 if win, 2 if not
          const loss = isWinner ? 4 : 2;
          rivals.forEach(r => { r.blood = Math.max(0, r.blood - loss); });
          result.bloodEvents.push(ev(`${p.name} 打倒體制：對手-${loss}💧`, { cardId: 'BR05', sourcePlayerName: p.name, delta: { blood: -loss } }));
          this.log(`${p.name} 的打倒體制使每個對手失去 ${loss} 血液`);
          break;
        }
        case 'BR06': { // Earthshock: rivals lose 1 per 2 total deployed blood
          const totalBlood = active.reduce((sum, sl) => sum + sl.bloodTokens, 0);
          const loss = Math.floor(totalBlood / 2);
          if (loss > 0) {
            rivals.forEach(r => { r.blood = Math.max(0, r.blood - loss); });
            result.bloodEvents.push(ev(`${p.name} 地震衝擊：對手-${loss}💧`, { cardId: 'BR06', sourcePlayerName: p.name, delta: { blood: -loss } }));
          }
          break;
        }
        case 'GA01': { // Earth Meld: reclaim own deployed blood
          const recovered = slot.bloodTokens;
          p.blood += recovered;
          slot.bloodTokens = 0;
          result.bloodEvents.push(ev(`${p.name} 融入大地：回收${recovered}💧`, { cardId: 'GA01', sourcePlayerName: p.name, delta: { blood: recovered } }));
          this.log(`${p.name} 的融入大地回收 ${recovered} 部署血液`);
          break;
        }
        case 'GA07': { // Mist Form: 玩家選擇目標地點
          const move = Math.ceil(slot.bloodTokens / 2);
          if (move > 0) {
            const key = `GA07:${locationId}:${p.id}`;
            const targetLocId = s.resolvedChoices[key] ?? LOCATIONS.find(l=>l.id!==locationId)?.id;
            const targetLoc = targetLocId ? LOCATIONS.find(l=>l.id===targetLocId) : null;
            if (targetLoc) {
              slot.bloodTokens -= move;
              const existingSlot = s.deployments[targetLoc.id]?.find(sl=>sl.playerId===p.id);
              if (existingSlot) existingSlot.bloodTokens += move;
              else s.deployments[targetLoc.id]?.push({ playerId:p.id, cardId:'', faceDown:false, bloodTokens:move, withdrawn:false, effectivePower:0 });
              result.bloodEvents.push(ev(`${p.name} 迷霧型態：移 ${move}💧 至 ${targetLoc.name}`, { cardId: 'GA07', sourcePlayerName: p.name }));
            }
          }
          break;
        }
        case 'TO01': { // Awe: steal 1 per 2 alliance cards
          const steal = Math.floor(p.alliance.length / 2);
          if (steal > 0) {
            let stolen = 0;
            rivals.forEach(r => { const t = Math.min(r.blood, steal); r.blood -= t; stolen += t; });
            p.blood += stolen;
            result.bloodEvents.push(ev(`${p.name} 敬畏：+${stolen}💧`, { cardId: 'TO01', sourcePlayerName: p.name, delta: { blood: stolen } }));
          }
          break;
        }
        case 'TO04': { // Summon: if win ally/victim, draw extra victim
          if (isWinner && s.victimDeck.length > 0) {
            const v = s.victimDeck.shift()!;
            p.alliance.push(v);
            p.allianceCount++;
            result.bloodEvents.push(ev(`${p.name} 召喚：獲得額外受害者牌`, { cardId: 'TO04', sourcePlayerName: p.name }));
          }
          break;
        }
        case 'NO01': { // Unseen Passage: 後果階段移至王子避難所
          const haven = LOCATIONS.find(l => l.isPrinces);
          if (haven && locationId !== haven.id) {
            // 從原地點移除，加入 haven
            const idx = s.deployments[locationId].indexOf(slot);
            if (idx !== -1) s.deployments[locationId].splice(idx, 1);
            s.deployments[haven.id].push({ ...slot, withdrawn: false });
            result.bloodEvents.push(ev(`${p.name} 隱形通道：移至 ${haven.name}`, { cardId: 'NO01', sourcePlayerName: p.name }));
            this.log(`${p.name} 的隱形通道：牌移至 ${haven.name}`);
          }
          break;
        }
        case 'NO06': { // One Step Ahead: 翻牌後，對手每張面朝下牌需支付 2 血液或翻面
          // 簡化：對手每張面朝下牌失去 2 血液（相當於選擇不翻面而付費）
          active.filter(sl => sl.playerId !== p.id && sl.faceDown && !sl.withdrawn).forEach(sl => {
            const rival = s.players[sl.playerId];
            if (!rival) return;
            const cost = Math.min(rival.blood, 2);
            rival.blood -= cost;
            if (cost < 2) sl.faceDown = false; // 付不起則強制翻面
            result.bloodEvents.push(ev(`${rival.name} 被一步超前：-${cost}💧`, { cardId: 'NO06', sourcePlayerName: p.name, targetPlayerName: rival.name, delta: { blood: -cost } }));
          });
          this.log(`${p.name} 的一步超前：對手面朝下牌各扣 2 血液`);
          break;
        }
        case 'MA02': { // Auction of Blood: 讀取秘密競標結果結算
          const presentPlayerIds = [...new Set(active.map(sl => sl.playerId))];
          if (presentPlayerIds.length < 2) break;

          // 讀取每人出價，未回應者視為出價 0
          const bids: { pid: string; bid: number }[] = presentPlayerIds.map(pid => {
            const key = `MA02:${locationId}:${pid}`;
            const raw = s.resolvedChoices[key] ?? 'bid_0';
            const bid = parseInt(raw.replace('bid_', ''), 10) || 0;
            return { pid, bid };
          });

          // 找最低出價（平手時都算輸）
          const minBid = Math.min(...bids.map(b => b.bid));
          const losers = bids.filter(b => b.bid === minBid);
          const nonLosers = bids.filter(b => b.bid > minBid);

          // 公開出價結果
          const bidSummary = bids.map(b => `${s.players[b.pid]?.name}:${b.bid}💧`).join('、');
          result.bloodEvents.push(ev(`${p.name} 血液拍賣出價揭曉：${bidSummary}`, { cardId: 'MA02', sourcePlayerName: p.name }));

          // 最低出價者：出價退回，翻一張面朝上的牌至面朝下（翻面扣1血）
          for (const { pid } of losers) {
            const loser = s.players[pid]; if (!loser) continue;
            const fuSlot = s.deployments[locationId].find(sl => sl.playerId === pid && !sl.faceDown && !sl.withdrawn);
            if (fuSlot) {
              fuSlot.faceDown = true;
              loser.blood = Math.max(0, loser.blood - 1);
              result.bloodEvents.push(ev(`${loser.name} 出價最低，翻一張牌面朝下（-1💧）`, { cardId: 'MA02', sourcePlayerName: p.name, targetPlayerName: loser.name, delta: { blood: -1 } }));
            } else {
              result.bloodEvents.push(ev(`${loser.name} 出價最低，但無牌可翻`, { cardId: 'MA02', sourcePlayerName: p.name, targetPlayerName: loser.name }));
            }
          }

          // 其他玩家：若是持牌者 → 出價留在地點；否則出價血液消耗
          for (const { pid, bid } of nonLosers) {
            const bidder = s.players[pid]; if (!bidder) continue;
            bidder.blood = Math.max(0, bidder.blood - bid);
            if (pid === slot.playerId) {
              // 持牌者出價部署至此地點
              slot.bloodTokens += bid;
              result.bloodEvents.push(ev(`${bidder.name}（持牌者）出價 ${bid}💧 → 部署至此地點`, { cardId: 'MA02', sourcePlayerName: p.name, targetPlayerName: bidder.name, delta: { blood: -bid } }));
            } else {
              result.bloodEvents.push(ev(`${bidder.name} 出價 ${bid}💧 → 消耗`, { cardId: 'MA02', sourcePlayerName: p.name, targetPlayerName: bidder.name, delta: { blood: -bid } }));
            }
          }

          this.log(`${p.name} 的血液拍賣結算完成`);
          break;
        }
        case 'MA06': { // Malkav's Bane: 翻牌後抽頂牌至此地點
          if (p.deck.length > 0) {
            const drawn = p.deck.shift()!;
            s.deployments[locationId].push({ playerId: p.id, cardId: drawn.id, faceDown: false, bloodTokens: 0, withdrawn: false, effectivePower: 0 });
            result.bloodEvents.push(ev(`${p.name} 馬爾卡夫詛咒：抽 ${drawn.name_zh} 至此`, { cardId: 'MA06', sourcePlayerName: p.name }));
            this.log(`${p.name} 的馬爾卡夫詛咒抽出 ${drawn.name_zh}`);
          }
          break;
        }
        case 'VE07': { // Forestall: 玩家選擇目標對手牌
          const key = `VE07:${locationId}:${p.id}`;
          const target = s.resolvedChoices[key]; // format: "rivalPlayerId:cardId"
          if (target) {
            const [, tCardId] = target.split(':');
            const tCard = getCardById(tCardId);
            if (tCard && tCard.power > 0) {
              p.blood += tCard.power;
              // 記錄免疫：此玩家對此牌的失血/偷血效果免疫
              if (!s.forestallImmune[p.id]) s.forestallImmune[p.id] = [];
              if (!s.forestallImmune[p.id].includes(tCardId)) s.forestallImmune[p.id].push(tCardId);
              result.bloodEvents.push(ev(`${p.name} 先發制人：目標 ${tCard.name_zh}，+${tCard.power}💧，免疫其失血/偷血效果`, { cardId: 'VE07', sourcePlayerName: p.name, delta: { blood: tCard.power } }));
              this.log(`${p.name} 的先發制人選擇 ${tCard.name_zh}，獲得 ${tCard.power} 血液，免疫其效果`);
            }
          } else {
            // fallback: highest
            const maxPrint = Math.max(0, ...active.filter(sl=>sl.playerId!==p.id).map(sl=>getCardById(sl.cardId)?.power??0));
            if (maxPrint > 0) { p.blood += maxPrint; result.bloodEvents.push(ev(`${p.name} 先發制人：+${maxPrint}💧`, { cardId: 'VE07', sourcePlayerName: p.name, delta: { blood: maxPrint } })); }
          }
          break;
        }
        case 'TR04': {
          // Dark Pact: 效果由 resolveLocation 在 aftermath 後以快照比較重導向
          break;
        }
        case 'TR05': { // Cauldron of Blood: 玩家選擇是否啟動
          const key = `TR05:${locationId}:${p.id}`;
          if (s.resolvedChoices[key] === 'pay') {
            const cost = Math.floor(p.blood / 2);
            if (cost > 0) {
              p.blood -= cost;
              rivals.forEach(r => { r.blood = Math.max(0, r.blood - 4); });
              result.bloodEvents.push(ev(`${p.name} 血液坩堝：-${cost}💧，對手-4💧`, { cardId: 'TR05', sourcePlayerName: p.name, delta: { blood: -cost } }));
              this.log(`${p.name} 的血液坩堝消耗 ${cost}，使每個對手失去 4 血液`);
            }
          } else {
            result.bloodEvents.push(ev(`${p.name} 血液坩堝：選擇不啟動`, { cardId: 'TR05', sourcePlayerName: p.name }));
          }
          break;
        }
      }
    });

  }

  private awardPrize(locationId: string, winnerId: string, secondId: string | null): void {
    const s = this.state;
    const wp = s.players[winnerId];
    const ally = s.locationAllies[locationId];

    // 1st place: get the ally card at this location
    if (wp && ally) {
      wp.alliance.push(ally);
      wp.allianceCount++;
      s.locationAllies[locationId] = null;
      this.log(`${wp.name} 贏得盟友：${ally.name}`);
    }

    // 2nd place: get a victim card
    if (secondId && s.victimDeck.length > 0) {
      const sp = s.players[secondId];
      if (sp) {
        const v = s.victimDeck.shift()!;
        sp.alliance.push(v);
        sp.allianceCount++;
        this.log(`${sp.name} 獲得受害者牌`);
      }
    }
  }

  private checkFrenzy(player: PlayerPrivate): void {
    if (player.blood > 0) return;
    const s = this.state;
    const causers = Object.values(s.players).filter(p => p.id !== player.id);
    if (causers.length > 0) {
      causers[0].influence += 1;
      this.log(`${player.name} 進入狂暴！${causers[0].name} 獲得 +1 影響力`);

      // BR08: Ready — 若該玩家有 BR08 面朝上，額外獲得 +1 影響力
      const hasBR08 = Object.values(s.deployments).some(slots =>
        slots.some(sl => sl.playerId === causers[0].id && sl.cardId === 'BR08' && !sl.faceDown)
      );
      if (hasBR08) {
        causers[0].influence += 1;
        this.log(`${causers[0].name} 的備戰(BR08)：額外 +1 影響力`);
      }
    }
    // Drain random alliance card (prioritise undrained ones)
    const undrainedAllies = player.alliance.filter(a => !a.drained);
    const allyPool = undrainedAllies.length > 0 ? undrainedAllies : player.alliance;
    if (allyPool.length > 0) {
      const shuffled = shuffle([...allyPool]);
      const forceDrained = shuffled[0];
      forceDrained.drained = true;       // 標記為已汲取，防止再次汲取；終局改計殘值影響力
      player.blood += forceDrained.drainBlood;
      if (forceDrained.type === 'vampire') {
        player.diablerie++;
        this.log(`${player.name} 強制汲取了 ${forceDrained.name}（弒親！弒親代幣: ${player.diablerie}）`);
        if (player.diablerie >= 3) {
          this.eliminatePlayer(player.id);
          return;
        }
      } else {
        this.log(`${player.name} 強制汲取了 ${forceDrained.name}（+${forceDrained.drainBlood}💧）`);
      }
    } else {
      // 無同盟牌：從銀行取 1 血，但失去 1 影響力
      player.blood = 1;
      player.influence = Math.max(0, player.influence - 1);
      this.log(`${player.name} 進入狂暴（無同盟）！獲得 1💧，失去 1 影響力`);
    }
  }

  // ─── 回合結束 ────────────────────────────────

  endRound(): void {
    const s = this.state;
    s.phase = 'ROUND_END';

    Object.values(s.players).forEach(p => {
      // MA06: 揭牌後從氏族牌堆抽牌部署（已在 applyAftermath 做）；
      // 回合結束時：若有 MA06 面朝上，從手牌中洗一張牌回牌堆
      const hadMA06 = LOCATIONS.some(loc =>
        s.deployments[loc.id].some(sl => sl.playerId === p.id && sl.cardId === 'MA06' && !sl.faceDown && !sl.withdrawn)
      );

      // Return deployed cards to hand
      LOCATIONS.forEach(loc => {
        s.deployments[loc.id]
          .filter(sl => sl.playerId === p.id)
          .forEach(sl => {
            const card = getCardById(sl.cardId);
            if (card) p.hand.push(card);
          });
      });

      // MA06: 洗回一張非 MA06 的牌至牌堆
      if (hadMA06) {
        const idx = p.hand.findIndex(c => c.id !== 'MA06');
        if (idx !== -1) {
          const [shuffled] = p.hand.splice(idx, 1);
          p.deck.push(shuffled);
          p.deck = shuffle(p.deck);
          this.log(`${p.name} 的馬爾卡夫之禍：${shuffled.name_zh} 洗回牌堆`);
        }
      }

      p.handCount = p.hand.length;
      p.isReady = false;
    });

    this.log(`第 ${s.round} 回合結束`);

    if (s.round >= 3) {
      this.endGame();
    }
  }

  endGame(): void {
    const s = this.state;
    s.phase = 'GAME_OVER';

    // Final score: influence tokens + alliance influence (use drainInfluence for drained allies) - diablerie
    Object.values(s.players).forEach(p => {
      const allianceInf = p.alliance.reduce((sum, a) => sum + (a.drained ? a.drainInfluence : a.influence), 0);
      p.influence = Math.max(0, p.influence + allianceInf - p.diablerie);
    });

    const sorted = Object.values(s.players).sort((a, b) => {
      if (b.influence !== a.influence) return b.influence - a.influence;
      return b.blood - a.blood;
    });

    s.winner = sorted[0]?.id ?? null;
    this.log(`── 遊戲結束 ──`);
    sorted.forEach((p, i) => {
      this.log(`#${i + 1} ${p.name}（${p.clan}）— ${p.influence} 影響力`);
    });
    if (s.winner) this.log(`🏆 ${s.players[s.winner]?.name} 成為芝加哥的新王子！`);
  }

  // ─── 狀態過濾 ────────────────────────────────

  // ─── Pending Choice 機制 ──────────────────────

  private makeChoice(id: number, playerId: string, prompt: string, options: {key:string;label_zh:string}[], cardId: string, locId: string, sourceId: string, sourceName: string): PendingChoice {
    const choiceKey = `${cardId}:${locId}:${playerId}`;
    return { id: `choice_${id}`, playerId, prompt_zh: prompt, options, choiceKey,
      context: { cardId, locationId: locId, sourcePlayerId: sourceId, sourceName } };
  }

  /** 在 REVELATION 前掃描需要玩家選擇的卡牌，建立 pendingChoices */
  setupPendingChoices(): void {
    const s = this.state;
    s.pendingChoices = [];
    s.resolvedChoices = {};
    const currentLoc = s.locations[s.currentLocIndex];
    dlog(`[choice] loc=${currentLoc?.id}, deployments:`, JSON.stringify(
      currentLoc ? s.deployments[currentLoc.id].map(sl => ({ cardId: sl.cardId, pid: sl.playerId, withdrawn: sl.withdrawn, faceDown: sl.faceDown })) : []
    ));
    s.forestallImmune = {};
    let n = 0;

    // 只掃描當前結算地點
    const deployEntries = currentLoc
      ? [[currentLoc.id, s.deployments[currentLoc.id]] as [string, typeof s.deployments[string]]]
      : [];

    for (const [locId, slots] of deployEntries) {
      const active = slots.filter(sl => !sl.withdrawn && !sl.faceDown);
      const allAtLoc = slots.filter(sl => !sl.withdrawn);

      for (const slot of active) {
        const card = getCardById(slot.cardId);
        if (!card) continue;
        const owner = s.players[slot.playerId];
        if (!owner) continue;
        const rivals = Object.values(s.players).filter(p => p.id !== slot.playerId);
        const rivalsHere = [...new Set(allAtLoc.filter(sl => sl.playerId !== slot.playerId).map(sl => sl.playerId))];

        switch (card.id) {

          // ── 對手選擇 ──────────────────────────────────────────────
          case 'VE03': // 宵禁令：每個對手選擇跳過準備/後果 或 失去3血液
            for (const rival of rivals)
              s.pendingChoices.push(this.makeChoice(n++, rival.id,
                `【宵禁令】${owner.name} 迫使你選擇：`,
                [{ key:'skip_effects', label_zh:'跳過此地點的準備與後果效果' },
                 { key:'lose_blood',   label_zh:'失去 3 點血液' }],
                card.id, locId, slot.playerId, owner.name));
            break;

          case 'VE05': // 大規模操控：在此地點的對手選擇撤退 或 失去2血液
            for (const rivalId of rivalsHere) {
              const rival = s.players[rivalId]; if (!rival) continue;
              s.pendingChoices.push(this.makeChoice(n++, rivalId,
                `【大規模操控】${owner.name} 迫使你選擇：`,
                [{ key:'withdraw',   label_zh:'撤退（從此地點撤回你的牌）' },
                 { key:'lose_blood', label_zh:'失去 2 點血液' }],
                card.id, locId, slot.playerId, owner.name));
            }
            break;

          case 'VE06': // 暴君凝視：每個對手選擇「移動一半部署血液至持牌者」或「失去1影響力」
            for (const rivalId of rivalsHere) {
              const rival = s.players[rivalId]; if (!rival) continue;
              const half = Math.ceil(allAtLoc.filter(sl=>sl.playerId===rivalId).reduce((s,sl)=>s+sl.bloodTokens,0)/2);
              s.pendingChoices.push(this.makeChoice(n++, rivalId,
                `【暴君凝視】${owner.name} 迫使你選擇：`,
                [{ key:'move_blood',     label_zh:`將你在此地點的一半部署血液（${half}💧）移至 ${owner.name} 的位置` },
                 { key:'lose_influence', label_zh:'失去 1 點影響力' }],
                card.id, locId, slot.playerId, owner.name));
            }
            break;

          case 'NO06': // 領先一步：每個對手對自己每張面朝下的牌選擇翻面（付2血）或保持
            for (const rivalId of rivalsHere) {
              const rival = s.players[rivalId]; if (!rival) continue;
              const fdCount = slots.filter(sl=>sl.playerId===rivalId && sl.faceDown && !sl.withdrawn).length;
              if (fdCount === 0) continue;
              s.pendingChoices.push(this.makeChoice(n++, rivalId,
                `【領先一步】${owner.name} 要求你對 ${fdCount} 張面朝下的牌選擇：`,
                [{ key:'flip_all',  label_zh:`全部翻面（失去 ${fdCount*2} 點血液）` },
                 { key:'keep_down', label_zh:'保持面朝下' }],
                card.id, locId, slot.playerId, owner.name));
            }
            break;

          // ── 持牌者選擇 ──────────────────────────────────────────
          case 'GA05': // 無懼：可以選擇是否交換部署血液與資源池
            s.pendingChoices.push(this.makeChoice(n++, slot.playerId,
              `【無懼】你可以將此地點的部署血液與你的資源池互換，並額外獲得2血液：`,
              [{ key:'swap',    label_zh:`交換（部署${slot.bloodTokens}💧 ↔ 池${owner.blood}💧，+2💧）` },
               { key:'no_swap', label_zh:'不交換' }],
              card.id, locId, slot.playerId, owner.name));
            break;

          case 'GA07': // 迷霧型態：選擇要移動部署血液的目標地點
            if (slot.bloodTokens > 0) {
              const move = Math.ceil(slot.bloodTokens / 2);
              const otherLocs = s.locations.filter(l => l.id !== locId);
              s.pendingChoices.push(this.makeChoice(n++, slot.playerId,
                `【迷霧型態】選擇將 ${move}💧 移至哪個地點：`,
                otherLocs.map(l => ({ key: l.id, label_zh: l.name })),
                card.id, locId, slot.playerId, owner.name));
            }
            break;

          case 'TR05': // 血液坩堝：可選擇是否消耗一半資源池使對手失去4血
            if (owner.blood > 0) {
              const cost = Math.floor(owner.blood / 2);
              s.pendingChoices.push(this.makeChoice(n++, slot.playerId,
                `【血液坩堝】消耗 ${cost}💧 使每個對手失去 4💧？`,
                [{ key:'pay',    label_zh:`消耗 ${cost}💧，讓每個對手失去 4💧` },
                 { key:'no_pay', label_zh:'不啟動' }],
                card.id, locId, slot.playerId, owner.name));
            }
            break;

          case 'TR07': // 奧術汲取：可選擇是否消耗一半資源池奪取對手部署血液
            if (owner.blood > 0) {
              const cost = Math.floor(owner.blood / 2);
              s.pendingChoices.push(this.makeChoice(n++, slot.playerId,
                `【奧術汲取】消耗 ${cost}💧 奪取對手在此地點一半的部署血液？`,
                [{ key:'pay',    label_zh:`消耗 ${cost}💧 啟動` },
                 { key:'no_pay', label_zh:'不啟動' }],
                card.id, locId, slot.playerId, owner.name));
            }
            break;

          case 'NO05': // 背刺：可選擇將此牌移至王子避難所
            if (locId !== 'haven') {
              s.pendingChoices.push(this.makeChoice(n++, slot.playerId,
                `【背刺】將此牌移至王子的避難所？`,
                [{ key:'move_haven', label_zh:'移至王子避難所' },
                 { key:'stay',       label_zh:'留在此地點' }],
                card.id, locId, slot.playerId, owner.name));
            }
            break;

          case 'NO07': // 消失於影：可選擇撤退並從對手各偷1血
            s.pendingChoices.push(this.makeChoice(n++, slot.playerId,
              `【消失於影】你可以從此地點撤退，並從每個對手偷取 1💧：`,
              [{ key:'withdraw_steal', label_zh:'撤退並從每個對手偷取 1💧' },
               { key:'stay',          label_zh:'留在此地點（不偷血）' }],
              card.id, locId, slot.playerId, owner.name));
            break;

          case 'MA01': // 催眠操控：選擇一名對手，將其手牌全部打到此地點
            if (rivals.length > 0) {
              s.pendingChoices.push(this.makeChoice(n++, slot.playerId,
                `【催眠操控】選擇一名對手，將其手牌全數打至此地點：`,
                rivals.filter(r=>r.hand.length>0).map(r => ({ key: r.id, label_zh: `${r.name}（手牌 ${r.hand.length} 張）` })),
                card.id, locId, slot.playerId, owner.name));
            }
            break;

          case 'MA05': { // 混沌：選擇收回幾張自己的部署牌（0 到全部）
            const myDeployed = allAtLoc.filter(sl => sl.playerId === slot.playerId);
            const maxTake = myDeployed.length;
            const options: { key: string; label_zh: string }[] = [
              { key: '0', label_zh: '不收回（保持部署）' },
            ];
            for (let i = 1; i <= maxTake; i++) {
              const stolen = i * rivals.length;
              options.push({ key: String(i), label_zh: `收回 ${i} 張，從每個對手各偷 1💧（共 +${stolen}💧）` });
            }
            s.pendingChoices.push(this.makeChoice(n++, slot.playerId,
              `【混沌】選擇從此地點收回幾張自己的部署牌：`,
              options, card.id, locId, slot.playerId, owner.name));
            break;
          }

          case 'MA07': { // 無腦衝擊：選擇將自己幾張部署牌翻至面朝下（0 到全部）
            const myFaceUp = allAtLoc.filter(sl => sl.playerId === slot.playerId && !sl.faceDown && sl.cardId !== 'MA07');
            if (myFaceUp.length > 0) {
              const flipOptions: { key: string; label_zh: string }[] = [
                { key: '0', label_zh: '不翻面（保持面朝上）' },
              ];
              for (let i = 1; i <= myFaceUp.length; i++) {
                flipOptions.push({ key: String(i), label_zh: `翻 ${i} 張面朝下（各得 4 戰力）` });
              }
              s.pendingChoices.push(this.makeChoice(n++, slot.playerId,
                `【無腦衝擊】選擇將幾張部署牌翻至面朝下：`,
                flipOptions, card.id, locId, slot.playerId, owner.name));
            }
            break;
          }

          case 'MA02': { // 血液拍賣：所有在場玩家秘密出價，最低者翻牌，持牌者出價留在地點，對手出價消耗
            const allHere = [...new Set(allAtLoc.map(sl => sl.playerId))];
            for (const pid of allHere) {
              const bidder = s.players[pid]; if (!bidder) continue;
              const maxBid = bidder.blood;
              const bidOptions = Array.from({ length: maxBid + 1 }, (_, i) => ({
                key: `bid_${i}`,
                label_zh: i === 0 ? '出價 0💧（不押注）' : `出價 ${i}💧`,
              }));
              s.pendingChoices.push(this.makeChoice(n++, pid,
                `【血液拍賣】${owner.name} 的血液拍賣：秘密出價（你最多可出 ${maxBid}💧）：`,
                bidOptions, card.id, locId, slot.playerId, owner.name));
            }
            break;
          }

          case 'VE07': { // 先發制人：選擇一名對手的面朝上牌，免疫其效果並獲得其印刷戰力血液
            const rivalFaceUpCards: {key:string;label_zh:string}[] = [];
            active.filter(sl=>sl.playerId!==slot.playerId).forEach(sl=>{
              const c = getCardById(sl.cardId); if(!c) return;
              const rp = s.players[sl.playerId];
              rivalFaceUpCards.push({ key:`${sl.playerId}:${sl.cardId}`, label_zh:`${rp?.name ?? sl.playerId} 的 ${c.name_zh}（戰力 ${c.power}，獲得 ${c.power}💧）` });
            });
            if (rivalFaceUpCards.length > 0)
              s.pendingChoices.push(this.makeChoice(n++, slot.playerId,
                `【先發制人】選擇免疫並獲得血液的對手牌：`,
                rivalFaceUpCards, card.id, locId, slot.playerId, owner.name));
            break;
          }

        }
      }
    }
  }

  /** 玩家響應選擇：存入 resolvedChoices，並對即時生效的選項立即套用 */
  applyPendingChoice(choiceId: string, option: string): void {
    const s = this.state;
    const idx = s.pendingChoices.findIndex(c => c.id === choiceId);
    if (idx === -1) return;
    const choice = s.pendingChoices[idx];
    s.pendingChoices.splice(idx, 1);

    // 記錄供 resolution 使用
    s.resolvedChoices[choice.choiceKey] = option;

    const player = s.players[choice.playerId];
    if (!player) return;
    const locId = choice.context.locationId;

    switch (choice.context.cardId) {

      case 'VE03':
        if (option === 'lose_blood') {
          player.blood = Math.max(0, player.blood - 3);
          this.log(`${player.name} 選擇失去 3💧（宵禁令）`);
        } else {
          s.deployments[locId]?.filter(sl=>sl.playerId===choice.playerId).forEach(sl=>{ sl.skipEffects = true; });
          this.log(`${player.name} 選擇跳過此地點準備/後果效果（宵禁令）`);
        }
        break;

      case 'VE05':
        if (option === 'withdraw') {
          s.deployments[locId]?.filter(sl=>sl.playerId===choice.playerId&&!sl.withdrawn).forEach(sl=>{ sl.withdrawn=true; });
          this.log(`${player.name} 選擇撤退（大規模操控）`);
        } else {
          const stolen = Math.min(player.blood, 2);
          player.blood -= stolen;
          const caster = s.players[choice.context.sourcePlayerId];
          if (caster) caster.blood += stolen;
          this.log(`${player.name} 選擇留守，${caster?.name ?? '施術者'} 偷取 ${stolen}💧（大規模操控）`);
        }
        break;

      case 'VE06':
        if (option === 'move_blood') {
          const srcSlots = s.deployments[locId]?.filter(sl=>sl.playerId===choice.playerId) ?? [];
          const totalTokens = srcSlots.reduce((sum,sl)=>sum+sl.bloodTokens,0);
          const move = Math.ceil(totalTokens/2);
          let moved = 0;
          for (const sl of srcSlots) {
            const take = Math.min(sl.bloodTokens, move-moved);
            sl.bloodTokens -= take; moved += take;
            if (moved >= move) break;
          }
          // 找持牌者在此地點的 slot 加血
          const ownerSlot = s.deployments[locId]?.find(sl=>sl.playerId===choice.context.sourcePlayerId);
          if (ownerSlot) ownerSlot.bloodTokens += moved;
          this.log(`${player.name} 移動 ${moved}💧 至 ${choice.context.sourceName}（暴君凝視）`);
        } else {
          player.influence = Math.max(0, player.influence - 1);
          this.log(`${player.name} 失去 1 影響力（暴君凝視）`);
        }
        break;

      case 'NO06':
        if (option === 'flip_all') {
          const fdSlots = s.deployments[locId]?.filter(sl=>sl.playerId===choice.playerId&&sl.faceDown&&!sl.withdrawn) ?? [];
          const cost = fdSlots.length * 2;
          player.blood = Math.max(0, player.blood - cost);
          fdSlots.forEach(sl=>{ sl.faceDown = false; });
          this.log(`${player.name} 付 ${cost}💧 翻面所有牌（領先一步）`);
        } else {
          this.log(`${player.name} 選擇保持牌面朝下（領先一步）`);
        }
        break;

      case 'NO05': { // 背刺：移至王子避難所
        if (option === 'move_haven') {
          const fromSlots = s.deployments[locId];
          const slotIdx = fromSlots?.findIndex(sl => sl.playerId === choice.playerId && sl.cardId === 'NO05');
          if (slotIdx !== undefined && slotIdx !== -1 && fromSlots) {
            const [movedSlot] = fromSlots.splice(slotIdx, 1);
            movedSlot.withdrawn = false;
            s.deployments['haven'].push(movedSlot);
            this.log(`${player.name} 的背刺：移至王子避難所`);
          }
        } else {
          this.log(`${player.name} 選擇留在原地（背刺）`);
        }
        break;
      }

      case 'NO09': { // Hunt Nosferatu：移至王子避難所
        if (option === 'move_haven') {
          const fromSlots = s.deployments[locId];
          const slotIdx = fromSlots?.findIndex(sl => sl.playerId === choice.playerId && sl.cardId === 'NO09');
          if (slotIdx !== undefined && slotIdx !== -1 && fromSlots) {
            const [movedSlot] = fromSlots.splice(slotIdx, 1);
            movedSlot.withdrawn = false;
            s.deployments['haven'].push(movedSlot);
            this.log(`${player.name} 的諾斯費拉圖狩獵：移至王子避難所`);
          }
        } else {
          this.log(`${player.name} 選擇留在原地（諾斯費拉圖狩獵）`);
        }
        break;
      }

      case 'MA07': {
        const flipCount = parseInt(option, 10) || 0;
        if (flipCount > 0) {
          const targets = (s.deployments[locId] ?? [])
            .filter(sl => sl.playerId === choice.playerId && !sl.faceDown && sl.cardId !== 'MA07');
          targets.slice(0, flipCount).forEach(sl => { sl.faceDown = true; });
          this.log(`${player.name} 無腦衝擊：翻 ${flipCount} 張面朝下（各得 4 戰力）`);
        } else {
          this.log(`${player.name} 無腦衝擊：選擇不翻面`);
        }
        break;
      }

      case 'MA02':
        // 只記錄，結算在 applyAftermath 讀取所有人出價後統一執行
        this.log(`${player.name} 已秘密出價（血液拍賣）`);
        break;

      default:
        // GA05, GA07, TR05, TR07, NO07, MA01, VE07 — 在 resolution 時由 applyPreparation/applyAftermath 讀取
        this.log(`${player.name} 選擇：${option}（${choice.context.cardId}）`);
        break;
    }
  }

  getClientState(forPlayerId: string): GameStateClient {
    const s = this.state;
    const me = s.players[forPlayerId];

    const publicPlayers: Record<string, any> = {};
    Object.values(s.players).forEach(p => {
      publicPlayers[p.id] = {
        id: p.id, name: p.name, clan: p.clan,
        blood: p.blood, influence: p.influence,
        handCount: p.hand.length, allianceCount: p.alliance.length,
        diablerie: p.diablerie, deploymentsLeft: p.deploymentsLeft,
        isReady: p.isReady,
      };
    });

    const isRevealed = ['REVELATION', 'CONFLICT', 'ROUND_END', 'GAME_OVER'].includes(s.phase);

    // NO03: 暗中之眼 — 擁有者可看到其所在地點所有面朝下的牌
    const no03VisibleLocs = new Set<string>();
    for (const [locId, slots] of Object.entries(s.deployments)) {
      if (slots.some(sl => sl.playerId === forPlayerId && sl.cardId === 'NO03' && !sl.faceDown && !sl.withdrawn)) {
        no03VisibleLocs.add(locId);
      }
    }

    const filteredDeploy: Record<string, SlotVisible[]> = {};
    for (const [locId, slots] of Object.entries(s.deployments)) {
      const no03Visible = no03VisibleLocs.has(locId);
      filteredDeploy[locId] = slots.map(slot => {
        const isMine = slot.playerId === forPlayerId;
        const revealed = !slot.faceDown || isRevealed || no03Visible;
        return {
          playerId: slot.playerId,
          cardId: (isMine || revealed) ? slot.cardId : null,
          faceDown: slot.faceDown,
          bloodTokensHidden: !isMine && !revealed,
          bloodTokens: (isMine || revealed) ? slot.bloodTokens : 0,
          withdrawn: slot.withdrawn,
          effectivePower: isRevealed ? slot.effectivePower : null,
        };
      });
    }

    return {
      roomCode: s.roomCode,
      phase: s.phase,
      round: s.round,
      ambitionHolder: s.ambitionHolder,
      playerOrder: s.playerOrder,
      currentTurnPlayerId: s.currentTurnPlayerId,
      currentLocIndex: s.currentLocIndex,
      locations: s.locations,
      players: publicPlayers,
      myHand: me?.hand ?? [],
      myHandBuildDraft: me?.handBuildDraft ?? [],
      myBlood: me?.blood ?? 0,
      myAlliance: me?.alliance ?? [],
      myDiablerieTokens: me?.diablerie ?? 0,
      deployments: filteredDeploy,
      locationAllies: s.locationAllies,
      waitingFor: s.pendingChoices.length > 0
        ? [...new Set(s.pendingChoices.map(c => c.playerId))]
        : Object.values(s.players).filter(p => !p.isReady).map(p => p.id),
      lastConflictResults: s.lastConflictResults,
      winner: s.winner,
      log: s.log.slice(-80),
      myPendingChoice: s.pendingChoices.find(c => c.playerId === forPlayerId) ?? null,
      activeEffect: s.activeEffect,
      hasPendingChoices: s.pendingChoices.length > 0,
      activeChoosers: s.pendingChoices.map(c => ({
        playerId: c.playerId, cardId: c.context.cardId, locationId: c.context.locationId,
      })),
      skipVotes: [],
    };
  }

  /** 觀戰者狀態：所有部署牌面公開，無私人手牌資訊 */
  getSpectatorState(): GameStateClient {
    const s = this.state;

    const publicPlayers: Record<string, any> = {};
    Object.values(s.players).forEach(p => {
      publicPlayers[p.id] = {
        id: p.id, name: p.name, clan: p.clan,
        blood: p.blood, influence: p.influence,
        handCount: p.hand.length, allianceCount: p.alliance.length,
        diablerie: p.diablerie, deploymentsLeft: p.deploymentsLeft,
        isReady: p.isReady,
      };
    });

    const filteredDeploy: Record<string, SlotVisible[]> = {};
    for (const [locId, slots] of Object.entries(s.deployments)) {
      filteredDeploy[locId] = slots.map(slot => ({
        playerId: slot.playerId,
        cardId: slot.cardId,
        faceDown: slot.faceDown,
        bloodTokensHidden: false,
        bloodTokens: slot.bloodTokens,
        withdrawn: slot.withdrawn,
        effectivePower: slot.effectivePower,
      }));
    }

    return {
      roomCode: s.roomCode,
      phase: s.phase,
      round: s.round,
      ambitionHolder: s.ambitionHolder,
      playerOrder: s.playerOrder,
      currentTurnPlayerId: s.currentTurnPlayerId,
      currentLocIndex: s.currentLocIndex,
      locations: s.locations,
      players: publicPlayers,
      myHand: [],
      myHandBuildDraft: [],
      myBlood: 0,
      myAlliance: [],
      myDiablerieTokens: 0,
      deployments: filteredDeploy,
      locationAllies: s.locationAllies,
      waitingFor: s.pendingChoices.length > 0
        ? [...new Set(s.pendingChoices.map(c => c.playerId))]
        : Object.values(s.players).filter(p => !p.isReady).map(p => p.id),
      lastConflictResults: s.lastConflictResults,
      winner: s.winner,
      log: s.log.slice(-80),
      myPendingChoice: null,
      activeEffect: s.activeEffect,
      hasPendingChoices: s.pendingChoices.length > 0,
      activeChoosers: s.pendingChoices.map(c => ({
        playerId: c.playerId, cardId: c.context.cardId, locationId: c.context.locationId,
      })),
      skipVotes: [],
    };
  }

  private locName(id: string): string {
    return LOCATIONS.find(l => l.id === id)?.name ?? id;
  }

  log(msg: string): void {
    const ts = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.state.log.push(`[${ts}] ${msg}`);
    // 遊戲事件同步鏡像到 server console(debug 用,DEBUG_GAME=0 可關)
    dlog(`[game] ${this.state.roomCode}`, msg);
  }
}
