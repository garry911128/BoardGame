import type { GameStateClient, PlayerPublic } from '@kindred/shared'
import { clanOf } from './clans'
import { seatPlayers } from './playerOrder'
import { useDeltaFlash } from './useDeltaFlash'
import './PlayerSeats.css'

interface Props {
  gameState: GameStateClient
  myId: string
  /**
   * 每個座位的活動狀態章:pid → 標籤文字。
   * 例:{ p2: '出牌中' }、{ p1: '選擇中…', p3: '選擇中…' }。
   * 有標籤的座位以氏族色光暈高亮。
   */
  activeStatuses?: Record<string, string>
  /** 已完成本階段行動的玩家(打勾、降亮) */
  doneIds?: Set<string>
  /** 顯示出牌輪序編號(PLANNING 用) */
  showTurnOrder?: boolean
  /** 目前效果的目標玩家(紅色脈衝,表示「正在被影響」) */
  targetId?: string | null
  /** 本地點勝者(加冕演出) */
  winnerId?: string | null
}

function SeatStat({ value, className, title, icon }: {
  value: number
  className: string
  title?: string
  icon: string
}) {
  const flashes = useDeltaFlash(value)
  return (
    <span className={`seat__stat ${className}`} title={title}>
      <span className="seat__stat-wrap">
        {icon}{value}
        {flashes.map(f => (
          <span key={f.id} className={`seat__delta ${f.value > 0 ? 'seat__delta--up' : 'seat__delta--down'}`}>
            {f.value > 0 ? '+' : ''}{f.value}
          </span>
        ))}
      </span>
    </span>
  )
}

function Seat({ p, isMe, status, isDone, isTarget, isWinner, turnNo }: {
  p: PlayerPublic
  isMe: boolean
  status: string | undefined
  isDone: boolean
  isTarget: boolean
  isWinner: boolean
  turnNo: number | undefined
}) {
  const clan = clanOf(p.clan)
  const isActive = status !== undefined
  const nearFrenzy = p.blood <= 2
  return (
    <div
      className={[
        'seat',
        isActive ? 'seat--active' : '',
        isDone && !isActive ? 'seat--done' : '',
        isMe ? 'seat--me' : '',
        nearFrenzy ? 'seat--danger' : '',
        isTarget ? 'seat--target' : '',
        isWinner ? 'seat--winner' : '',
      ].filter(Boolean).join(' ')}
      style={clan ? { '--seat-clan': clan.color } as React.CSSProperties : undefined}
    >
      {isWinner && <div className="seat__crown">♛</div>}
      <div className="seat__top">
        {turnNo !== undefined && (
          <span className="seat__order" title={`第 ${turnNo} 位出牌`}>{turnNo}</span>
        )}
        <span className="seat__name">{p.name}{isMe && <span className="seat__me-tag">你</span>}</span>
        {isDone && !isActive && <span className="seat__done-mark">✓</span>}
      </div>
      {clan && <div className="seat__clan">{clan.zh}</div>}
      <div className="seat__stats">
        <SeatStat value={p.blood} icon="🩸" className={`seat__stat--blood ${nearFrenzy ? 'seat__stat--low' : ''}`} title={nearFrenzy ? '瀕臨狂暴！' : '血液'} />
        <SeatStat value={p.influence} icon="🏆" className="seat__stat--inf" title="影響力" />
        <span className="seat__stat" title="手牌數">🂠{p.handCount}</span>
        {p.diablerie > 0 && (
          <span className="seat__stat seat__stat--diab" title={`弒親代幣 ${p.diablerie}/3`}>👁{p.diablerie}</span>
        )}
      </div>
      {isActive && <div className="seat__active-label">{status}</div>}
    </div>
  )
}

/**
 * 固定座位列:所有玩家依「加入順序」排列,整場遊戲位置不變,
 * 讓玩家用空間記憶辨識對手。輪序用編號徽章、活動狀態用狀態章表示。
 */
export default function PlayerSeats({
  gameState, myId, activeStatuses = {}, doneIds, showTurnOrder = false, targetId, winnerId,
}: Props) {
  const seats = seatPlayers(gameState)
  const turnIndex = new Map(gameState.playerOrder.map((pid, i) => [pid, i + 1]))

  return (
    <div className="seats">
      {seats.map(p => (
        <Seat
          key={p.id}
          p={p}
          isMe={p.id === myId}
          status={activeStatuses[p.id]}
          isDone={doneIds?.has(p.id) ?? false}
          isTarget={p.id === targetId}
          isWinner={p.id === winnerId}
          turnNo={showTurnOrder ? turnIndex.get(p.id) : undefined}
        />
      ))}
    </div>
  )
}
