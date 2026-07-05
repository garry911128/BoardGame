import { useState } from 'react'
import type { CardDef, GameStateClient } from '@kindred/shared'
import { useGameActions } from './convexGame'
import CardImage from './CardImage'
import WaitingPlayers from './WaitingPlayers'
import './HandBuildScreen.css'

interface Props {
  myId: string
  gameState: GameStateClient
}

const TYPE_LABEL: Record<string, string> = {
  conflict:    '衝突',
  preparation: '準備',
  aftermath:   '後果',
  passive:     '持續',
}

function CardTile({ card, onPick, disabled, selected }: { card: CardDef; onPick?: () => void; disabled?: boolean; selected?: boolean }) {
  return (
    <button
      className={`card-tile ${onPick ? 'card-tile--pickable' : ''} ${selected ? 'card-tile--selected' : ''}`}
      onClick={onPick}
      disabled={disabled}
    >
      <CardImage cardId={card.id} clan={card.clan} />
      <div className="card-tile__body">
        <div className="card-tile__type">{TYPE_LABEL[card.type] ?? card.type}</div>
        <div className="card-tile__power">{card.power}</div>
        <div className="card-tile__name">{card.name_zh}</div>
        <div className="card-tile__name-en">{card.name_en}</div>
        {card.effect_zh && <div className="card-tile__effect">{card.effect_zh}</div>}
      </div>
    </button>
  )
}

function TypeDistribution({ cards, label }: { cards: { type: string }[]; label: string }) {
  const counts: Record<string, number> = { conflict: 0, preparation: 0, aftermath: 0, passive: 0 }
  cards.forEach(c => { if (c.type in counts) counts[c.type]++ })
  return (
    <div className="handbuild__dist">
      <span className="handbuild__dist-label">{label}：</span>
      {(['conflict','preparation','aftermath','passive'] as const).map(t => (
        <span key={t} className={`handbuild__dist-tag handbuild__dist-tag--${t} ${counts[t] === 0 ? 'handbuild__dist-tag--zero' : ''}`}>
          {TYPE_LABEL[t]} {counts[t]}
        </span>
      ))}
    </div>
  )
}

export default function HandBuildScreen({ myId, gameState }: Props) {
  const actions = useGameActions()
  const draft = gameState.myHandBuildDraft
  const hand  = gameState.myHand
  const waiting = gameState.waitingFor
  const alreadyPicked = draft.length === 0

  const [pendingCard, setPendingCard] = useState<CardDef | null>(null)

  function selectCard(card: CardDef) {
    setPendingCard(card)
  }

  function confirmPick() {
    if (!pendingCard) return
    actions.selectHandCard(pendingCard.id)
    setPendingCard(null)
  }

  return (
    <div className="handbuild">
      <div className="handbuild__round">第 {gameState.round} 回合 — 手牌建造</div>

      {/* Draft section */}
      <section className="handbuild__section">
        <div className="handbuild__section-title">
          {alreadyPicked ? '已選擇，等待其他玩家…' : `選擇一張加入手牌（${draft.length} 選 1）`}
        </div>
        {!alreadyPicked && (
          <>
            <div className="handbuild__draft">
              {draft.map(card => (
                <CardTile
                  key={card.id}
                  card={card}
                  onPick={() => selectCard(card)}
                  selected={pendingCard?.id === card.id}
                />
              ))}
            </div>
            {hand.length > 0 && <TypeDistribution cards={[...hand, ...(pendingCard ? [pendingCard] : [])]} label={pendingCard ? '加入後手牌分布（預覽）' : '目前手牌分布'} />}
            {pendingCard && (
              <div className="handbuild__confirm-bar">
                <span className="handbuild__confirm-card">選擇：<strong>{pendingCard.name_zh}</strong></span>
                <button className="btn-primary handbuild__confirm-btn" onClick={confirmPick}>確認加入手牌</button>
                <button className="btn-ghost" onClick={() => setPendingCard(null)}>重新選擇</button>
              </div>
            )}
          </>
        )}
      </section>

      {/* Current hand */}
      {hand.length > 0 && (
        <section className="handbuild__section">
          <div className="handbuild__section-title">目前手牌（{hand.length} 張）</div>
          <TypeDistribution cards={hand} label="現有分布" />
          <div className="handbuild__hand">
            {hand.map(card => (
              <CardTile key={card.id} card={card} />
            ))}
          </div>
        </section>
      )}

      {/* Waiting indicator */}
      {alreadyPicked && waiting.length > 0 && (
        <WaitingPlayers gameState={gameState} myId={myId} doneLabel="已選牌" />
      )}
    </div>
  )
}
