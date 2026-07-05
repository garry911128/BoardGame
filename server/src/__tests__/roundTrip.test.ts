/**
 * State round-trip test (Convex migration, plan §5).
 *
 * Convex stores the whole GameStateFull as a JSON document. Every mutation does
 * load → JSON deserialize → GameEngine.fromState → run → save. This test proves:
 *   1. JSON.parse(JSON.stringify(state)) loses nothing (the Set→array landmine).
 *   2. An engine rehydrated via fromState() mid-game continues identically to one
 *      that was never serialized.
 */
import { describe, it, expect } from 'vitest';
import { GameEngine } from '../gameEngine';
import type { GameStateFull } from '@kindred/shared';

type CardSpec = { id: string; name_zh: string; clan: string; type: string; power: number };
function card(id: string, name_zh: string, clan: string, type: string, power: number): CardSpec {
  return { id, name_en: id, name_zh, clan, type, power, is_starter: false } as any;
}

type PlayerSpec = { pid: string; name: string; clan: string; hand: CardSpec[] };
function startGame(specs: PlayerSpec[]): GameEngine {
  const engine = new GameEngine('RT');
  specs.forEach(({ pid, name }) => engine.addPlayer(pid, name));
  engine.startClanSelect();
  specs.forEach(({ pid, clan }) => engine.selectClan(pid, clan as any));
  engine.startHandBuild();
  specs.forEach(({ pid, hand }) => {
    const p = engine.state.players[pid];
    p.hand = hand as any[];
    p.handBuildDraft = [];
    p.isReady = true;
  });
  engine.state.victimDeck = [];
  engine.state.locationAllies = Object.fromEntries(engine.state.locations.map(l => [l.id, null]));
  engine.startRound();
  return engine;
}

function deploy(engine: GameEngine, pid: string, locId: string, cardId: string) {
  engine.state.currentTurnPlayerId = pid;
  engine.state.players[pid].isReady = false;
  return engine.submitDeployment(pid, { locationId: locId, cardId, faceDown: false, bloodTokens: 0 });
}

/** Deploy two cards each at rack + asylum, ready up, enter WITHDRAW at the first location. */
function buildToWithdraw(): GameEngine {
  const engine = startGame([
    { pid: 'p1', name: '愛麗絲', clan: 'brujah', hand: [card('VE08', '備戰', 'ventrue', 'conflict', 2), card('BR07', '展示武力', 'brujah', 'preparation', 3)] },
    { pid: 'p2', name: '鮑勃', clan: 'ventrue', hand: [card('BR01', '血腥狂怒', 'brujah', 'conflict', 6), card('VE08', '備戰', 'ventrue', 'conflict', 2)] },
  ]);
  deploy(engine, 'p1', 'rack', 'VE08');
  deploy(engine, 'p2', 'rack', 'BR01');
  deploy(engine, 'p1', 'asylum', 'BR07');
  deploy(engine, 'p2', 'asylum', 'VE08');
  Object.values(engine.state.players).forEach(p => (p.isReady = true));
  engine.startResolutionPhase(); // → WITHDRAW at first location
  return engine;
}

/** Resolve the current location fully (withdraw none → reveal → resolve → advance). */
function resolveCurrentLoc(engine: GameEngine) {
  const s = engine.state;
  const loc = s.locations[s.currentLocIndex];
  Object.keys(s.players).forEach(pid => engine.submitWithdraw(pid, loc.id, false));
  engine.applyWithdrawals();
  engine.revealLocation(loc.id);
  engine.setupPendingChoices();
  const result = engine.resolveCurrentLocation();
  engine.setupPostResolutionChoices();
  return result;
}

describe('state round-trip (Convex serialization)', () => {
  it('JSON.parse(JSON.stringify(state)) loses nothing after a full resolution', () => {
    const engine = buildToWithdraw();
    resolveCurrentLoc(engine);

    const snap: GameStateFull = JSON.parse(JSON.stringify(engine.state));
    // Deep equality proves no field is a Set/Map/undefined that survives poorly.
    expect(snap).toEqual(engine.state);
    // forestallImmune must be a plain object of string[] (the migrated shape).
    expect(Array.isArray(Object.values(snap.forestallImmune)[0] ?? [])).toBe(true);
  });

  it('fromState() after a mid-game JSON round-trip continues identically', () => {
    // One shared starting point (decks are shuffled randomly, so both engines
    // must derive from the same snapshot to be comparable).
    const base: GameStateFull = JSON.parse(JSON.stringify(buildToWithdraw().state));
    const direct = GameEngine.fromState(JSON.parse(JSON.stringify(base)));
    const rehydrated = GameEngine.fromState(JSON.parse(JSON.stringify(base)));

    // Same starting point.
    expect(JSON.parse(JSON.stringify(rehydrated.state))).toEqual(direct.state);

    // Continue both through the first location resolution with identical ops.
    const rDirect = resolveCurrentLoc(direct);
    const rRehydrated = resolveCurrentLoc(rehydrated);

    expect(rRehydrated).toEqual(rDirect);
    // Whole state (blood, influence, deployments, log, conflict results) matches.
    expect(JSON.parse(JSON.stringify(rehydrated.state))).toEqual(direct.state);
  });

  it('re-serializing between every engine call still lands on the same state', () => {
    // Simulate the Convex load→run→save loop: round-trip the state before each call.
    const base: GameStateFull = JSON.parse(JSON.stringify(buildToWithdraw().state));
    let state: GameStateFull = JSON.parse(JSON.stringify(base));
    const step = (fn: (e: GameEngine) => void) => {
      const e = GameEngine.fromState(state);
      fn(e);
      state = JSON.parse(JSON.stringify(e.state)); // "save"
    };

    const loc = state.locations[state.currentLocIndex].id;
    step(e => Object.keys(e.state.players).forEach(pid => e.submitWithdraw(pid, loc, false)));
    step(e => e.applyWithdrawals());
    step(e => e.revealLocation(loc));
    step(e => e.setupPendingChoices());
    step(e => e.resolveCurrentLocation());

    // Compare against a never-serialized run from the same base snapshot.
    const direct = GameEngine.fromState(JSON.parse(JSON.stringify(base)));
    resolveCurrentLoc(direct);
    expect(state.lastConflictResults).toEqual(direct.state.lastConflictResults);
    expect(state.players).toEqual(direct.state.players);
  });
});
