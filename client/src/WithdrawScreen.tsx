import { useState } from 'react'
import type { GameStateClient, ClanId } from '@kindred/shared'
import { useGameActions } from './convexGame'
import CardImage from './CardImage'
import { CARD_DEFS, TYPE_LABEL_ZH } from './cardDefs'
import { cardName } from './cardNames'
import PlayerSeats from './PlayerSeats'
import LocationStrip from './LocationStrip'
import './WithdrawScreen.css'

interface Props {
  myId: string
  gameState: GameStateClient
}

export default function WithdrawScreen({ myId, gameState }: Props) {
  const actions = useGameActions()
  const me = gameState.players[myId]
  const waiting = gameState.waitingFor
  const alreadySubmitted = !waiting.includes(myId)

  const locIndex = gameState.currentLocIndex
  const currentLoc = gameState.locations[locIndex] ?? null

  // Total locations that have any deployments (for progress display)
  const totalActiveLocs = gameState.locations.filter(loc =>
    (gameState.deployments[loc.id] ?? []).length > 0
  ).length

  // How many have we already finished (index-based: all with index < locIndex that have deployments)
  const finishedCount = gameState.locations.slice(0, locIndex).filter(loc =>
    (gameState.deployments[loc.id] ?? []).length > 0
  ).length

  const iHaveDeployment = currentLoc
    ? (gameState.deployments[currentLoc.id] ?? []).some(sl => sl.playerId === myId && !sl.withdrawn)
    : false

  const [choice, setChoice] = useState<boolean | null>(null)
  const [popup, setPopup] = useState<{ cardId: string } | null>(null)

  function submit() {
    if (!currentLoc || choice === null) return
    actions.submitWithdraw({ locationId: currentLoc.id, withdraw: choice })
  }

  if (!currentLoc) {
    return (
      <div className="withdraw">
        <div className="withdraw__header">
          <div className="withdraw__title">撤退階段</div>
          <div className="withdraw__status">載入中…</div>
        </div>
      </div>
    )
  }

  const slots = gameState.deployments[currentLoc.id] ?? []
  const mySlots = slots.filter(sl => sl.playerId === myId)
  const otherSlots = slots.filter(sl => sl.playerId !== myId)

  const seatStatuses = Object.fromEntries(waiting.map(id => [id, '決策中']))
  const doneIds = new Set(Object.keys(gameState.players).filter(id => !waiting.includes(id)))

  return (
    <div className="withdraw">

      {/* 固定座位列 + 常駐戰場地圖:誰在決策、結算進度 */}
      <PlayerSeats
        gameState={gameState}
        myId={myId}
        activeStatuses={seatStatuses}
        doneIds={doneIds}
      />
      <LocationStrip gameState={gameState} myId={myId} currentLocId={currentLoc.id} />

      {/* 卡牌效果 popup */}
      {popup && (() => {
        const def = CARD_DEFS[popup.cardId]
        return (
          <div className="wd-popup-overlay" onClick={() => setPopup(null)}>
            <div className="wd-popup" onClick={e => e.stopPropagation()}>
              <CardImage cardId={popup.cardId} className="wd-popup__img" />
              {def && (
                <div className="wd-popup__info">
                  <div className="wd-popup__type">{TYPE_LABEL_ZH[def.type] ?? def.type}</div>
                  <div className="wd-popup__name">{def.name_zh}</div>
                  <div className="wd-popup__power">基礎戰力 {def.power}</div>
                  {def.effect_zh && <div className="wd-popup__effect">{def.effect_zh}</div>}
                </div>
              )}
              <button className="btn-ghost wd-popup__close" onClick={() => setPopup(null)}>關閉</button>
            </div>
          </div>
        )
      })()}

      {/* 標題 + 狀態列 */}
      <div className="withdraw__header">
        <div className="withdraw__title">撤退階段</div>
        <div className="withdraw__subtitle">
          選擇是否從此地點撤退。
          <span className="withdraw__rule">留守</span>：繼續參與本地點結算，但血液代幣無法取回。
          <span className="withdraw__rule">撤退</span>：取回所有部署血液代幣，
          {currentLoc.isPrinces
            ? '牌也一併取回，直接跳出不參與結算。'
            : '牌翻成正面移至「王子的避難所」繼續使用（下回合可在王子之地參與競爭）。'}
        </div>
        <div className="withdraw__progress">地點 {finishedCount + 1} / {totalActiveLocs}</div>
        {waiting.length === 0 ? (
          <div className="withdraw__status withdraw__status--reveal">
            ✦ 所有人已決定，撤退結果揭曉中…
          </div>
        ) : alreadySubmitted ? (
          <div className="withdraw__status withdraw__status--done">
            ✓ 已提交，等待：{waiting.map(id => gameState.players[id]?.name ?? id).join('、')}
          </div>
        ) : !iHaveDeployment ? (
          <div className="withdraw__status withdraw__status--done">
            你在此地點無部署，自動通過。等待：{waiting.map(id => gameState.players[id]?.name ?? id).join('、')}
          </div>
        ) : (
          <div className="withdraw__status">
            請選擇是否從此地點撤退
          </div>
        )}
      </div>

      {/* 當前地點 */}
      <div className={[
        'wd-loc',
        iHaveDeployment ? 'wd-loc--mine' : '',
        iHaveDeployment && choice === false ? 'wd-loc--stay' : '',
        iHaveDeployment && choice === true  ? 'wd-loc--out'  : '',
      ].filter(Boolean).join(' ')}>

        {/* 地點標題 */}
        <div className="wd-loc__header">
          <span className="wd-loc__name">{currentLoc.name}</span>
          {currentLoc.isPrinces && <span className="wd-loc__princes">王子之地</span>}
          <span className="wd-loc__influence">
            {currentLoc.influence[gameState.round - 1]?.[0] ?? '?'} / {currentLoc.influence[gameState.round - 1]?.[1] ?? '?'} 影
          </span>
        </div>

        {/* 部署槽 */}
        <div className="wd-loc__slots">
          {/* 我的槽 */}
          {mySlots.map((sl, i) => {
            const clan = me?.clan as ClanId | null
            const canPeek = !!sl.cardId
            return (
              <div
                key={`mine-${i}`}
                className={`wd-slot wd-slot--mine ${canPeek ? 'wd-slot--peekable' : ''} ${sl.withdrawn ? 'wd-slot--withdrawn' : ''}`}
                onClick={() => canPeek && !sl.withdrawn && setPopup({ cardId: sl.cardId! })}
                title={canPeek && !sl.withdrawn ? (sl.faceDown ? '暗牌（點擊查看）' : '點擊查看效果') : undefined}
              >
                <CardImage cardId={sl.cardId} clan={clan} faceDown={sl.faceDown} className="wd-slot__img" />
                <div className="wd-slot__info">
                  <span className="wd-slot__label">我</span>
                  <span className="wd-slot__name">
                    {sl.faceDown ? `${cardName(sl.cardId!)}（暗）` : (sl.cardId ? cardName(sl.cardId) : '?')}
                  </span>
                  {sl.withdrawn
                    ? <span className="wd-slot__wd-badge">撤退</span>
                    : sl.bloodTokens > 0 && <span className="wd-slot__tokens">💧{sl.bloodTokens}</span>
                  }
                </div>
              </div>
            )
          })}

          {/* 對手槽 */}
          {otherSlots.map((sl, i) => {
            const owner = gameState.players[sl.playerId]
            const ownerClan = owner?.clan as ClanId | null
            const isHidden = sl.faceDown || !sl.cardId
            const canPeek = !isHidden && !!sl.cardId
            return (
              <div
                key={`other-${i}`}
                className={`wd-slot wd-slot--other ${canPeek && !sl.withdrawn ? 'wd-slot--peekable' : ''} ${sl.withdrawn ? 'wd-slot--withdrawn' : ''}`}
                onClick={() => canPeek && !sl.withdrawn && setPopup({ cardId: sl.cardId! })}
                title={canPeek && !sl.withdrawn ? '點擊查看效果' : undefined}
              >
                <CardImage cardId={sl.cardId} clan={ownerClan} faceDown={isHidden} className="wd-slot__img" />
                <div className="wd-slot__info">
                  <span className="wd-slot__label">{owner?.name ?? '?'}</span>
                  <span className="wd-slot__name">
                    {isHidden ? '???' : (sl.cardId ? cardName(sl.cardId) : '?')}
                  </span>
                  {sl.withdrawn
                    ? <span className="wd-slot__wd-badge">撤退</span>
                    : sl.bloodTokens > 0 && !sl.bloodTokensHidden && (
                      <span className="wd-slot__tokens">💧{sl.bloodTokens}</span>
                    )
                  }
                </div>
              </div>
            )
          })}
        </div>

        {/* 決策按鈕（只在我有部署且尚未提交時顯示） */}
        {iHaveDeployment && !alreadySubmitted && (
          <div className="wd-loc__btns">
            <button
              className={`wd-btn ${choice === false ? 'wd-btn--stay' : ''}`}
              onClick={() => setChoice(false)}
            >
              <span className="wd-btn__label">留守</span>
              <span className="wd-btn__sub">繼續參與結算</span>
            </button>
            <button
              className={`wd-btn ${choice === true ? 'wd-btn--out' : ''}`}
              onClick={() => setChoice(true)}
            >
              <span className="wd-btn__label">撤退</span>
              <span className="wd-btn__sub">
                {(() => {
                  const tokens = mySlots.reduce((s, sl) => s + sl.bloodTokens, 0)
                  if (currentLoc.isPrinces) {
                    return tokens > 0 ? `取回 ${tokens} 血液 + 牌` : '取回牌與血液'
                  }
                  return tokens > 0 ? `取回 ${tokens} 血液，牌移至王子之地` : '取回血液，牌移至王子之地'
                })()}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* 確認按鈕 */}
      {!alreadySubmitted && iHaveDeployment && (
        <button className="btn-primary withdraw__submit" onClick={submit} disabled={choice === null}>
          確認撤退決定
        </button>
      )}
    </div>
  )
}
