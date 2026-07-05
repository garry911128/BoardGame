import { useState } from 'react'
import type { GameStateClient } from '@kindred/shared'
import { useGameActions } from './convexGame'
import { seatPlayers } from './playerOrder'
import RulesModal from './RulesModal'
import './LobbyScreen.css'

interface Props {
  myId: string
  gameState: GameStateClient | null
  onError: (msg: string) => void
}

export default function LobbyScreen({ myId, gameState, onError }: Props) {
  const actions = useGameActions()
  const [name, setName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [view, setView] = useState<'home' | 'join'>('home')
  const [showRules, setShowRules] = useState(false)
  const [copied, setCopied] = useState(false)

  function copyCode() {
    if (!gameState) return
    const code = gameState.roomCode
    // navigator.clipboard 只在 https / localhost 存在;
    // 朋友用 VPN IP 的 http:// 開頁面時是 undefined,要用舊 API fallback
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).catch(() => fallbackCopy(code))
    } else {
      fallbackCopy(code)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function fallbackCopy(text: string) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* 複製失敗就算了,房號本來就顯示在畫面上 */ }
    document.body.removeChild(ta)
  }

  const inRoom = gameState !== null
  const players = inRoom ? seatPlayers(gameState) : []
  // 房主由 state.hostId 決定（不可用 players[0]：Convex 會排序 players key，插入順序不保留）
  const isHost = inRoom && gameState.hostId === myId
  const canStart = players.length >= 3

  function handleCreate() {
    const n = name.trim()
    if (!n) { onError('請輸入名字'); return }
    actions.createRoom({ name: n })
  }

  function handleJoin() {
    const n = name.trim()
    const c = joinCode.trim().toUpperCase()
    if (!n) { onError('請輸入名字'); return }
    if (c.length !== 4) { onError('房間代碼為 4 碼'); return }
    actions.joinRoom({ code: c, name: n })
  }

  function handleStart() {
    actions.readyStart()
  }

  if (inRoom) {
    return (
      <>
        {showRules && <RulesModal onClose={() => setShowRules(false)} />}
      <div className="lobby-room">
        <div className="lobby-room__header">
          <span className="lobby-room__label">房間代碼</span>
          <div className="lobby-room__code-row">
            <span className="lobby-room__code">{gameState.roomCode}</span>
            <button className="lobby-room__copy-btn" onClick={copyCode} title="複製代碼">
              {copied ? '✓ 已複製' : '複製'}
            </button>
          </div>
        </div>

        <div className="lobby-room__players">
          <div className="lobby-room__players-title">玩家 {players.length}/6</div>
          {players.map((p) => (
            <div key={p.id} className="lobby-room__player">
              <span className="lobby-room__player-name">
                {p.name}
                {p.id === myId && ' (你)'}
              </span>
              {p.id === gameState.hostId && <span className="lobby-room__host-badge">房主</span>}
            </div>
          ))}
        </div>

        {!canStart && (
          <div className="lobby-room__hint">
            等待更多玩家加入…（至少需要 3 人）
          </div>
        )}

        {isHost && (
          <button className="btn-primary" onClick={handleStart} disabled={!canStart}>
            開始遊戲
          </button>
        )}

        {!isHost && canStart && (
          <div className="lobby-room__hint">等待房主開始遊戲…</div>
        )}

        <button className="lobby-entry__rules-btn" onClick={() => setShowRules(true)}>
          📖 查看遊戲規則
        </button>
      </div>
      </>
    )
  }

  return (
    <>
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}

      <div className="lobby-entry">

        {/* ── 遊戲標語 ── */}
        <div className="lobby-entry__tagline">
          <div className="lobby-entry__tagline-title">血與背叛</div>
          <div className="lobby-entry__tagline-sub">3–6 人 · 3 回合 · 影響力最高者稱王</div>
        </div>

        <div className="lobby-entry__name-row">
          <input
            placeholder="輸入你的名字"
            value={name}
            maxLength={16}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (view === 'home' ? handleCreate() : handleJoin())}
          />
        </div>

        {view === 'home' && (
          <div className="lobby-entry__actions">
            <button className="btn-primary" onClick={handleCreate}>建立房間</button>
            <button className="btn-ghost" onClick={() => setView('join')}>加入房間</button>
          </div>
        )}

        {view === 'join' && (
          <div className="lobby-entry__actions">
            <input
              placeholder="房間代碼（4碼）"
              value={joinCode}
              maxLength={4}
              onChange={e => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
              style={{ textTransform: 'uppercase', letterSpacing: '4px', textAlign: 'center' }}
            />
            <button className="btn-primary" onClick={handleJoin}>加入</button>
            <button className="btn-ghost" onClick={() => setView('home')}>返回</button>
          </div>
        )}

        {/* ── 規則按鈕 ── */}
        <button className="lobby-entry__rules-btn" onClick={() => setShowRules(true)}>
          📖 查看遊戲規則
        </button>

      </div>
    </>
  )
}
