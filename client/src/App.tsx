import { useEffect, useRef, useState } from 'react'
import { useConvexConnectionState } from 'convex/react'
import LobbyScreen from './LobbyScreen'
import ClanSelectScreen from './ClanSelectScreen'
import HandBuildScreen from './HandBuildScreen'
import PlanningScreen from './PlanningScreen'
import WithdrawScreen from './WithdrawScreen'
import RevelationScreen from './RevelationScreen'
import GameOverScreen from './GameOverScreen'
import CardLibrary from './CardLibrary'
import RulesModal from './RulesModal'
import PlayerHUD from './PlayerHUD'
import PhaseBanner, { PHASE_INFO } from './PhaseBanner'
import {
  GameActionsProvider,
  useBuildActions,
  useDebugState,
  useGameState,
  useHeartbeat,
  usePhaseLog,
  useSession,
} from './convexGame'
import { dlog } from './debug'
import './App.css'

// ── 席位分頁鎖 ─────────────────────────────────────────────
// 「複製分頁」會連 sessionStorage 一起複製，兩個分頁就會搶同一個席位。
// 用 BroadcastChannel 讓持有席位的分頁回應詢問；複製出來的分頁偵測到
// 席位已被佔用，就放棄憑證、當成全新分頁（顯示名字輸入），多開測試才不會打架。

let seatChannel: BroadcastChannel | null = null

/** 宣告本分頁持有此席位，回應其他分頁的詢問 */
function holdSeat(playerId: string) {
  if (typeof BroadcastChannel === 'undefined') return
  if (seatChannel) seatChannel.close()
  seatChannel = new BroadcastChannel(`kindred-seat-${playerId}`)
  seatChannel.onmessage = (e) => {
    if (e.data === 'ping') seatChannel?.postMessage('pong')
  }
}

/** 詢問是否已有其他分頁持有此席位（250ms 內無人回應視為可用） */
function seatIsFree(playerId: string): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve(true)
  return new Promise((resolve) => {
    const ch = new BroadcastChannel(`kindred-seat-${playerId}`)
    const timer = setTimeout(() => {
      ch.close()
      resolve(true)
    }, 250)
    ch.onmessage = (e) => {
      if (e.data === 'pong') {
        clearTimeout(timer)
        ch.close()
        resolve(false)
      }
    }
    ch.postMessage('ping')
  })
}

