import type { GameStateClient } from '@kindred/shared'
import { clanOf } from './clans'
import { seatPlayers } from './playerOrder'
import './WaitingPlayers.css'

interface Props {
  gameState: GameStateClient
  myId: string
  /** 完成者的標籤,預設「已完成」 */
  doneLabel?: string
}

/**
 * 各階段共用的完成度指示:每位玩家一個 chip,
 * 已完成打勾、未完成呼吸閃爍,氏族色識別。
 */
export default function WaitingPlayers({ gameState, myId, doneLabel = '已完成' }: Props) {
  const waiting = new Set(gameState.waitingFor)
  const players = seatPlayers(gameState)
  const doneCount = players.filter(p => !waiting.has(p.id)).length

  return (
    <div className="waiting-players">
      <span className="waiting-players__count">{doneCount}/{players.length} {doneLabel}</span>
      <div className="waiting-players__chips">
        {players.map(p => {
          const clan = clanOf(p.clan)
          const isDone = !waiting.has(p.id)
          return (
            <span
              key={p.id}
              className={`waiting-chip ${isDone ? 'waiting-chip--done' : 'waiting-chip--pending'} ${p.id === myId ? 'waiting-chip--me' : ''}`}
              style={clan ? { '--chip-clan': clan.color } as React.CSSProperties : undefined}
            >
              <span className="waiting-chip__state">{isDone ? '✓' : '…'}</span>
              {clan && <span className="waiting-chip__clan-dot" />}
              <span className="waiting-chip__name">{p.name}{p.id === myId && '(你)'}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}
