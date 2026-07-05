import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useMutation, useQuery } from 'convex/react'
import { anyApi } from 'convex/server'
import { ConvexError } from 'convex/values'
import type {
  ClanId,
  Deployment,
  GameStateClient,
} from '@kindred/shared'
import { dlog, debugEnabled } from './debug'

// api 以 anyApi 鬆散型別引用：避免 import convex/_generated/api 把 convex/ +
// server/ 的型別圖拉進 client tsc（plan §3：client build 不得依賴 server workspace）。
const api = anyApi

// ── Session 憑證（沿用原 socket 的 sessionStorage 機制） ──────────

export const SESSION_KEY = 'kindred_session'

export interface SavedSession {
  playerId: string
  roomCode: string
  token: string
}

export function loadSession(): SavedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as SavedSession) : null
  } catch {
    return null
  }
}

/** session 狀態 + sessionStorage 同步（入房/重整後歸位）。 */
export function useSession() {
  const [session, setSession] = useState<SavedSession | null>(() => loadSession())

  const saveSession = useCallback((s: SavedSession) => {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
    } catch {
      /* ignore */
    }
    setSession(s)
  }, [])

  const clearSession = useCallback(() => {
    try {
      sessionStorage.removeItem(SESSION_KEY)
    } catch {
      /* ignore */
    }
    setSession(null)
  }, [])

  return { session, saveSession, clearSession }
}

// ── 狀態訂閱（取代 socket 的 gameState 廣播） ─────────────────────

/**
 * 反應式訂閱房間狀態。
 * 無 session → skip（回 undefined，視為大廳）。
 * 有 session：回 GameStateClient（正常）或 null（房間已消失 = 原 rejoinFailed）。
 */
export function useGameState(
  session: SavedSession | null,
): GameStateClient | null | undefined {
  const args = session
    ? {
        roomCode: session.roomCode,
        playerId: session.playerId,
        token: session.token,
      }
    : 'skip'
  return useQuery(api.game.state, args as never) as
    | GameStateClient
    | null
    | undefined
}

// ── Debug：集中攔截狀態更新（對應原 socket.ts 的 recv log） ──────

/** gameState 太大，摘要成一行關鍵狀態。 */
function summarizeState(s: GameStateClient) {
  return {
    phase: s.phase,
    round: s.round,
    turn: s.currentTurnPlayerId,
    locIndex: s.currentLocIndex,
    waitingFor: s.waitingFor,
    effect: s.activeEffect
      ? `${s.activeEffect.step} ${s.activeEffect.eventIndex + 1}/${s.activeEffect.eventCount}`
      : null,
    choosers: s.activeChoosers?.map((c) => c.playerId) ?? [],
    skipVotes: s.skipVotes ?? [],
    results: s.lastConflictResults?.length ?? 0,
  }
}

/** 每次收到新狀態即 log 一行（取代 socket.onAny 的 recv 攔截）。 */
export function useDebugState(state: GameStateClient | null | undefined): void {
  useEffect(() => {
    if (!debugEnabled || !state) return
    dlog('recv', 'gameState', summarizeState(state))
  }, [state])
}

// ── 心跳（lastSeen；不自動踢人，僅供離線標記用） ─────────────────

