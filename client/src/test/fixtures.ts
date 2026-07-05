import type { AllyCard, CardDef, ClanId, GameStateClient, LocationDef, PlayerPublic } from '@kindred/shared'

export const clans: ClanId[] = [
  'brujah',
  'nosferatu',
  'toreador',
  'tremere',
  'malkavian',
  'gangrel',
  'ventrue',
]

export function card(overrides: Partial<CardDef> = {}): CardDef {
  return {
    id: 'BR01',
    name_en: 'Bloody Fury',
    name_zh: 'Bloody Fury',
    clan: 'brujah',
    type: 'conflict',
    power: 6,
    effect_en: null,
    effect_zh: null,
    is_starter: false,
    ...overrides,
  }
}

export function player(id: string, overrides: Partial<PlayerPublic> = {}): PlayerPublic {
  return {
    id,
    name: id,
    clan: null,
    blood: 6,
    influence: 3,
    handCount: 0,
    allianceCount: 0,
    diablerie: 0,
    deploymentsLeft: 1,
    isReady: false,
    ...overrides,
  }
}

export const locations: LocationDef[] = [
  { id: 'rack', name: 'The Rack', influence: [[1, 0], [1, 1], [2, 1]], isPrinces: false },
  { id: 'asylum', name: 'The Asylum', influence: [[1, 0], [1, 1], [2, 1]], isPrinces: false },
  { id: 'club_zombie', name: 'Club Zombie', influence: [[1, 0], [1, 1], [2, 1]], isPrinces: false },
  { id: 'haven', name: "Prince's Haven", influence: [[2, 0], [2, 1], [3, 1]], isPrinces: true },
]

export const kine: AllyCard = {
  id: 'kine',
  name: 'Kine',
  type: 'human',
  influence: 1,
  feedBlood: 1,
  drainBlood: 2,
  drainInfluence: 0,
}

export function gameState(overrides: Partial<GameStateClient> = {}): GameStateClient {
  const basePlayers: Record<string, PlayerPublic> = {
    p1: player('p1', { name: 'Alice', clan: 'brujah', handCount: 1 }),
    p2: player('p2', { name: 'Bob', clan: 'ventrue', isReady: false }),
  }

  return {
    roomCode: 'TEST',
    phase: 'LOBBY',
    round: 1,
    ambitionHolder: 'p1',
    hostId: 'p1',
    playerOrder: ['p1', 'p2'],
    currentTurnPlayerId: 'p1',
    currentLocIndex: 0,
    locations,
    players: basePlayers,
    myHand: [],
    myHandBuildDraft: [],
    myBlood: 6,
    myAlliance: [kine],
    myDiablerieTokens: 0,
    deployments: Object.fromEntries(locations.map(location => [location.id, []])),
    locationAllies: Object.fromEntries(locations.map(location => [location.id, null])),
    waitingFor: ['p1', 'p2'],
    lastConflictResults: [],
    winner: null,
    log: [],
    myPendingChoice: null,
    activeEffect: null,
    hasPendingChoices: false,
    activeChoosers: [],
    skipVotes: [],
    ...overrides,
  }
}
