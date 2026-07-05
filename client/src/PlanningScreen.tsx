import { useState } from 'react'
import type { CardDef, GameStateClient, AllyCard, ClanId } from '@kindred/shared'
import { useGameActions } from './convexGame'
import { seatIds } from './playerOrder'
import CardImage from './CardImage'
import { locationImageSrc, allyImageSrc } from './cardImages'
import { CARD_DEFS, TYPE_LABEL_ZH } from './cardDefs'
import { clanOf } from './clans'
import WaitingPlayers from './WaitingPlayers'
import PlayerSeats from './PlayerSeats'
import './PlanningScreen.css'

interface Props {
  myId: string
  gameState: GameStateClient
}

const TYPE_LABEL: Record<string, string> = {
  conflict: '衝突', preparation: '準備', aftermath: '後果', passive: '持續',
}

// ── Deploy Dialog ──────────────────────────────────────────────

interface DeployDialogProps {
  card: CardDef
  locId: string
  locName: string
  myBlood: number
  isMine: boolean // is Nosferatu (faceDown free)
  onConfirm: (faceDown: boolean, bloodTokens: number) => void
  onCancel: () => void
}

function DeployDialog({ card, locName, myBlood, isMine, onConfirm, onCancel }: DeployDialogProps) {
  const [faceDown, setFaceDown] = useState(false)
  const [tokens, setTokens] = useState(0)

  const faceDownCost = isMine ? 0 : (faceDown ? 1 : 0)
  const totalCost = faceDownCost + tokens
  const canAfford = myBlood >= totalCost

  return (
    <div className="deploy-dialog-overlay" onClick={onCancel}>
      <div className="deploy-dialog" onClick={e => e.stopPropagation()}>
        <div className="deploy-dialog__header">
          部署至 <strong>{locName}</strong>
        </div>
        <div className="deploy-dialog__card-preview">
          <CardImage cardId={card.id} clan={card.clan} className="deploy-dialog__card-img" />
          <div className="deploy-dialog__card-info">
            <div className="deploy-dialog__card-name">{card.name_zh}</div>
            <div className="deploy-dialog__card-name-en">{card.name_en}</div>
            <div className="deploy-dialog__card-power">戰力 {card.power}</div>
            {card.effect_zh && <div className="deploy-dialog__card-effect">{card.effect_zh}</div>}
          </div>
        </div>

        <label className="deploy-dialog__row">
          <input type="checkbox" checked={faceDown} onChange={e => setFaceDown(e.target.checked)} />
          <span>
            秘密部署（正面朝下）
            {!isMine && <span className="deploy-dialog__cost"> −1 血</span>}
            {isMine && <span className="deploy-dialog__free"> 免費</span>}
          </span>
        </label>

        <div className="deploy-dialog__row">
          <span>追加血液代幣：</span>
          <div className="deploy-dialog__token-ctrl">
            <button onClick={() => setTokens(t => Math.max(0, t - 1))} disabled={tokens === 0}>−</button>
            <span className="deploy-dialog__token-val">{tokens}</span>
            <button onClick={() => setTokens(t => t + 1)} disabled={myBlood < totalCost + 1}>+</button>
          </div>
          {tokens > 0 && <span className="deploy-dialog__cost">−{tokens} 血</span>}
        </div>

        <div className="deploy-dialog__total">
          消耗：<span className={canAfford ? '' : 'deploy-dialog__insufficient'}>{totalCost} 血</span>
          ，剩餘：{myBlood - totalCost}
        </div>

        <div className="deploy-dialog__actions">
          <button className="btn-primary" onClick={() => onConfirm(faceDown, tokens)} disabled={!canAfford}>
            確認部署
          </button>
          <button className="btn-ghost" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────

export default function PlanningScreen({ myId, gameState }: Props) {
  const actions = useGameActions()
  const me = gameState.players[myId]
  const hand = gameState.myHand
  const alliance = gameState.myAlliance
  const waiting = gameState.waitingFor
  const alreadyDone = !waiting.includes(myId)
  const isMyTurn = gameState.currentTurnPlayerId === myId
  const canDeploy = !alreadyDone && isMyTurn

  const [selectedCard, setSelectedCard] = useState<CardDef | null>(null)
  const [dialog, setDialog] = useState<{ card: CardDef; locId: string; locName: string } | null>(null)
  const [expandedAllies, setExpandedAllies] = useState<Set<string>>(new Set())
  const [slotPopup, setSlotPopup] = useState<{ cardId: string; ownerName: string } | null>(null)
  const [flashLocId, setFlashLocId] = useState<string | null>(null)
  const [drainConfirm, setDrainConfirm] = useState<AllyCard | null>(null)
  const [skipConfirm, setSkipConfirm] = useState(false)

  function selectCard(card: CardDef) {
    setSelectedCard(prev => prev?.id === card.id ? null : card)
  }

  function clickLocation(locId: string, locName: string) {
    if (!selectedCard || !canDeploy) return
    setDialog({ card: selectedCard, locId, locName })
  }

  function confirmDeploy(faceDown: boolean, bloodTokens: number) {
    if (!dialog) return
    actions.submitDeployment({
      locationId: dialog.locId,
      cardId: dialog.card.id,
      faceDown,
      bloodTokens,
    })
    const locId = dialog.locId
    setDialog(null)
    setSelectedCard(null)
    setFlashLocId(locId)
    setTimeout(() => setFlashLocId(null), 900)
  }

  function skip() {
    actions.submitDeployment({ skip: true })
    setSkipConfirm(false)
  }

  function requestDrain(ally: AllyCard) {
    // 汲取不可逆(卡翻面、終局影響力降為殘值),一律先確認
    setDrainConfirm(ally)
  }

  function confirmDrain() {
    if (!drainConfirm) return
    actions.drainAlly(drainConfirm.id)
    setDrainConfirm(null)
  }

  // 固定座位順序(playerOrder,整場不變) — 出牌區內的卡牌也依此排序
  // 不可用 Object.keys(players)：Convex 會排序 key，插入順序不保留
  const seatOrder = seatIds(gameState)
  const doneIds = new Set(seatOrder.filter(pid => !waiting.includes(pid)))

  return (
    <div className="planning">
      {/* 固定座位列:誰在出牌、輪序、每人資源 */}
      <PlayerSeats
        gameState={gameState}
        myId={myId}
        activeStatuses={
          waiting.length > 0 && gameState.currentTurnPlayerId
            ? { [gameState.currentTurnPlayerId]: '出牌中' }
            : undefined
        }
        doneIds={doneIds}
        showTurnOrder
      />

      {/* Status bar */}
      <div className="planning__bar">
        <div className="planning__bar-item">
          <span className="planning__bar-label">血液</span>
          <span className="planning__bar-val planning__bar-val--blood">{gameState.myBlood}</span>
        </div>
        <div className="planning__bar-item">
          <span className="planning__bar-label">剩餘部署</span>
          <span className="planning__bar-val">{me?.deploymentsLeft ?? 0}</span>
        </div>
        <div className="planning__bar-item">
          <span className="planning__bar-label">手牌</span>
          <span className="planning__bar-val">{hand.length} 張</span>
        </div>
        {canDeploy && (
          <button className="btn-ghost planning__skip-btn" onClick={() => setSkipConfirm(true)}>
            結束部署
          </button>
        )}
      </div>

      {alreadyDone ? (
        <div className="planning__waiting">
          <WaitingPlayers gameState={gameState} myId={myId} doneLabel="已完成部署" />
        </div>
      ) : !isMyTurn ? (
        <div className="planning__waiting">
          等待 <strong>{gameState.players[gameState.currentTurnPlayerId]?.name ?? '...'}</strong> 出牌
        </div>
      ) : selectedCard ? (
        <div className="planning__hint">選擇部署地點 ↓ （再次點擊手牌取消選擇）</div>
      ) : (
        <div className="planning__hint">你的回合！點擊手牌選擇，再選擇地點部署</div>
      )}

      {/* Board */}
      <div className="planning__board">
        {gameState.locations.map(loc => {
          const slots = gameState.deployments[loc.id] ?? []
          // 依固定座位順序排列,同一玩家的牌相鄰,歸屬一目了然
          const sortedSlots = [...slots].sort(
            (a, b) => seatOrder.indexOf(a.playerId) - seatOrder.indexOf(b.playerId)
          )
          const ally = gameState.locationAllies[loc.id]
          const clickable = !!selectedCard && canDeploy

          return (
            <div
              key={loc.id}
              className={[
                'loc-card',
                clickable             ? 'loc-card--clickable'  : '',
                clickable             ? 'loc-card--targetable' : '',
                loc.isPrinces         ? 'loc-card--princes'    : '',
                flashLocId === loc.id ? 'loc-card--flash'      : '',
              ].filter(Boolean).join(' ')}
              onClick={() => clickLocation(loc.id, loc.name)}
            >
              <div className="loc-card__image">
                <img src={locationImageSrc(loc.id) ?? ''} alt={loc.name} />
              </div>
              <div className="loc-card__header">
                <span className="loc-card__name">{loc.name}</span>
                {loc.isPrinces && <span className="loc-card__princes-badge">王子之地</span>}
              </div>

              <div className="loc-card__influence">
                <span className="loc-card__inf-val">🏆 {loc.influence[gameState.round - 1]?.[0] ?? '?'}</span>
                <span className="loc-card__inf-sep">/</span>
                <span className="loc-card__inf-val loc-card__inf-val--2nd">🥈 {loc.influence[gameState.round - 1]?.[1] ?? '?'}</span>
                <span className="loc-card__inf-label">影響力</span>
              </div>

              {ally && (
                <div
                  className="loc-card__ally"
                  onClick={e => {
                    e.stopPropagation()
                    setExpandedAllies(prev => {
                      const next = new Set(prev)
                      if (next.has(loc.id)) next.delete(loc.id)
                      else next.add(loc.id)
                      return next
                    })
                  }}
                >
                  <div className="loc-card__ally-header">
                    {allyImageSrc(ally.id) && (
                      <img className="loc-card__ally-thumb" src={allyImageSrc(ally.id)!} alt={ally.name} />
                    )}
                    <span className="loc-card__ally-type">{ally.type === 'vampire' ? '吸血鬼' : '人類'}</span>
                    <span className="loc-card__ally-name">{ally.name}</span>
                    <span className="loc-card__ally-chevron">{expandedAllies.has(loc.id) ? '▲' : '▼'}</span>
                  </div>
                  {expandedAllies.has(loc.id) && (
                    <>
                      {allyImageSrc(ally.id) && (
                        <img className="loc-card__ally-full" src={allyImageSrc(ally.id)!} alt={ally.name} />
                      )}
                      <div className="loc-card__ally-stats">
                        <span>🏛 影響力 +{ally.influence}（終局計分）</span>
                        {ally.feedBlood !== 0 && (
                          <span>🩸 每回合 {ally.feedBlood > 0 ? '+' : ''}{ally.feedBlood} 血{ally.feedBlood < 0 && '（維持成本）'}</span>
                        )}
                        {ally.drainBlood > 0 && (
                          <span>⚡ 汲取：+{ally.drainBlood} 血（影響力 {ally.influence}→{ally.drainInfluence}）</span>
                        )}
                      </div>
                      {ally.effect_zh && <div className="loc-card__ally-effect">{ally.effect_zh}</div>}
                    </>
                  )}
                </div>
              )}

              <div className="loc-card__slots">
                {sortedSlots.map((sl, i) => {
                  const isMine = sl.playerId === myId
                  const owner = gameState.players[sl.playerId]
                  const ownerClan = (owner?.clan ?? null) as ClanId | null
                  const clanInfo = clanOf(ownerClan)
                  // 自己的牌(含暗牌)都可查看;對手的只有亮牌可看
                  const canPeek = isMine ? !!sl.cardId : (!sl.faceDown && !!sl.cardId)
                  const showTokens = sl.bloodTokens > 0 && (isMine || !sl.bloodTokensHidden)
                  return (
                    <div
                      key={i}
                      className={`loc-slot ${isMine ? 'loc-slot--mine' : 'loc-slot--other'} ${canPeek ? 'loc-slot--peekable' : ''}`}
                      style={clanInfo ? { '--slot-clan': clanInfo.color } as React.CSSProperties : undefined}
                      title={isMine && sl.faceDown && canPeek ? '暗牌（點擊查看）' : undefined}
                      onClick={e => {
                        e.stopPropagation()
                        if (canPeek) setSlotPopup({ cardId: sl.cardId!, ownerName: owner?.name ?? (isMine ? '我' : '對手') })
                      }}
                    >
                      <CardImage cardId={sl.cardId ?? null} clan={ownerClan} faceDown={isMine ? sl.faceDown : (sl.faceDown || !sl.cardId)} className="loc-slot__img" />
                      <span className="loc-slot__owner">{isMine ? '你' : (owner?.name ?? '?')}</span>
                      {showTokens && <span className="loc-slot__tokens">+{sl.bloodTokens}💧</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Hand */}
      {!alreadyDone && hand.length > 0 && (
        <section className="planning__hand-section">
          <div className="planning__section-title">手牌</div>
          <div className="planning__hand">
            {hand.map(card => (
              <button
                key={card.id}
                className={`card-tile ${canDeploy ? 'card-tile--pickable' : 'card-tile--waiting'} ${selectedCard?.id === card.id ? 'card-tile--selected' : ''}`}
                onClick={() => canDeploy && selectCard(card)}
                disabled={!canDeploy}
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
            ))}
          </div>
        </section>
      )}

      {/* Alliance */}
      {alliance.length > 0 && (
        <section className="planning__hand-section">
          <div className="planning__section-title">同盟牌</div>
          <div className="planning__hand">
            {alliance.map(ally => (
              <div key={ally.id} className={`ally-tile ${ally.drained ? 'ally-tile--drained' : ''}`}>
                {allyImageSrc(ally.id) && (
                  <img className="ally-tile__img" src={allyImageSrc(ally.id)!} alt={ally.name} />
                )}
                <div className="ally-tile__type">{ally.type === 'vampire' ? '吸血鬼' : '人類'}</div>
                <div className="ally-tile__name">{ally.name}</div>
                <div className="ally-tile__stats">
                  {ally.drained ? (
                    <span>🏛 影響力 +{ally.drainInfluence}（已汲取翻面，終局計分）</span>
                  ) : (
                    <>
                      <span>🏛 影響力 +{ally.influence}（終局計分）</span>
                      {ally.feedBlood !== 0 && (
                        <span>🩸 每回合 {ally.feedBlood > 0 ? '+' : ''}{ally.feedBlood} 血{ally.feedBlood < 0 && '（維持成本）'}</span>
                      )}
                      {ally.drainBlood > 0 && (
                        <span>⚡ 汲取：+{ally.drainBlood} 血（影響力 {ally.influence}→{ally.drainInfluence}）</span>
                      )}
                    </>
                  )}
                </div>
                {ally.effect_zh && <div className="ally-tile__effect">{ally.effect_zh}</div>}
                {!ally.drained && !alreadyDone && (
                  <button
                    className={`btn-ghost ally-tile__drain-btn ${ally.type === 'vampire' ? 'ally-tile__drain-btn--vampire' : ''}`}
                    onClick={() => requestDrain(ally)}
                  >
                    {ally.type === 'vampire' ? '⚠ 汲取' : '汲取'}
                  </button>
                )}
                {ally.drained && <div className="ally-tile__drained-label">已汲取</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {slotPopup && (() => {
        const def = CARD_DEFS[slotPopup.cardId]
        return (
          <div className="slot-popup-overlay" onClick={() => setSlotPopup(null)}>
            <div className="slot-popup" onClick={e => e.stopPropagation()}>
              <div className="slot-popup__owner">{slotPopup.ownerName} 的牌</div>
              <CardImage cardId={slotPopup.cardId} className="slot-popup__img" />
              {def ? (
                <div className="slot-popup__info">
                  <div className="slot-popup__type">{TYPE_LABEL_ZH[def.type] ?? def.type}</div>
                  <div className="slot-popup__name">{def.name_zh}</div>
                  <div className="slot-popup__power">戰力 {def.power}</div>
                  {def.effect_zh && <div className="slot-popup__effect">{def.effect_zh}</div>}
                </div>
              ) : (
                <div className="slot-popup__info">
                  <div className="slot-popup__name">{slotPopup.cardId}</div>
                </div>
              )}
              <button className="btn-ghost slot-popup__close" onClick={() => setSlotPopup(null)}>關閉</button>
            </div>
          </div>
        )
      })()}

      {skipConfirm && (
        <div className="skip-confirm-overlay" onClick={() => setSkipConfirm(false)}>
          <div className="skip-confirm" onClick={e => e.stopPropagation()}>
            <div className="skip-confirm__title">確認結束部署？</div>
            <div className="skip-confirm__body">
              {hand.length > 0
                ? `你還有 ${hand.length} 張手牌未部署，結束後本回合不能再出牌。`
                : '確認結束本回合部署？'}
            </div>
            <div className="skip-confirm__actions">
              <button className="btn-primary" onClick={skip}>確認結束</button>
              <button className="btn-ghost" onClick={() => setSkipConfirm(false)}>繼續部署</button>
            </div>
          </div>
        </div>
      )}

      {drainConfirm && (() => {
        const isVampire = drainConfirm.type === 'vampire'
        const currentDiablerie = me?.diablerie ?? 0
        const afterDiablerie = currentDiablerie + 1
        const willEliminate = isVampire && afterDiablerie >= 3
        return (
          <div className="drain-confirm-overlay" onClick={() => setDrainConfirm(null)}>
            <div className="drain-confirm" onClick={e => e.stopPropagation()}>
              <div className="drain-confirm__title">
                {isVampire ? '⚠ 汲取吸血鬼' : '汲取同盟'}
              </div>
              {allyImageSrc(drainConfirm.id) && (
                <img className="drain-confirm__img" src={allyImageSrc(drainConfirm.id)!} alt={drainConfirm.name} />
              )}
              <div className="drain-confirm__card">{drainConfirm.name}</div>
              <div className="drain-confirm__body">
                <div className="drain-confirm__row">
                  汲取獲得：
                  <span className="drain-confirm__gain drain-confirm__gain--blood">+{drainConfirm.drainBlood} 血</span>
                </div>
                <div className="drain-confirm__row">
                  終局影響力：
                  <span className="drain-confirm__gain drain-confirm__gain--inf">{drainConfirm.influence} → {drainConfirm.drainInfluence}</span>
                </div>
                {isVampire && (
                  <div className={`drain-confirm__penalty ${willEliminate ? 'drain-confirm__penalty--fatal' : ''}`}>
                    弒親代幣：{currentDiablerie} → <strong>{afterDiablerie}</strong> / 3
                    {willEliminate
                      ? ' 💀 第 3 枚！你將被淘汰出局！'
                      : afterDiablerie === 2
                        ? ' ⚠ 再一枚即被淘汰'
                        : ''}
                  </div>
                )}
                <div className="drain-confirm__note">
                  汲取後此牌翻面，終局計分時只算殘餘影響力，無法復原。
                </div>
              </div>
              <div className="drain-confirm__actions">
                <button
                  className={`btn-primary ${willEliminate ? 'drain-confirm__fatal-btn' : ''}`}
                  onClick={confirmDrain}
                >
                  {willEliminate ? '確認（我知道會出局）' : '確認汲取'}
                </button>
                <button className="btn-ghost" onClick={() => setDrainConfirm(null)}>取消</button>
              </div>
            </div>
          </div>
        )
      })()}

      {dialog && (
        <DeployDialog
          card={dialog.card}
          locId={dialog.locId}
          locName={dialog.locName}
          myBlood={gameState.myBlood}
          isMine={me?.clan === 'nosferatu'}
          onConfirm={confirmDeploy}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  )
}