export default function App() {
  const { session, saveSession, clearSession } = useSession()
  const [errorMsg, setErrorMsg] = useState('')
  const [showLibrary, setShowLibrary] = useState(false)
  const [showRules, setShowRules] = useState(false)

  const actions = useBuildActions({ session, saveSession, onError: setErrorMsg })
  const rawState = useGameState(session)
  const gameState = rawState ?? null
  const myId = session?.playerId ?? ''

  useHeartbeat(session)
  useDebugState(gameState)

  const conn = useConvexConnectionState()
  const connected = conn.isWebSocketConnected
  const wasConnected = conn.hasEverConnected

  // ── 席位鎖：掛載時檢查是否有別的分頁已持有此席位 ──
  const seatCheckedRef = useRef(false)
  useEffect(() => {
    if (!session || seatCheckedRef.current) return
    seatCheckedRef.current = true
    dlog('conn', 'found saved session, checking seat lock…', session.playerId)
    seatIsFree(session.playerId).then((free) => {
      if (free) {
        dlog('conn', 'seat free → hold', session.roomCode, session.playerId)
        holdSeat(session.playerId)
      } else {
        // 複製分頁：放棄複製來的憑證，當成全新分頁
        dlog('conn', 'seat held by another tab → treating as fresh tab')
        clearSession()
        seatCheckedRef.current = false
      }
    })
  }, [session, clearSession])

  // ── rejoinFailed：有 session 但 query 回 null（房間已消失/席位被移除） ──
  useEffect(() => {
    if (session && rawState === null) {
      dlog('conn', 'room gone → rejoinFailed', session.roomCode)
      clearSession()
      setErrorMsg('原本的對局已無法加入')
      setTimeout(() => setErrorMsg(''), 3000)
    }
  }, [session, rawState, clearSession])

  const phase = gameState?.phase ?? null
  usePhaseLog(phase, gameState?.round)

  // 判斷目前是否需要玩家行動
  const needsAction = (() => {
    if (!gameState || !myId) return false
    const w = gameState.waitingFor
    const actionPhases = ['PLANNING', 'WITHDRAW', 'HAND_BUILD', 'REVELATION', 'ROUND_END']
    return actionPhases.includes(phase ?? '') && w.includes(myId)
  })()

  function renderScreen() {
    if (!gameState) return <LobbyScreen myId={myId} gameState={null} onError={setErrorMsg} />

    switch (phase) {
      case 'LOBBY':
        return <LobbyScreen myId={myId} gameState={gameState} onError={setErrorMsg} />
      case 'CLAN_SELECT':
        return <ClanSelectScreen myId={myId} gameState={gameState} />
      case 'HAND_BUILD':
        return <HandBuildScreen myId={myId} gameState={gameState} />
      case 'PLANNING':
        return <PlanningScreen myId={myId} gameState={gameState} />
      case 'WITHDRAW':
        return <WithdrawScreen myId={myId} gameState={gameState} />
      case 'REVELATION':
      case 'ROUND_END':
        return <RevelationScreen myId={myId} gameState={gameState} />
      case 'GAME_OVER':
        return <GameOverScreen myId={myId} gameState={gameState} />
      default:
        return <div className="app-placeholder"><div className="app-placeholder__phase">{phase}</div></div>
    }
  }

  // session 存在但狀態尚未載入 → 視為重連/恢復中（顯示連線遮罩）
  const restoring = !!session && rawState === undefined

  return (
    <GameActionsProvider value={actions}>
    <div className="app">
      <header className="app-header">
        <div className="app-header__title">Kindred: Blood &amp; Betrayal</div>
        <div className="app-header__right">
          {gameState && !['LOBBY', 'GAME_OVER'].includes(phase ?? '') && (
            <span className="app-header__round">
              第 {gameState.round} 回合
              {phase && PHASE_INFO[phase] && (
                <span className="app-header__phase"> · {PHASE_INFO[phase]!.title}</span>
              )}
            </span>
          )}
          {needsAction && (
            <span className="app-header__action-badge">輪到你了</span>
          )}
          <button className="app-header__icon-btn" onClick={() => setShowLibrary(true)} title="卡牌圖鑑">
            📖
          </button>
          <button className="app-header__icon-btn" onClick={() => setShowRules(true)} title="遊戲規則">
            ?
          </button>
          <div className={`app-header__conn ${connected ? 'app-header__conn--on' : ''}`}>
            {connected ? '● 已連線' : '○ 連線中…'}
          </div>
        </div>
      </header>

      {gameState && !['LOBBY', 'GAME_OVER'].includes(phase ?? '') && (
        <PlayerHUD myId={myId} gameState={gameState} />
      )}

      <main className="app-main">
        {renderScreen()}
      </main>

      <PhaseBanner phase={phase} round={gameState?.round ?? 0} />

      {(!connected || restoring) && (
        <div className="app-disconnect-overlay">
          <div className="app-disconnect-box">
            <div className="app-disconnect-icon">⚡</div>
            <div className="app-disconnect-title">{wasConnected ? '連線中斷' : '連線中…'}</div>
            <div className="app-disconnect-msg">
              {wasConnected
                ? '正在自動重連，請稍候…遊戲狀態將在重連後恢復。'
                : '正在連接伺服器…'}
            </div>
          </div>
        </div>
      )}

      {errorMsg && <div className="app-error">{errorMsg}</div>}

      {showLibrary && <CardLibrary onClose={() => setShowLibrary(false)} />}
      {showRules   && <RulesModal  onClose={() => setShowRules(false)} />}
    </div>
    </GameActionsProvider>
  )
}
