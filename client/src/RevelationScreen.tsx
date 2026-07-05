import { useState, useMemo } from 'react'
import type { ActiveEffect, GameStateClient, ConflictResult, ClanId, StepEvent } from '@kindred/shared'
import { useGameActions } from './convexGame'
import { seatIds } from './playerOrder'
import { cardName } from './cardNames'
import CardImage from './CardImage'
import { CARD_DEFS, TYPE_LABEL_ZH } from './cardDefs'
import { clanOf } from './clans'
import WaitingPlayers from './WaitingPlayers'
import PlayerSeats from './PlayerSeats'
import LocationStrip from './LocationStrip'
import './RevelationScreen.css'

interface Props {
  myId: string
  gameState: GameStateClient
}

const STEPS = ['withdraw', 'reveal', 'prepare', 'conflict', 'aftermath', 'complete'] as const
type ResolutionStep = typeof STEPS[number]

const STEP_LABELS: Record<ResolutionStep, string> = {
  withdraw: '撤退',
  reveal:   '揭牌',
  prepare:  '準備',
  conflict: '衝突',
  aftermath:'後果',
  complete: '完成',
}

const STEP_ACTIVE_TYPE: Partial<Record<ResolutionStep, string>> = {
  prepare:  'preparation',
  conflict: 'conflict',
  aftermath:'aftermath',
}

const STEP_DESCRIPTIONS: Record<ResolutionStep, string> = {
  withdraw: '玩家選擇是否撤退',
  reveal:   '所有面朝下的牌同時翻開',
  prepare:  '準備型卡牌依序觸發效果',
  conflict: '計算各地點戰力，決定勝負',
  aftermath:'後果型卡牌依序觸發效果',
  complete: '分配影響力，結算本地點',
}

function eventClass(ev: StepEvent): string {
  const text = ev.text
  if (ev.delta?.influence !== undefined)                return 'event--influence'
  if (ev.delta?.power !== undefined)                    return 'event--power'
  if (ev.delta?.blood !== undefined)                    return 'event--blood'
  if (/血液|💧|失去.*血|血.*失去|吸取|流失/.test(text)) return 'event--blood'
  if (/影響力|獲得.*影|影\b/.test(text))               return 'event--influence'
  if (/撤退/.test(text))                               return 'event--withdraw'
  if (/戰力|⚔/.test(text))                            return 'event--power'
  return ''
}

function DeltaBadge({ delta }: { delta: StepEvent['delta'] }) {
  if (!delta) return null
  const parts: { label: string; val: number; cls: string }[] = []
  if (delta.blood     !== undefined) parts.push({ label: '血', val: delta.blood,     cls: 'delta--blood' })
  if (delta.influence !== undefined) parts.push({ label: '影', val: delta.influence, cls: 'delta--influence' })
  if (delta.power     !== undefined) parts.push({ label: '力', val: delta.power,     cls: 'delta--power' })
  return (
    <>
      {parts.map(p => (
        <span key={p.label} className={`event-delta ${p.cls}`}>
          {p.val > 0 ? '+' : ''}{p.val}{p.label}
        </span>
      ))}
    </>
  )
}

function StepEventRow({ ev: stepEv, className }: { ev: StepEvent; className?: string }) {
  const cardDef = stepEv.sourceCardId ? CARD_DEFS[stepEv.sourceCardId] : null
  return (
    <div className={`step-event-row ${eventClass(stepEv)} ${className ?? ''}`}>
      {cardDef && (
        <span className="step-event-row__card-badge" title={cardDef.name_zh}>
          <CardImage cardId={stepEv.sourceCardId!} className="step-event-row__card-img" />
          <span className="step-event-row__card-name">{cardDef.name_zh}</span>
        </span>
      )}
      <span className="step-event-row__text">▸ {stepEv.text}</span>
      <DeltaBadge delta={stepEv.delta} />
    </div>
  )
}

type SlotPopup = { cardId: string; ownerName: string }

const SYNC_STEP_LABEL: Record<ActiveEffect['step'], string> = {
  reveal: '揭牌',
  prepare: '準備效果',
  conflict: '衝突效果',
  aftermath: '餘波效果',
  complete: '地點結算',
}