export function useHeartbeat(session: SavedSession | null): void {
  const heartbeat = useMutation(api.rooms.heartbeat)
  useEffect(() => {
    if (!session) return
    const tick = () => {
      heartbeat({
        roomCode: session.roomCode,
        playerId: session.playerId,
        token: session.token,
      }).catch(() => {
        /* 心跳失敗不影響遊戲 */
      })
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [session, heartbeat])
}

// ── 動作集合（取代 socket.emit；簽名對齊原 ClientToServer 事件） ──

export interface GameActions {
  createRoom(payload: { name: string }): void
  joinRoom(payload: { code: string; name: string }): void
  readyStart(): void
  selectClan(clan: ClanId): void
  selectHandCard(cardId: string): void
  submitDeployment(deployment: Deployment | { skip: true }): void
  submitWithdraw(payload: { locationId: string; withdraw: boolean }): void
  drainAlly(allyId: string): void
  readyAdvance(): void
  respondChoice(payload: { choiceId: string; option: string }): void
  skipEffects(): void
  leave(): void
}

/** ConvexError 帶著與舊 socket 'error' 事件同樣的中文訊息字串。 */
function errMsg(err: unknown): string {
  if (err instanceof ConvexError) return String(err.data)
  return '發生錯誤，請稍後再試'
}

interface BuildActionsOpts {
  session: SavedSession | null
  saveSession: (s: SavedSession) => void
  onError: (msg: string) => void
}

/**
 * 建立動作集合（App 呼叫，透過 context 下發給各 screen）。
 * 每個動作：dlog('emit', …) → 呼叫對應 mutation → ConvexError 轉 toast。
 */
export function useBuildActions(opts: BuildActionsOpts): GameActions {
  const { session, saveSession, onError } = opts

  const createRoomM = useMutation(api.rooms.create)
  const joinRoomM = useMutation(api.rooms.join)
  const readyStartM = useMutation(api.game.readyStart)
  const selectClanM = useMutation(api.game.selectClan)
  const selectHandCardM = useMutation(api.game.selectHandCard)
  const drainAllyM = useMutation(api.game.drainAlly)
  const submitDeploymentM = useMutation(api.game.submitDeployment)
  const submitWithdrawM = useMutation(api.game.submitWithdraw)
  const respondChoiceM = useMutation(api.game.respondChoice)
  const readyAdvanceM = useMutation(api.game.readyAdvance)
  const skipEffectsM = useMutation(api.game.skipEffects)
  const leaveM = useMutation(api.rooms.leave)

  return useMemo<GameActions>(() => {
    const auth = () =>
      session
        ? {
            roomCode: session.roomCode,
            playerId: session.playerId,
            token: session.token,
          }
        : null

    // 需要席位驗證的動作共用骨架。
    const run = (
      name: string,
      mutation: (args: Record<string, unknown>) => Promise<unknown>,
      payload: Record<string, unknown> = {},
    ) => {
      dlog('emit', name, payload)
      const a = auth()
      if (!a) {
        onError('工作階段無效，請重新加入')
        return
      }
      mutation({ ...a, ...payload }).catch((e) => onError(errMsg(e)))
    }

    return {
      createRoom({ name }) {
        dlog('emit', 'createRoom', { name })
        createRoomM({ name })
          .then((res) => saveSession(res as SavedSession))
          .catch((e) => onError(errMsg(e)))
      },
      joinRoom({ code, name }) {
        dlog('emit', 'joinRoom', { code, name })
        joinRoomM({ code, name })
          .then((res) => saveSession(res as SavedSession))
          .catch((e) => onError(errMsg(e)))
      },
      readyStart() {
        run('readyStart', readyStartM)
      },
      selectClan(clan) {
        run('selectClan', selectClanM, { clan })
      },
      selectHandCard(cardId) {
        run('selectHandCard', selectHandCardM, { cardId })
      },
      submitDeployment(deployment) {
        run('submitDeployment', submitDeploymentM, { deployment })
      },
      submitWithdraw({ locationId, withdraw }) {
        run('submitWithdraw', submitWithdrawM, { locationId, withdraw })
      },
      drainAlly(allyId) {
        run('drainAlly', drainAllyM, { allyId })
      },
      readyAdvance() {
        run('readyAdvance', readyAdvanceM)
      },
      respondChoice({ choiceId, option }) {
        run('respondChoice', respondChoiceM, { choiceId, option })
      },
      skipEffects() {
        run('skipEffects', skipEffectsM)
      },
      leave() {
        run('leave', leaveM)
      },
    }
  }, [
    session,
    saveSession,
    onError,
    createRoomM,
    joinRoomM,
    readyStartM,
    selectClanM,
    selectHandCardM,
    drainAllyM,
    submitDeploymentM,
    submitWithdrawM,
    respondChoiceM,
    readyAdvanceM,
    skipEffectsM,
    leaveM,
  ])
}

// ── Context：各 screen 以 useGameActions() 取用（取代 import socket） ──

const ActionsContext = createContext<GameActions | null>(null)

export const GameActionsProvider = ActionsContext.Provider

export function useGameActions(): GameActions {
  const ctx = useContext(ActionsContext)
  if (!ctx) {
    throw new Error('useGameActions 必須在 <GameActionsProvider> 內使用')
  }
  return ctx
}

// 供 App 的階段轉換 log 用（保留原 dlog('phase', …) 行為）。
export function usePhaseLog(
  phase: string | null,
  round: number | undefined,
): void {
  const prev = useRef<string | null>(null)
  useEffect(() => {
    if (phase !== prev.current) {
      dlog('phase', `${prev.current ?? '(init)'} → ${phase}`, 'round', round)
      prev.current = phase
    }
  }, [phase, round])
}