function ActiveEffectPanel({ effect, gameState }: { effect: ActiveEffect | null; gameState: GameStateClient }) {
  const loc = effect ? gameState.locations.find(l => l.id === effect.locationId) : null
  const cardDef = effect?.sourceCardId ? CARD_DEFS[effect.sourceCardId] : null

  if (!effect) {
    return (
      <div className="active-effect active-effect--idle">
        <div className="active-effect__kicker">同步結算</div>
        <div className="active-effect__title">等待下一個效果</div>
        <div className="active-effect__text">所有玩家會在這裡看到同一個正在處理的卡牌效果。</div>
      </div>
    )
  }

  const progress = Math.round(((effect.eventIndex + 1) / Math.max(effect.eventCount, 1)) * 100)

  return (
    <div className={`active-effect active-effect--${effect.step}`}>
      <div className="active-effect__media">
        {cardDef ? (
          <CardImage cardId={effect.sourceCardId} className="active-effect__card-img" />
        ) : (
          <div className="active-effect__card-placeholder">{SYNC_STEP_LABEL[effect.step]}</div>
        )}
      </div>
      <div className="active-effect__body">
        <div className="active-effect__meta">
          <span>{loc?.name ?? effect.locationId}</span>
          <span>{SYNC_STEP_LABEL[effect.step]}</span>
          <span>{effect.eventIndex + 1}/{effect.eventCount}</span>
        </div>
        <div className="active-effect__title">
          {cardDef ? cardDef.name_zh : SYNC_STEP_LABEL[effect.step]}
        </div>
        <div className="active-effect__text">{effect.text}</div>
        <div className="active-effect__actors">
          {effect.sourcePlayerName && <span>來源：{effect.sourcePlayerName}</span>}
          {effect.targetPlayerName && <span>目標：{effect.targetPlayerName}</span>}
          {effect.delta?.blood !== undefined && <span className="active-effect__delta active-effect__delta--blood">{effect.delta.blood > 0 ? '+' : ''}{effect.delta.blood} 血</span>}
          {effect.delta?.influence !== undefined && <span className="active-effect__delta active-effect__delta--influence">{effect.delta.influence > 0 ? '+' : ''}{effect.delta.influence} 影響力</span>}
          {effect.delta?.power !== undefined && <span className="active-effect__delta active-effect__delta--power">{effect.delta.power > 0 ? '+' : ''}{effect.delta.power} 戰力</span>}
        </div>
        <div className="active-effect__progress">
          <div className="active-effect__progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  )
}

// ── 回合結束摘要:每地點一行 + 積分排行,詳情點擊展開 ─────────────
function RoundSummary({ results, gameState, myId, onSlotClick }: {
  results: ConflictResult[]
  gameState: GameStateClient
  myId: string
  onSlotClick: (p: SlotPopup) => void
}) {
  const [expandedLoc, setExpandedLoc] = useState<string | null>(null)
  const ranked = Object.values(gameState.players).sort((a, b) => b.influence - a.influence)

  return (
    <div className="round-summary">
      {/* 各地點一行結果 */}
      <div className="round-summary__section-title">本回合戰果</div>
      <div className="round-summary__locs">
        {results.map(r => {
          const loc = gameState.locations.find(l => l.id === r.locationId)
          const winner = r.winner ? gameState.players[r.winner] : null
          const infGain = r.winner ? (r.influenceGained[r.winner] ?? 0) : 0
          const isOpen = expandedLoc === r.locationId
          return (
            <div key={r.locationId} className="round-summary__loc-block">
              <button
                className={`round-summary__loc-row ${r.winner === myId ? 'round-summary__loc-row--me' : ''}`}
                onClick={() => setExpandedLoc(isOpen ? null : r.locationId)}
              >
                <span className="round-summary__loc-name">{loc?.name ?? r.locationId}</span>
                {r.tie ? (
                  <span className="round-summary__tie">平手，無人得分</span>
                ) : winner ? (
                  <span className="round-summary__winner">
                    {r.winner === myId ? '🏆 你勝出' : `🏆 ${winner.name} 勝出`}
                    {infGain > 0 && <span className="round-summary__inf">+{infGain} 影響力</span>}
                  </span>
                ) : (
                  <span className="round-summary__tie">無人參與</span>
                )}
                <span className="round-summary__expand">{isOpen ? '收合 ▲' : '詳情 ▼'}</span>
              </button>
              {isOpen && (
                <ResultCard result={r} gameState={gameState} myId={myId}
                  showStep="complete" onSlotClick={onSlotClick} />
              )}
            </div>
          )
        })}
      </div>

      {/* 積分排行 */}
      <div className="round-summary__section-title">目前積分</div>
      <div className="round-summary__standings">
        {ranked.map((p, i) => {
          const clanInfo = clanOf(p.clan)
          return (
            <div key={p.id} className={`round-summary__standing ${p.id === myId ? 'round-summary__standing--me' : ''}`}>
              <span className="round-summary__rank">#{i + 1}</span>
              {clanInfo && <span className="round-summary__clan" style={{ color: clanInfo.color }}>{clanInfo.zh}</span>}
              <span className="round-summary__pname">{p.name}{p.id === myId && '（你）'}</span>
              <span className="round-summary__pinf">{p.influence} 影</span>
              <span className="round-summary__pblood">{p.blood} 血</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Result Card ───────────────────────────────────────────────────
function ResultCard({ result, gameState, myId, showStep, onSlotClick }: {
  result: ConflictResult
  gameState: GameStateClient
  myId: string
  showStep: ResolutionStep
  onSlotClick: (p: SlotPopup) => void
}) {
  const loc = gameState.locations.find(l => l.id === result.locationId)
  const slots = gameState.deployments[result.locationId] ?? []
  const sortedPlayers = Object.entries(result.scores).sort((a, b) => b[1] - a[1])
  const activeType = STEP_ACTIVE_TYPE[showStep] ?? null

  // 依固定座位順序將卡牌分組,每組掛擁有者名牌 — 一眼看出「這張牌是誰出的」
  // 不可用 Object.keys(players)：Convex 會排序 key，插入順序不保留
  const seatOrder = seatIds(gameState)
  const slotGroups = seatOrder
    .map(pid => ({ pid, groupSlots: slots.filter(sl => sl.playerId === pid) }))
    .filter(g => g.groupSlots.length > 0)

  const stepEvents: StepEvent[] =
    showStep === 'prepare'   ? (result.stepEvents?.prepare   ?? []) :
    showStep === 'conflict'  ? (result.stepEvents?.conflict  ?? []) :
    showStep === 'aftermath' ? (result.stepEvents?.aftermath ?? []) :
    showStep === 'complete'  ? [
      ...(result.stepEvents?.prepare   ?? []),
      ...(result.stepEvents?.conflict  ?? []),
      ...(result.stepEvents?.aftermath ?? []),
    ] : []

  const showPower  = showStep !== 'withdraw' && showStep !== 'reveal' && showStep !== 'prepare'
  const showScores = showStep === 'conflict' || showStep === 'aftermath' || showStep === 'complete'

  return (
    <div className={[
      'result-card',
      result.winner === myId ? 'result-card--winner' : '',
      showStep === 'complete' ? 'result-card--complete' : '',
    ].filter(Boolean).join(' ')}>

      {/* 地點標題 */}
      <div className="result-card__loc">
        {loc?.name ?? result.locationId}
        {loc?.isPrinces && <span className="result-card__princes">王子之地</span>}
        <span className={`result-card__step result-card__step--${showStep}`}>{STEP_LABELS[showStep]}</span>
      </div>

      {/* Complete 勝負 banner */}
      {showStep === 'complete' && (
        result.tie
          ? <div className="result-card__outcome result-card__outcome--tie">平局 — 無人得分</div>
          : result.winner && (
            <div className={`result-card__outcome ${result.winner === myId ? 'result-card__outcome--me' : ''}`}>
              <span className="result-card__outcome-name">
                {result.winner === myId ? '🏆 你勝出！' : `${gameState.players[result.winner]?.name ?? '?'} 勝出`}
              </span>
              {(result.influenceGained[result.winner] ?? 0) > 0 && (
                <span className="result-card__outcome-inf">+{result.influenceGained[result.winner]} 影響力</span>
              )}
            </div>
          )
      )}

      {/* 部署牌列表:依固定座位順序分組,組頭掛擁有者名牌 */}
      <div className="result-card__slots">
        {slotGroups.map(({ pid, groupSlots }) => {
          const owner = gameState.players[pid]
          const clan  = owner?.clan as ClanId | null
          const clanInfo = clanOf(clan)
          return (
        <div key={pid}
          className={`result-group ${pid === myId ? 'result-group--mine' : ''}`}
          style={clanInfo ? { '--group-clan': clanInfo.color } as React.CSSProperties : undefined}
        >
          <div className="result-group__owner">
            {clanInfo && <span className="result-group__clan">{clanInfo.zh}</span>}
            <span className="result-group__name">{owner?.name ?? '?'}{pid === myId && '（你）'}</span>
          </div>
        {groupSlots.map((sl, i) => {
          const isFaceDown = sl.faceDown && showStep === 'withdraw'
          const cardDef  = sl.cardId ? CARD_DEFS[sl.cardId] : null
          const cardType = cardDef?.type ?? null
          const isActive = !sl.withdrawn && !isFaceDown && !!activeType && cardType === activeType
          const isDim    = !sl.withdrawn && !isFaceDown && !!activeType && cardType !== activeType
          const basePow  = cardDef?.power ?? 0
          const eff      = sl.effectivePower ?? 0
          const isModified = showPower && sl.effectivePower !== null && eff !== basePow + sl.bloodTokens
          const effectText = !isFaceDown && sl.cardId ? (cardDef?.effect_zh ?? '') : ''
          const clickable  = !isFaceDown && !!sl.cardId
          const activeEffect = gameState.activeEffect
          const isCurrentEffect = !!activeEffect?.sourceCardId &&
            activeEffect.locationId === result.locationId &&
            activeEffect.sourceCardId === sl.cardId &&
            activeEffect.sourcePlayerName === owner?.name

          return (
            <div key={i}
              className={[
                'result-slot',
                sl.playerId === myId ? 'result-slot--mine'     : '',
                sl.withdrawn         ? 'result-slot--withdrawn' : '',
                isActive             ? 'result-slot--active'    : '',
                isDim                ? 'result-slot--dim'       : '',
                isCurrentEffect      ? 'result-slot--current-effect' : '',
                clickable            ? 'result-slot--clickable' : '',
              ].filter(Boolean).join(' ')}
              onClick={clickable ? () => onSlotClick({ cardId: sl.cardId!, ownerName: owner?.name ?? '?' }) : undefined}
            >
              <CardImage
                cardId={sl.cardId} clan={clan} faceDown={isFaceDown}
                className={`result-slot__img ${showStep === 'reveal' && !sl.withdrawn ? 'result-slot__img--flip' : ''}`}
              />

              <div className="result-slot__info">
                <div className="result-slot__card-row">
                  <span className="result-slot__card">
                    {isFaceDown ? '???' : (sl.cardId ? cardName(sl.cardId) : '—')}
                  </span>
                  {!isFaceDown && cardType && cardType !== 'passive' && (
                    <span className={`result-slot__type result-slot__type--${cardType}`}>
                      {cardType === 'preparation' ? '準備' :
                       cardType === 'conflict'    ? '衝突' :
                       cardType === 'aftermath'   ? '後果' : ''}
                    </span>
                  )}
                </div>

                {/* 效果文字：在此牌對應的步驟時展開顯示 */}
                {isActive && effectText && (
                  <div className="result-slot__effect-inline">{effectText}</div>
                )}

                <div className="result-slot__badges">
                  {sl.bloodTokens > 0 && <span className="result-slot__tokens">💧{sl.bloodTokens}</span>}
                  {sl.withdrawn && <span className="result-slot__wd">撤退</span>}

                  {/* 戰力：顯示公式 */}
                  {showPower && !sl.withdrawn && sl.effectivePower !== null && (
                    <div className="result-slot__power-wrap">
                      <span className={`result-slot__power ${isModified ? 'result-slot__power--modified' : ''}`}>
                        ⚔ {eff}
                      </span>
                      <span className="result-slot__power-formula">
                        {basePow}基礎 + {sl.bloodTokens}💧
                        {isModified && ` + 效果${eff - basePow - sl.bloodTokens >= 0 ? '+' : ''}${eff - basePow - sl.bloodTokens}`}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        </div>
          )
        })}
      </div>

      {/* 效果事件詳情只在回合結束總覽顯示;演出中由主畫面時間軸統一呈現 */}
      {showStep === 'complete' && stepEvents.length > 0 && (
        <div className="result-card__events">
          <div className="result-card__events-title">效果觸發</div>
          {stepEvents.map((stepEv, i) => (
            <StepEventRow key={i} ev={stepEv} className="result-card__event-line" />
          ))}
        </div>
      )}

      {/* 戰力排行 */}
      {showScores && sortedPlayers.length > 0 && (
        <div className="result-card__scores">
          {sortedPlayers.map(([pid, score], idx) => {
            const player  = gameState.players[pid]
            const isWinner = pid === result.winner
            const isSecond = pid === result.second
            const infGain  = result.influenceGained[pid] ?? 0
            return (
              <div key={pid} className={[
                'result-card__row',
                idx === 0    ? 'result-card__row--first' : '',
                pid === myId ? 'result-card__row--me'    : '',
              ].filter(Boolean).join(' ')}>
                <span className="result-card__rank">#{idx + 1}</span>
                <span className="result-card__pname">{player?.name ?? '?'}</span>
                <span className="result-card__score">⚔ {score}</span>
                {showStep === 'complete' && infGain > 0 && (
                  <span className="result-card__inf" title={isWinner ? '第 1 名獎勵' : '第 2 名獎勵'}>+{infGain}影</span>
                )}
                {showStep === 'complete' && infGain === 0 && (idx > 0) && (
                  <span className="result-card__inf result-card__inf--zero">+0影</span>
                )}
                {showStep === 'complete' && isWinner && <span className="result-card__medal">🏆</span>}
                {showStep === 'complete' && isSecond && !isWinner && <span className="result-card__medal">🥈</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── 全戰場部署總覽（pendingChoice 時顯示） ─────────────────────────
function BattlefieldOverview({ gameState, myId, highlightLocId, onSlotClick }: {
  gameState: GameStateClient
  myId: string
  highlightLocId: string
  onSlotClick: (p: SlotPopup) => void
}) {
  return (
    <div className="bf-overview">
      {gameState.locations.map(loc => {
        const slots = (gameState.deployments[loc.id] ?? []).filter(sl => !sl.withdrawn)
        const isHighlight = loc.id === highlightLocId
        return (
          <div key={loc.id} className={`bf-loc ${isHighlight ? 'bf-loc--highlighted' : ''}`}>
            <div className="bf-loc__header">
              <span className="bf-loc__name">{loc.name}</span>
              {loc.isPrinces && <span className="bf-loc__princes">王子之地</span>}
              <span className="bf-loc__inf">
                {loc.influence[gameState.round - 1]?.[0] ?? '?'} / {loc.influence[gameState.round - 1]?.[1] ?? '?'} 影
              </span>
            </div>
            <div className="bf-loc__slots">
              {slots.length === 0 && <span className="bf-loc__empty">無部署</span>}
              {slots.map((sl, i) => {
                const owner  = gameState.players[sl.playerId]
                const clan   = owner?.clan as ClanId | null
                const isMe   = sl.playerId === myId
                const hidden = sl.cardId === null
                const cardDef = sl.cardId ? CARD_DEFS[sl.cardId] : null
                const bfClickable = !hidden && !!sl.cardId
                return (
                  <div key={i}
                    className={`bf-slot ${isMe ? 'bf-slot--mine' : ''} ${bfClickable ? 'bf-slot--clickable' : ''}`}
                    onClick={bfClickable ? () => onSlotClick({ cardId: sl.cardId!, ownerName: owner?.name ?? '?' }) : undefined}
                  >
                    <CardImage cardId={sl.cardId} clan={clan} faceDown={hidden} className="bf-slot__img" />
                    <div className="bf-slot__info">
                      <span className="bf-slot__owner">{owner?.name ?? '?'}{isMe && ' (你)'}</span>
                      <span className="bf-slot__card">{hidden ? '???' : (sl.cardId ? cardName(sl.cardId) : '—')}</span>
                      {!hidden && cardDef && cardDef.type !== 'passive' && (
                        <span className={`bf-slot__type bf-slot__type--${cardDef.type}`}>
                          {cardDef.type === 'preparation' ? '準備' :
                           cardDef.type === 'conflict'    ? '衝突' :
                           cardDef.type === 'aftermath'   ? '後果' : ''}
                        </span>
                      )}
                      {sl.bloodTokens > 0 && <span className="bf-slot__tokens">💧{sl.bloodTokens}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────
export default function RevelationScreen({ myId, gameState }: Props) {
  const actions       = useGameActions()
  const results       = gameState.lastConflictResults
  const phase         = gameState.phase
  const waiting       = gameState.waitingFor
  const iHaveConfirmed = !waiting.includes(myId)
  const pendingChoice      = gameState.myPendingChoice
  const hasPendingChoices  = gameState.hasPendingChoices

  // 目前效果來源玩家(座位高亮用;ActiveEffect 只帶名字,反查 id)
  const activeSourceId = gameState.activeEffect?.sourcePlayerName
    ? Object.values(gameState.players).find(p => p.name === gameState.activeEffect!.sourcePlayerName)?.id ?? null
    : null
  // 等待確認時,顯示各玩家確認進度
  const confirmDoneIds = waiting.length > 0
    ? new Set(Object.keys(gameState.players).filter(pid => !waiting.includes(pid)))
    : undefined

  // 目前效果的目標玩家(座位紅色脈衝)
  const targetPlayerId = gameState.activeEffect?.targetPlayerName
    ? Object.values(gameState.players).find(p => p.name === gameState.activeEffect!.targetPlayerName)?.id ?? null
    : null

  // 座位狀態章:正在選擇的玩家 / 效果來源(舊版 server 狀態可能缺欄位,防禦處理)
  const activeChoosers = gameState.activeChoosers ?? []
  const skipVotes = gameState.skipVotes ?? []
  const seatStatuses: Record<string, string> = {}
  activeChoosers.forEach(c => { seatStatuses[c.playerId] = '選擇中…' })
  if (activeSourceId) seatStatuses[activeSourceId] = '效果結算中'

  const [slotPopup,   setSlotPopup]   = useState<SlotPopup | null>(null)

  // 當前地點(最新結果;已完成地點由 LocationStrip 呈現)
  const currentResult = results.length > 0 ? results[results.length - 1] : null
  const currentLocId = currentResult?.locationId ?? gameState.activeEffect?.locationId
    ?? gameState.locations[gameState.currentLocIndex]?.id ?? null

  // ── 節奏單一真相:步驟完全由 server 的 activeEffect 驅動 ──
  // 有 activeEffect → 演出中,步驟 = 它的 step;
  // 沒有 → 已有結果就是 complete(等確認),還沒有結果就是 reveal(揭牌/等選擇)。
  const currentStep: ResolutionStep = gameState.activeEffect?.step
    ?? (currentResult && currentResult.locationId === currentLocId ? 'complete' : 'reveal')
  const stepIdx = STEPS.indexOf(currentStep)

  // 地點進度
  const totalActiveLocs = gameState.locations.filter(loc =>
    (gameState.deployments[loc.id] ?? []).some(sl => !sl.withdrawn)
  ).length
  const currentLocName = currentLocId
    ? (gameState.locations.find(l => l.id === currentLocId)?.name ?? '')
    : ''

  // 已發生事件時間軸:與 server 播放順序一致(準備→衝突→後果),
  // 演出中只顯示已播過的部分,演出結束顯示全部。
  const playedEvents = useMemo(() => {
    if (!currentResult) return []
    const timeline: Array<{ step: ResolutionStep; ev: StepEvent }> = [
      ...(currentResult.stepEvents?.prepare   ?? []).map(ev => ({ step: 'prepare'   as const, ev })),
      ...(currentResult.stepEvents?.conflict  ?? []).map(ev => ({ step: 'conflict'  as const, ev })),
      ...(currentResult.stepEvents?.aftermath ?? []).map(ev => ({ step: 'aftermath' as const, ev })),
    ]
    const eff = gameState.activeEffect
    const isPlayback = eff && eff.step !== 'reveal' && eff.locationId === currentResult.locationId
    return isPlayback ? timeline.slice(0, eff.eventIndex) : timeline
  }, [currentResult, gameState.activeEffect])

  // 演出加速投票
  const isPlayingEffects = phase === 'REVELATION' && !!gameState.activeEffect && gameState.activeEffect.step !== 'reveal'
  const iVotedSkip = skipVotes.includes(myId)
  const totalPlayers = Object.keys(gameState.players).length

  function confirm()  { actions.readyAdvance() }
  function voteSkip() { actions.skipEffects() }
  function respondChoice(option: string) {
    if (!pendingChoice) return
    actions.respondChoice({ choiceId: pendingChoice.id, option })
  }

  const isReveal   = phase === 'REVELATION'
  const isRoundEnd = phase === 'ROUND_END'
  const pendingChoiceLocId = pendingChoice?.context.locationId
    ?? gameState.activeEffect?.locationId
    ?? gameState.locations[gameState.currentLocIndex]?.id

  return (
    <div className={`revelation ${pendingChoice ? 'revelation--has-choice' : ''}`}>

      {/* 卡牌詳情 Popup */}
      {slotPopup && (() => {
        const def = CARD_DEFS[slotPopup.cardId]
        return (
          <div className="card-popup-overlay" onClick={() => setSlotPopup(null)}>
            <div className="card-popup" onClick={e => e.stopPropagation()}>
              <div className="card-popup__owner">{slotPopup.ownerName} 的牌</div>
              <CardImage cardId={slotPopup.cardId} className="card-popup__img" />
              {def && (
                <div className="card-popup__info">
                  <div className="card-popup__type">{TYPE_LABEL_ZH[def.type] ?? def.type}</div>
                  <div className="card-popup__name">{def.name_zh}</div>
                  <div className="card-popup__power">基礎戰力 {def.power}</div>
                  {def.effect_zh && <div className="card-popup__effect">{def.effect_zh}</div>}
                </div>
              )}
              <button className="btn-ghost card-popup__close" onClick={() => setSlotPopup(null)}>關閉</button>
            </div>
          </div>
        )
      })()}

      {/* 待選擇強制 Bar */}
      {pendingChoice && (() => {
        const loc = gameState.locations.find(l => l.id === pendingChoice.context.locationId)
        return (
          <div className="choice-bar">
            <span className="choice-bar__loc">📍 {loc?.name ?? pendingChoice.context.locationId}</span>
            <span className="choice-bar__prompt">{pendingChoice.prompt_zh}</span>
            <div className="choice-bar__options">
              {pendingChoice.options.map(opt => (
                <button key={opt.key} className="btn-primary choice-bar__btn" onClick={() => respondChoice(opt.key)}>
                  {opt.label_zh}
                </button>
              ))}
            </div>
          </div>
        )
      })()}

      {/* 標題列 */}
      <div className="revelation__header">
        <div className="revelation__header-top">
          <div className="revelation__title">
            {isReveal ? '結算階段' : `第 ${gameState.round} 回合結束`}
          </div>
          <div className="revelation__subtitle">
            {isReveal
              ? `第 ${gameState.round} 回合`
              : gameState.round < 3 ? `第 ${gameState.round + 1} 回合即將開始` : '最終回合'}
          </div>

          {/* 當前地點標籤（多地點時顯示） */}
          {isReveal && totalActiveLocs > 1 && currentLocName && (
            <div className="revelation__loc-badge">
              <span className="revelation__loc-badge-name">{currentLocName}</span>
              <span className="revelation__loc-badge-prog">{results.length}/{totalActiveLocs}</span>
            </div>
          )}
        </div>

        {/* 步驟進度列(唯讀,由 server 演出驅動 — 所有玩家看到同一幕) */}
        {isReveal && (
          <div className="revelation__step-bar">
            <div className="revelation__steps">
              {STEPS.map((s, i) => (
                <span key={s}
                  className={[
                    'revelation__step-dot',
                    s === currentStep ? 'revelation__step-dot--active' : '',
                    i < stepIdx       ? 'revelation__step-dot--done'   : '',
                  ].filter(Boolean).join(' ')}
                >
                  {STEP_LABELS[s]}
                </span>
              ))}
            </div>
            {isPlayingEffects && (
              <button
                className={`revelation__skip-btn ${iVotedSkip ? 'revelation__skip-btn--voted' : ''}`}
                onClick={voteSkip}
                disabled={iVotedSkip}
                title="全員投票後立即播完剩餘演出"
              >
                ⏩ 加速 {skipVotes.length}/{totalPlayers}
              </button>
            )}
          </div>
        )}

        {/* 步驟說明 */}
        {isReveal && (
          <div className="revelation__step-meta">
            <span className="revelation__step-desc">{STEP_DESCRIPTIONS[currentStep]}</span>
            {hasPendingChoices && !pendingChoice && <span className="revelation__step-hint revelation__step-hint--waiting">── 等待玩家回應效果選擇…</span>}
            {pendingChoice && <span className="revelation__step-hint revelation__step-hint--action">── 請你做出選擇！</span>}
          </div>
        )}
      </div>

      {/* 常駐戰場地圖:四地點固定排列,結算進度一目瞭然(回合結束時已無進行中地點) */}
      <LocationStrip gameState={gameState} myId={myId} currentLocId={isRoundEnd ? null : currentLocId} />

      {/* 固定座位列:效果來源高亮、目標脈衝、選擇中/勝者狀態 */}
      <PlayerSeats
        gameState={gameState}
        myId={myId}
        activeStatuses={seatStatuses}
        doneIds={confirmDoneIds}
        targetId={targetPlayerId}
        winnerId={currentStep === 'complete' && currentResult && !currentResult.tie ? currentResult.winner : null}
      />

      {/* 主體 */}
      {isReveal && (
        <ActiveEffectPanel effect={gameState.activeEffect} gameState={gameState} />
      )}

      <div className="revelation__body">

        {pendingChoice || hasPendingChoices ? (
          <div className="revelation__pending-wrap">
            {!pendingChoice && (
              <div className="revelation__pending-wait">
                <div className="revelation__pending-title">等待玩家選擇效果</div>
                {activeChoosers.length > 0 ? (
                  <div className="revelation__choosers">
                    {activeChoosers.map((c, i) => {
                      const who = gameState.players[c.playerId]
                      const card = CARD_DEFS[c.cardId]
                      const loc = gameState.locations.find(l => l.id === c.locationId)
                      return (
                        <div key={i} className="revelation__chooser-row">
                          <span className="revelation__chooser-name">{who?.name ?? '?'}</span>
                          正在決定
                          <span className="revelation__chooser-card">『{card?.name_zh ?? c.cardId}』</span>
                          的效果
                          {loc && <span className="revelation__chooser-loc">@ {loc.name}</span>}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="revelation__pending-text">
                    目前地點正在處理卡牌選擇，所有玩家會在選擇完成後同步進入效果播放。
                  </div>
                )}
              </div>
            )}
            <BattlefieldOverview
              gameState={gameState} myId={myId}
              highlightLocId={pendingChoiceLocId ?? ''}
              onSlotClick={setSlotPopup}
            />
          </div>
        ) : (
          <div className="revelation__main">
            {/* 結算內容:回合結束顯示摘要,結算中顯示當前地點 */}
            <div className="revelation__results">
              {isRoundEnd
                ? results.length > 0
                  ? <RoundSummary results={results} gameState={gameState} myId={myId} onSlotClick={setSlotPopup} />
                  : <div className="revelation__empty">本回合無人部署</div>
                : currentResult
                  ? <ResultCard result={currentResult} gameState={gameState} myId={myId}
                      showStep={currentStep} onSlotClick={setSlotPopup} />
                  : <div className="revelation__empty">等待結算中…</div>
              }
            </div>
          </div>
        )}

        {/* 側邊欄 */}
        <div className="revelation__sidebar">

          {/* 已發生事件時間軸(隨演出逐條浮現,可回顧) */}
          {isReveal && playedEvents.length > 0 && (
            <div className="revelation__event-log">
              <div className="revelation__event-log-title">效果時間軸</div>
              {playedEvents.map((item, i) => (
                <div key={i} className="revelation__timeline-item">
                  <span className={`revelation__timeline-step revelation__timeline-step--${item.step}`}>
                    {STEP_LABELS[item.step]}
                  </span>
                  <StepEventRow ev={item.ev} className="revelation__event-line" />
                </div>
              ))}
            </div>
          )}

          {/* 確認按鈕 */}
          <div className="revelation__confirm-area">
            {!iHaveConfirmed ? (
              <button className="btn-primary revelation__confirm-btn" onClick={confirm}>
                {isRoundEnd
                  ? (gameState.round >= 3 ? '查看最終結果' : '繼續下一回合')
                  : '確認，繼續'}
              </button>
            ) : (
              <div className="revelation__confirmed">✓ 已確認</div>
            )}
            {waiting.length > 0 && (
              <div className="revelation__waiting">
                <WaitingPlayers gameState={gameState} myId={myId} doneLabel="已確認" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
