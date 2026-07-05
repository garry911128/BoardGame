/**
 * screens-gameplay.test.tsx
 *
 * 覆蓋所有遊玩手法的前端測試——部署選項排列組合、撤退選擇、結算互動、
 * 氏族選擇、手牌建造等所有 socket 發送路徑與 UI 狀態變化。
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AllyCard, ConflictResult } from '@kindred/shared'
import ClanSelectScreen from '../ClanSelectScreen'
import GameOverScreen from '../GameOverScreen'
import HandBuildScreen from '../HandBuildScreen'
import LobbyScreen from '../LobbyScreen'
import PlayerHUD from '../PlayerHUD'
import PlanningScreen from '../PlanningScreen'
import RevelationScreen from '../RevelationScreen'
import WithdrawScreen from '../WithdrawScreen'
import { card, gameState, kine, player } from './fixtures'

// useGameActions() 回傳 Proxy：actions.selectClan('brujah') → emit('selectClan', 'brujah')。
const socketMock = vi.hoisted(() => ({ emit: vi.fn() }))
vi.mock('../convexGame', () => ({
  useGameActions: () =>
    new Proxy({} as Record<string, (...a: unknown[]) => void>, {
      get: (_t, prop) =>
        typeof prop === 'string'
          ? (...args: unknown[]) => socketMock.emit(prop, ...args)
          : undefined,
    }),
}))

// ── Shared test helpers ────────────────────────────────────────────────────

/** 基礎 PLANNING 狀態，預設 p1 是當前出牌者、手持 BR01 */
function planningState(overrides: Record<string, unknown> = {}, clan = 'brujah') {
  const handCard = card({ id: 'BR01', name_en: 'Bloody Fury', name_zh: 'Bloody Fury' })
  return gameState({
    phase: 'PLANNING',
    myHand: [handCard],
    myBlood: 10,
    waitingFor: ['p1'],
    currentTurnPlayerId: 'p1',
    players: {
      p1: { ...gameState().players.p1, clan, deploymentsLeft: 1 },
      p2: { ...gameState().players.p2, clan: 'ventrue', name: 'Bob' },
    },
    ...overrides,
  })
}

/** 選卡並點擊 The Rack，打開部署 Dialog */
function openDeployDialog(container: HTMLElement) {
  fireEvent.click(screen.getByRole('button', { name: /Bloody Fury/i }))
  fireEvent.click(screen.getByText('The Rack'))
}

const vampireAlly: AllyCard = {
  id: 'vamp1',
  name: 'Vampire Ally',
  type: 'vampire',
  influence: 2,
  feedBlood: 0,
  drainBlood: 3,
  drainInfluence: 0,
}

/** p1 在 rack 的部署槽 */
const rackSlot = {
  playerId: 'p1',
  cardId: 'BR01',
  faceDown: false,
  bloodTokensHidden: false,
  bloodTokens: 0,
  withdrawn: false,
  effectivePower: null as number | null,
}

/** 預設衝突結果（p1 勝 rack） */
function makeResult(overrides: Partial<ConflictResult> = {}): ConflictResult {
  return {
    locationId: 'rack',
    winner: 'p1',
    second: 'p2',
    scores: { p1: 6, p2: 2 },
    influenceGained: { p1: 1 },
    bloodEvents: [],
    stepEvents: { prepare: [], conflict: [], aftermath: [] },
    tie: false,
    ...overrides,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PlanningScreen – 部署排列組合
// ══════════════════════════════════════════════════════════════════════════════

describe('PlanningScreen – deployment options', () => {
  beforeEach(() => socketMock.emit.mockClear())

  it('non-Nosferatu 正面部署：faceDown=false bloodTokens=0', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState()} />)
    openDeployDialog(container)
    fireEvent.click(container.querySelector('.deploy-dialog .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
      locationId: 'rack', cardId: 'BR01', faceDown: false, bloodTokens: 0,
    })
  })

  it('non-Nosferatu 秘密部署：faceDown=true bloodTokens=0（花費 1 血）', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState()} />)
    openDeployDialog(container)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(container.querySelector('.deploy-dialog .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
      locationId: 'rack', cardId: 'BR01', faceDown: true, bloodTokens: 0,
    })
  })

  it('追加 1 血液代幣：faceDown=false bloodTokens=1', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState()} />)
    openDeployDialog(container)
    const plusBtn = container.querySelectorAll('.deploy-dialog__token-ctrl button')[1]
    fireEvent.click(plusBtn)
    fireEvent.click(container.querySelector('.deploy-dialog .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
      locationId: 'rack', cardId: 'BR01', faceDown: false, bloodTokens: 1,
    })
  })

  it('追加 2 血液代幣：faceDown=false bloodTokens=2', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState()} />)
    openDeployDialog(container)
    const plusBtn = container.querySelectorAll('.deploy-dialog__token-ctrl button')[1]
    fireEvent.click(plusBtn)
    fireEvent.click(plusBtn)
    fireEvent.click(container.querySelector('.deploy-dialog .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
      locationId: 'rack', cardId: 'BR01', faceDown: false, bloodTokens: 2,
    })
  })

  it('追加 3 血液代幣：faceDown=false bloodTokens=3', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState()} />)
    openDeployDialog(container)
    const plusBtn = container.querySelectorAll('.deploy-dialog__token-ctrl button')[1]
    fireEvent.click(plusBtn)
    fireEvent.click(plusBtn)
    fireEvent.click(plusBtn)
    fireEvent.click(container.querySelector('.deploy-dialog .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
      locationId: 'rack', cardId: 'BR01', faceDown: false, bloodTokens: 3,
    })
  })

  it('non-Nosferatu 秘密 + 2 代幣：faceDown=true bloodTokens=2（花費 3 血）', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState()} />)
    openDeployDialog(container)
    fireEvent.click(screen.getByRole('checkbox'))
    const plusBtn = container.querySelectorAll('.deploy-dialog__token-ctrl button')[1]
    fireEvent.click(plusBtn)
    fireEvent.click(plusBtn)
    fireEvent.click(container.querySelector('.deploy-dialog .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
      locationId: 'rack', cardId: 'BR01', faceDown: true, bloodTokens: 2,
    })
  })

  it('Nosferatu 秘密部署免費：faceDown=true bloodTokens=0（花費 0 血）', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState({}, 'nosferatu')} />)
    openDeployDialog(container)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(container.querySelector('.deploy-dialog .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
      locationId: 'rack', cardId: 'BR01', faceDown: true, bloodTokens: 0,
    })
  })

  it('Nosferatu 秘密 + 1 代幣：faceDown=true bloodTokens=1（僅代幣成本）', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState({}, 'nosferatu')} />)
    openDeployDialog(container)
    fireEvent.click(screen.getByRole('checkbox'))
    const plusBtn = container.querySelectorAll('.deploy-dialog__token-ctrl button')[1]
    fireEvent.click(plusBtn)
    fireEvent.click(container.querySelector('.deploy-dialog .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
      locationId: 'rack', cardId: 'BR01', faceDown: true, bloodTokens: 1,
    })
  })

  it('Nosferatu 秘密 + 3 代幣：faceDown=true bloodTokens=3（僅代幣成本）', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState({}, 'nosferatu')} />)
    openDeployDialog(container)
    fireEvent.click(screen.getByRole('checkbox'))
    const plusBtn = container.querySelectorAll('.deploy-dialog__token-ctrl button')[1]
    fireEvent.click(plusBtn)
    fireEvent.click(plusBtn)
    fireEvent.click(plusBtn)
    fireEvent.click(container.querySelector('.deploy-dialog .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
      locationId: 'rack', cardId: 'BR01', faceDown: true, bloodTokens: 3,
    })
  })

  it('秘密部署血液不足時確認按鈕應 disabled（0 血無法支付 1 血秘密費用）', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState({ myBlood: 0 })} />)
    openDeployDialog(container)
    fireEvent.click(screen.getByRole('checkbox'))  // 勾選秘密（需 1 血）
    const confirmBtn = container.querySelector('.deploy-dialog .btn-primary') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
    expect(socketMock.emit).not.toHaveBeenCalled()
  })

  it('點擊 overlay 取消 Dialog，不發送事件', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState()} />)
    openDeployDialog(container)
    expect(container.querySelector('.deploy-dialog')).toBeInTheDocument()
    fireEvent.click(container.querySelector('.deploy-dialog-overlay')!)
    expect(container.querySelector('.deploy-dialog')).not.toBeInTheDocument()
    expect(socketMock.emit).not.toHaveBeenCalled()
  })

  it('再次點擊同一張牌，取消選取（dialog 不開啟）', () => {
    render(<PlanningScreen myId="p1" gameState={planningState()} />)
    const cardBtn = screen.getByRole('button', { name: /Bloody Fury/i })
    fireEvent.click(cardBtn)
    expect(cardBtn.className).toContain('card-tile--selected')
    fireEvent.click(cardBtn)
    expect(cardBtn.className).not.toContain('card-tile--selected')
    // 再點地點不應開啟 dialog
    fireEvent.click(screen.getByText('The Rack'))
    expect(screen.queryByText('部署至')).not.toBeInTheDocument()
  })

  it('未選卡時點擊地點不應開啟 Dialog', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState()} />)
    fireEvent.click(screen.getByText('The Rack'))
    expect(container.querySelector('.deploy-dialog')).not.toBeInTheDocument()
  })

  it('非自己回合時顯示等待提示，手牌不可點擊', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({ waitingFor: ['p1'], currentTurnPlayerId: 'p2' })}
      />
    )
    const waitingDiv = container.querySelector('.planning__waiting')
    expect(waitingDiv).toBeInTheDocument()
    expect(waitingDiv!.textContent).toContain('Bob')
    const cardBtn = screen.queryByRole('button', { name: /Bloody Fury/i }) as HTMLButtonElement | null
    if (cardBtn) expect(cardBtn.disabled).toBe(true)
  })

  it('已完成部署後隱藏手牌區域與 Skip 按鈕', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({
          waitingFor: ['p2'],
          currentTurnPlayerId: 'p2',
          players: {
            p1: { ...gameState().players.p1, clan: 'brujah', deploymentsLeft: 0 },
            p2: { ...gameState().players.p2, clan: 'ventrue', name: 'Bob' },
          },
        })}
      />
    )
    expect(screen.queryByRole('button', { name: /Bloody Fury/i })).not.toBeInTheDocument()
    expect(container.querySelector('.planning__skip-btn')).not.toBeInTheDocument()
  })

  it('血液 ≤ 2 的對手顯示危機樣式', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({
          players: {
            p1: { ...gameState().players.p1, clan: 'brujah', deploymentsLeft: 1 },
            p2: { ...gameState().players.p2, clan: 'ventrue', name: 'Bob', blood: 2 },
          },
        })}
      />
    )
    expect(container.querySelector('.seat--danger')).toBeInTheDocument()
  })

  it('血液正常的對手不顯示危機樣式', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({
          players: {
            p1: { ...gameState().players.p1, clan: 'brujah', deploymentsLeft: 1 },
            p2: { ...gameState().players.p2, clan: 'ventrue', name: 'Bob', blood: 8 },
          },
        })}
      />
    )
    expect(container.querySelector('.seat--danger')).not.toBeInTheDocument()
  })

  it('點擊自己已部署的牌槽開啟 Slot Popup', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={gameState({
          phase: 'PLANNING',
          myHand: [],
          myBlood: 6,
          waitingFor: ['p2'],
          currentTurnPlayerId: 'p2',
          players: {
            p1: { ...gameState().players.p1, clan: 'brujah', deploymentsLeft: 0 },
            p2: { ...gameState().players.p2, clan: 'ventrue', name: 'Bob' },
          },
          deployments: {
            ...gameState().deployments,
            rack: [{ ...rackSlot }],
          },
        })}
      />
    )
    const slot = container.querySelector('.loc-slot--mine.loc-slot--peekable')!
    fireEvent.click(slot)
    expect(container.querySelector('.slot-popup')).toBeInTheDocument()
  })

  it('點擊 Slot Popup 關閉按鈕後 Popup 消失', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={gameState({
          phase: 'PLANNING',
          myHand: [],
          myBlood: 6,
          waitingFor: ['p2'],
          currentTurnPlayerId: 'p2',
          players: {
            p1: { ...gameState().players.p1, clan: 'brujah', deploymentsLeft: 0 },
            p2: { ...gameState().players.p2, clan: 'ventrue', name: 'Bob' },
          },
          deployments: {
            ...gameState().deployments,
            rack: [{ ...rackSlot }],
          },
        })}
      />
    )
    fireEvent.click(container.querySelector('.loc-slot--mine.loc-slot--peekable')!)
    fireEvent.click(container.querySelector('.slot-popup__close')!)
    expect(container.querySelector('.slot-popup')).not.toBeInTheDocument()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// PlanningScreen – Skip 部署
// ══════════════════════════════════════════════════════════════════════════════

describe('PlanningScreen – skip deployment', () => {
  beforeEach(() => socketMock.emit.mockClear())

  it('手牌為空時 Skip 確認框顯示一般提示文字', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({ myHand: [] })}
      />
    )
    fireEvent.click(container.querySelector('.planning__skip-btn')!)
    expect(screen.getByText('確認結束本回合部署？')).toBeInTheDocument()
  })

  it('手牌有牌時 Skip 確認框顯示剩餘張數警告', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState()} />)
    fireEvent.click(container.querySelector('.planning__skip-btn')!)
    expect(screen.getByText(/你還有 1 張手牌未部署/)).toBeInTheDocument()
  })

  it('點擊 Skip 確認框 Overlay 取消，不發送事件', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningState()} />)
    fireEvent.click(container.querySelector('.planning__skip-btn')!)
    expect(container.querySelector('.skip-confirm')).toBeInTheDocument()
    fireEvent.click(container.querySelector('.skip-confirm-overlay')!)
    expect(container.querySelector('.skip-confirm')).not.toBeInTheDocument()
    expect(socketMock.emit).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// PlanningScreen – 同盟牌互動
// ══════════════════════════════════════════════════════════════════════════════

describe('PlanningScreen – ally interactions', () => {
  beforeEach(() => socketMock.emit.mockClear())

  it('人類同盟牌點擊汲取後顯示確認 Dialog(不含業報警告),不立即發送', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({ myHand: [], myAlliance: [kine] })}
      />
    )
    fireEvent.click(screen.getByText('汲取'))
    expect(container.querySelector('.drain-confirm')).toBeInTheDocument()
    // 人類同盟不涉及弒親,不顯示業報代幣警告
    expect(container.querySelector('.drain-confirm__penalty')).not.toBeInTheDocument()
    expect(socketMock.emit).not.toHaveBeenCalled()
  })

  it('確認汲取人類同盟後發送 drainAlly', () => {
    render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({ myHand: [], myAlliance: [kine] })}
      />
    )
    fireEvent.click(screen.getByText('汲取'))
    fireEvent.click(screen.getByText('確認汲取'))
    expect(socketMock.emit).toHaveBeenCalledWith('drainAlly', 'kine')
  })

  it('取消人類同盟汲取確認,不發送', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({ myHand: [], myAlliance: [kine] })}
      />
    )
    fireEvent.click(screen.getByText('汲取'))
    fireEvent.click(screen.getByText('取消'))
    expect(container.querySelector('.drain-confirm')).not.toBeInTheDocument()
    expect(socketMock.emit).not.toHaveBeenCalled()
  })

  it('吸血鬼同盟牌點擊汲取後顯示確認 Dialog，不立即發送', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({ myHand: [], myAlliance: [vampireAlly] })}
      />
    )
    fireEvent.click(screen.getByText('⚠ 汲取'))
    expect(container.querySelector('.drain-confirm')).toBeInTheDocument()
    expect(socketMock.emit).not.toHaveBeenCalled()
  })

  it('點擊吸血鬼汲取確認 Dialog Overlay 取消，不發送', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({ myHand: [], myAlliance: [vampireAlly] })}
      />
    )
    fireEvent.click(screen.getByText('⚠ 汲取'))
    fireEvent.click(container.querySelector('.drain-confirm-overlay')!)
    expect(container.querySelector('.drain-confirm')).not.toBeInTheDocument()
    expect(socketMock.emit).not.toHaveBeenCalled()
  })

  it('確認汲取吸血鬼後發送 drainAlly', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({ myHand: [], myAlliance: [vampireAlly] })}
      />
    )
    fireEvent.click(screen.getByText('⚠ 汲取'))
    fireEvent.click(container.querySelector('.drain-confirm .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('drainAlly', 'vamp1')
  })

  it('業報代幣為 2 時汲取吸血鬼顯示致命警告', () => {
    render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({
          myHand: [],
          myAlliance: [vampireAlly],
          players: {
            p1: { ...gameState().players.p1, clan: 'brujah', diablerie: 2, deploymentsLeft: 1 },
            p2: { ...gameState().players.p2, clan: 'ventrue', name: 'Bob' },
          },
        })}
      />
    )
    fireEvent.click(screen.getByText('⚠ 汲取'))
    expect(screen.getByText(/你將被淘汰出局/)).toBeInTheDocument()
  })

  it('業報代幣為 1 時汲取吸血鬼不顯示致命警告，但顯示一般警告', () => {
    render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({
          myHand: [],
          myAlliance: [vampireAlly],
          players: {
            p1: { ...gameState().players.p1, clan: 'brujah', diablerie: 1, deploymentsLeft: 1 },
            p2: { ...gameState().players.p2, clan: 'ventrue', name: 'Bob' },
          },
        })}
      />
    )
    fireEvent.click(screen.getByText('⚠ 汲取'))
    expect(screen.getByText(/再一枚即被淘汰/)).toBeInTheDocument()
    expect(screen.queryByText(/你將被淘汰出局/)).not.toBeInTheDocument()
  })

  it('已汲取的同盟牌不顯示汲取按鈕', () => {
    const drainedKine = { ...kine, drained: true }
    render(
      <PlanningScreen
        myId="p1"
        gameState={planningState({ myHand: [], myAlliance: [drainedKine] })}
      />
    )
    expect(screen.queryByText('汲取')).not.toBeInTheDocument()
    expect(screen.getByText('已汲取')).toBeInTheDocument()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// WithdrawScreen – 留守 / 撤退排列組合
// ══════════════════════════════════════════════════════════════════════════════

describe('WithdrawScreen – stay and retreat choices', () => {
  beforeEach(() => socketMock.emit.mockClear())

  function renderWithdraw(slotOverrides = {}, stateOverrides: Record<string, unknown> = {}) {
    return render(
      <WithdrawScreen
        myId="p1"
        gameState={gameState({
          phase: 'WITHDRAW',
          currentLocIndex: 0,
          waitingFor: ['p1'],
          deployments: {
            ...gameState().deployments,
            rack: [{ ...rackSlot, ...slotOverrides }],
          },
          ...stateOverrides,
        })}
      />
    )
  }

  it('未選擇時確認按鈕 disabled', () => {
    const { container } = renderWithdraw()
    const submitBtn = container.querySelector('.withdraw__submit') as HTMLButtonElement
    expect(submitBtn.disabled).toBe(true)
  })

  it('選擇留守後提交：emit submitWithdraw withdraw=false', () => {
    const { container } = renderWithdraw()
    fireEvent.click(container.querySelectorAll('.wd-btn')[0])   // 留守
    fireEvent.click(container.querySelector('.withdraw__submit')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitWithdraw', {
      locationId: 'rack', withdraw: false,
    })
  })

  it('選擇撤退後提交：emit submitWithdraw withdraw=true', () => {
    const { container } = renderWithdraw()
    fireEvent.click(container.querySelectorAll('.wd-btn')[1])   // 撤退
    fireEvent.click(container.querySelector('.withdraw__submit')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitWithdraw', {
      locationId: 'rack', withdraw: true,
    })
  })

  it('此地點無部署時不顯示決策按鈕與確認按鈕', () => {
    const { container } = render(
      <WithdrawScreen
        myId="p1"
        gameState={gameState({ phase: 'WITHDRAW', currentLocIndex: 0, waitingFor: ['p1'] })}
      />
    )
    expect(container.querySelectorAll('.wd-btn').length).toBe(0)
    expect(container.querySelector('.withdraw__submit')).not.toBeInTheDocument()
  })

  it('已提交後隱藏確認按鈕', () => {
    const { container } = renderWithdraw({}, { waitingFor: ['p2'] })
    expect(container.querySelector('.withdraw__submit')).not.toBeInTheDocument()
  })

  it('普通地點顯示「牌移至王子之地」撤退說明', () => {
    renderWithdraw()
    expect(screen.getByText(/取回血液，牌移至王子之地/)).toBeInTheDocument()
  })

  it('有血液代幣時普通地點撤退說明包含代幣數量', () => {
    renderWithdraw({ bloodTokens: 3 })
    expect(screen.getByText(/取回 3 血液，牌移至王子之地/)).toBeInTheDocument()
  })

  it('王子之地（isPrinces）顯示「取回牌與血液」說明', () => {
    render(
      <WithdrawScreen
        myId="p1"
        gameState={gameState({
          phase: 'WITHDRAW',
          currentLocIndex: 3,
          waitingFor: ['p1'],
          deployments: {
            ...gameState().deployments,
            haven: [{
              ...rackSlot,
              playerId: 'p1',
            }],
          },
        })}
      />
    )
    expect(screen.getByText('取回牌與血液')).toBeInTheDocument()
  })

  it('王子之地有血液代幣時顯示代幣數量', () => {
    render(
      <WithdrawScreen
        myId="p1"
        gameState={gameState({
          phase: 'WITHDRAW',
          currentLocIndex: 3,
          waitingFor: ['p1'],
          deployments: {
            ...gameState().deployments,
            haven: [{
              ...rackSlot,
              playerId: 'p1',
              bloodTokens: 2,
            }],
          },
        })}
      />
    )
    expect(screen.getByText(/取回 2 血液 \+ 牌/)).toBeInTheDocument()
  })

  it('currentLocIndex 超出範圍時顯示 Header 但無確認按鈕', () => {
    const { container } = render(
      <WithdrawScreen
        myId="p1"
        gameState={gameState({ phase: 'WITHDRAW', currentLocIndex: 99 })}
      />
    )
    expect(container.querySelector('.withdraw__header')).toBeInTheDocument()
    expect(container.querySelector('.withdraw__submit')).not.toBeInTheDocument()
  })

  it('所有人完成後顯示撤退結果揭曉提示', () => {
    render(
      <WithdrawScreen
        myId="p1"
        gameState={gameState({
          phase: 'WITHDRAW',
          currentLocIndex: 0,
          waitingFor: [],
          deployments: {
            ...gameState().deployments,
            rack: [{ ...rackSlot }],
          },
        })}
      />
    )
    expect(screen.getByText(/所有人已決定，撤退結果揭曉中/)).toBeInTheDocument()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// RevelationScreen – 確認與選擇互動
// ══════════════════════════════════════════════════════════════════════════════

describe('RevelationScreen – confirmation and choices', () => {
  beforeEach(() => socketMock.emit.mockClear())

  it('點擊確認按鈕發送 readyAdvance', () => {
    const { container } = render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'REVELATION',
          waitingFor: ['p1'],
          lastConflictResults: [makeResult()],
          deployments: { ...gameState().deployments, rack: [{ ...rackSlot, effectivePower: 6 }] },
        })}
      />
    )
    fireEvent.click(container.querySelector('.revelation__confirm-btn')!)
    expect(socketMock.emit).toHaveBeenCalledWith('readyAdvance')
  })

  it('已確認後顯示 ✓ 已確認，不顯示確認按鈕', () => {
    render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'REVELATION',
          waitingFor: ['p2'],
          lastConflictResults: [makeResult()],
        })}
      />
    )
    expect(screen.getByText('✓ 已確認')).toBeInTheDocument()
    expect(screen.queryByText('確認，繼續')).not.toBeInTheDocument()
  })

  it('有 pendingChoice 時選擇第一個選項：emit respondChoice option=gain_blood', () => {
    render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'REVELATION',
          waitingFor: ['p1'],
          hasPendingChoices: true,
          myPendingChoice: {
            id: 'ch1',
            playerId: 'p1',
            prompt_zh: '選擇一個效果',
            options: [
              { key: 'gain_blood',     label_zh: '獲得血液' },
              { key: 'gain_influence', label_zh: '獲得影響力' },
            ],
            context: { cardId: 'VE09', locationId: 'rack', sourcePlayerId: 'p1', sourceName: 'Alice' },
            choiceKey: 'VE09:rack:p1',
          },
          lastConflictResults: [makeResult()],
        })}
      />
    )
    fireEvent.click(screen.getByText('獲得血液'))
    expect(socketMock.emit).toHaveBeenCalledWith('respondChoice', {
      choiceId: 'ch1', option: 'gain_blood',
    })
  })

  it('有 pendingChoice 時選擇第二個選項：emit respondChoice option=gain_influence', () => {
    render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'REVELATION',
          waitingFor: ['p1'],
          hasPendingChoices: true,
          myPendingChoice: {
            id: 'ch2',
            playerId: 'p1',
            prompt_zh: '選擇一個效果',
            options: [
              { key: 'gain_blood',     label_zh: '獲得血液' },
              { key: 'gain_influence', label_zh: '獲得影響力' },
            ],
            context: { cardId: 'VE09', locationId: 'rack', sourcePlayerId: 'p1', sourceName: 'Alice' },
            choiceKey: 'VE09:rack:p1',
          },
          lastConflictResults: [makeResult()],
        })}
      />
    )
    fireEvent.click(screen.getByText('獲得影響力'))
    expect(socketMock.emit).toHaveBeenCalledWith('respondChoice', {
      choiceId: 'ch2', option: 'gain_influence',
    })
  })

  it('ROUND_END 非最終回合（round=1）確認按鈕顯示「繼續下一回合」', () => {
    const { container } = render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'ROUND_END',
          round: 1,
          waitingFor: ['p1'],
          lastConflictResults: [makeResult()],
        })}
      />
    )
    expect(container.querySelector('.revelation__confirm-btn')!.textContent).toBe('繼續下一回合')
  })

  it('ROUND_END 第二非最終回合（round=2）確認按鈕顯示「繼續下一回合」', () => {
    const { container } = render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'ROUND_END',
          round: 2,
          waitingFor: ['p1'],
          lastConflictResults: [makeResult()],
        })}
      />
    )
    expect(container.querySelector('.revelation__confirm-btn')!.textContent).toBe('繼續下一回合')
  })

  it('ROUND_END 最終回合（round=3）確認按鈕顯示「查看最終結果」', () => {
    const { container } = render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'ROUND_END',
          round: 3,
          waitingFor: ['p1'],
          lastConflictResults: [makeResult()],
        })}
      />
    )
    expect(container.querySelector('.revelation__confirm-btn')!.textContent).toBe('查看最終結果')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// RevelationScreen – 衝突結果顯示
// ══════════════════════════════════════════════════════════════════════════════

describe('RevelationScreen – conflict result display', () => {
  it('ROUND_END 顯示平局結果', () => {
    render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'ROUND_END',
          waitingFor: ['p1'],
          lastConflictResults: [makeResult({
            winner: null, second: null, scores: { p1: 4, p2: 4 },
            influenceGained: {}, tie: true,
          })],
        })}
      />
    )
    expect(screen.getByText('平手，無人得分')).toBeInTheDocument()
  })

  it('ROUND_END 顯示他人勝利時的勝者名稱與影響力', () => {
    render(
      <RevelationScreen
        myId="p2"
        gameState={gameState({
          phase: 'ROUND_END',
          waitingFor: ['p2'],
          lastConflictResults: [makeResult({ winner: 'p1', influenceGained: { p1: 2 } })],
          players: {
            p1: player('p1', { name: 'Alice', clan: 'brujah' }),
            p2: player('p2', { name: 'Bob',   clan: 'ventrue' }),
          },
        })}
      />
    )
    expect(screen.getByText('🏆 Alice 勝出')).toBeInTheDocument()
    expect(screen.getByText('+2 影響力')).toBeInTheDocument()
  })

  it('ROUND_END 自己勝利時顯示「🏆 你勝出」', () => {
    render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'ROUND_END',
          waitingFor: ['p1'],
          lastConflictResults: [makeResult({ winner: 'p1', influenceGained: { p1: 1 } })],
        })}
      />
    )
    expect(screen.getByText('🏆 你勝出')).toBeInTheDocument()
  })

  it('ROUND_END 點擊地點列展開詳細結算卡', () => {
    const { container } = render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'ROUND_END',
          waitingFor: ['p1'],
          lastConflictResults: [makeResult({ winner: 'p1', influenceGained: { p1: 1 } })],
          deployments: { ...gameState().deployments, rack: [{ ...rackSlot, effectivePower: 6 }] },
        })}
      />
    )
    expect(container.querySelector('.result-card')).not.toBeInTheDocument()
    fireEvent.click(container.querySelector('.round-summary__loc-row')!)
    expect(container.querySelector('.result-card')).toBeInTheDocument()
  })

  it('已有一個先前地點結算結果時顯示歷史記錄 Chip', () => {
    render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'REVELATION',
          waitingFor: ['p1'],
          lastConflictResults: [
            makeResult({ locationId: 'rack' }),
            makeResult({ locationId: 'asylum', winner: 'p2', influenceGained: { p2: 1 } }),
          ],
        })}
      />
    )
    // rack 是先前結果，應顯示為歷史 chip
    expect(screen.getByText('The Rack')).toBeInTheDocument()
  })

  it('hasPendingChoices=true 且自己沒有待選擇時顯示等待文字與戰場概覽', () => {
    render(
      <RevelationScreen
        myId="p2"
        gameState={gameState({
          phase: 'REVELATION',
          waitingFor: ['p1'],
          hasPendingChoices: true,
          myPendingChoice: null,
          lastConflictResults: [makeResult()],
          deployments: {
            ...gameState().deployments,
            asylum: [{
              playerId: 'p1', cardId: 'MA01', faceDown: false,
              bloodTokensHidden: false, bloodTokens: 0,
              withdrawn: false, effectivePower: 0,
            }],
          },
        })}
      />
    )
    expect(screen.getByText('等待玩家選擇效果')).toBeInTheDocument()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// RevelationScreen – 步驟導航
// ══════════════════════════════════════════════════════════════════════════════

describe('RevelationScreen – server-driven steps & skip voting', () => {
  beforeEach(() => socketMock.emit.mockClear())

  function renderRevelation(extra: Record<string, unknown> = {}) {
    return render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'REVELATION',
          waitingFor: ['p1'],
          lastConflictResults: [makeResult()],
          deployments: { ...gameState().deployments, rack: [{ ...rackSlot, effectivePower: 6 }] },
          ...extra,
        })}
      />
    )
  }

  const conflictEffect = {
    locationId: 'rack', step: 'conflict', eventIndex: 0, eventCount: 3,
    text: '戰力比拚', sourcePlayerName: 'Alice',
  }

  it('無演出且已有結果 → 步驟為「完成」(等待確認)', () => {
    renderRevelation()
    expect(screen.getByText('分配影響力，結算本地點')).toBeInTheDocument()
  })

  it('步驟完全由 server 的 activeEffect 驅動(conflict)', () => {
    const { container } = renderRevelation({ activeEffect: conflictEffect })
    expect(screen.getByText('計算各地點戰力，決定勝負')).toBeInTheDocument()
    const activeDot = container.querySelector('.revelation__step-dot--active')
    expect(activeDot?.textContent).toBe('衝突')
  })

  it('步驟列為唯讀 — 不再有上一步/下一步/自動播放按鈕', () => {
    const { container } = renderRevelation({ activeEffect: conflictEffect })
    expect(container.querySelector('.revelation__step-nav')).not.toBeInTheDocument()
    expect(container.querySelector('.revelation__autoplay-btn')).not.toBeInTheDocument()
  })

  it('演出中顯示加速按鈕,點擊送出 skipEffects', () => {
    renderRevelation({ activeEffect: conflictEffect, skipVotes: [] })
    const btn = screen.getByRole('button', { name: /加速/ })
    fireEvent.click(btn)
    expect(socketMock.emit).toHaveBeenCalledWith('skipEffects')
  })

  it('已投票後加速按鈕停用並顯示票數', () => {
    renderRevelation({ activeEffect: conflictEffect, skipVotes: ['p1'] })
    const btn = screen.getByRole('button', { name: /加速 1\/2/ })
    expect(btn).toBeDisabled()
  })

  it('沒有演出時不顯示加速按鈕', () => {
    renderRevelation()
    expect(screen.queryByRole('button', { name: /加速/ })).not.toBeInTheDocument()
  })

  it('activeChoosers 讓對應座位顯示「選擇中…」', () => {
    const { container } = renderRevelation({
      hasPendingChoices: true,
      activeChoosers: [{ playerId: 'p2', cardId: 'VE03', locationId: 'rack' }],
      waitingFor: ['p2'],
    })
    expect(container.querySelector('.seat__active-label')?.textContent).toBe('選擇中…')
  })

  it('等待選擇面板顯示誰正在決定哪張牌', () => {
    renderRevelation({
      hasPendingChoices: true,
      myPendingChoice: null,
      activeChoosers: [{ playerId: 'p2', cardId: 'VE03', locationId: 'rack' }],
      waitingFor: ['p2'],
    })
    expect(screen.getByText('等待玩家選擇效果')).toBeInTheDocument()
    expect(screen.getByText(/正在決定/)).toBeInTheDocument()
  })

  it('演出中時間軸只顯示已播過的事件', () => {
    const { container } = render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'REVELATION',
          waitingFor: ['p1'],
          lastConflictResults: [makeResult({
            stepEvents: {
              prepare: [{ text: '事件一' }, { text: '事件二' }],
              conflict: [{ text: '事件三' }],
              aftermath: [],
            },
          })],
          activeEffect: { locationId: 'rack', step: 'prepare', eventIndex: 1, eventCount: 4, text: '事件二' },
        })}
      />
    )
    // eventIndex=1 → 只有事件一已播過
    expect(screen.getByText(/事件一/)).toBeInTheDocument()
    expect(container.querySelectorAll('.revelation__timeline-item').length).toBe(1)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// ClanSelectScreen – 氏族選擇排列組合
// ══════════════════════════════════════════════════════════════════════════════

describe('ClanSelectScreen – all clans', () => {
  beforeEach(() => socketMock.emit.mockClear())

  function freshState(extraPlayers = {}) {
    return gameState({
      phase: 'CLAN_SELECT',
      players: {
        p1: { ...gameState().players.p1, clan: null },
        p2: { ...gameState().players.p2, clan: null },
        ...extraPlayers,
      },
      waitingFor: ['p1', 'p2'],
    })
  }

  it('全部 7 個氏族按鈕皆有渲染', () => {
    render(<ClanSelectScreen myId="p1" gameState={freshState()} />)
    for (const name of ['Brujah', 'Nosferatu', 'Toreador', 'Tremere', 'Malkavian', 'Gangrel', 'Ventrue']) {
      expect(screen.getByRole('button', { name: new RegExp(name, 'i') })).toBeInTheDocument()
    }
  })

  it('選擇 Brujah：emit selectClan brujah', () => {
    render(<ClanSelectScreen myId="p1" gameState={freshState()} />)
    fireEvent.click(screen.getByRole('button', { name: /Brujah/i }))
    expect(socketMock.emit).toHaveBeenCalledWith('selectClan', 'brujah')
  })

  it('選擇 Nosferatu：emit selectClan nosferatu', () => {
    render(<ClanSelectScreen myId="p1" gameState={freshState()} />)
    fireEvent.click(screen.getByRole('button', { name: /Nosferatu/i }))
    expect(socketMock.emit).toHaveBeenCalledWith('selectClan', 'nosferatu')
  })

  it('選擇 Toreador：emit selectClan toreador', () => {
    render(<ClanSelectScreen myId="p1" gameState={freshState()} />)
    fireEvent.click(screen.getByRole('button', { name: /Toreador/i }))
    expect(socketMock.emit).toHaveBeenCalledWith('selectClan', 'toreador')
  })

  it('選擇 Tremere：emit selectClan tremere', () => {
    render(<ClanSelectScreen myId="p1" gameState={freshState()} />)
    fireEvent.click(screen.getByRole('button', { name: /Tremere/i }))
    expect(socketMock.emit).toHaveBeenCalledWith('selectClan', 'tremere')
  })

  it('選擇 Malkavian：emit selectClan malkavian', () => {
    render(<ClanSelectScreen myId="p1" gameState={freshState()} />)
    fireEvent.click(screen.getByRole('button', { name: /Malkavian/i }))
    expect(socketMock.emit).toHaveBeenCalledWith('selectClan', 'malkavian')
  })

  it('選擇 Gangrel：emit selectClan gangrel', () => {
    render(<ClanSelectScreen myId="p1" gameState={freshState()} />)
    fireEvent.click(screen.getByRole('button', { name: /Gangrel/i }))
    expect(socketMock.emit).toHaveBeenCalledWith('selectClan', 'gangrel')
  })

  it('選擇 Ventrue：emit selectClan ventrue', () => {
    render(<ClanSelectScreen myId="p1" gameState={freshState()} />)
    fireEvent.click(screen.getByRole('button', { name: /Ventrue/i }))
    expect(socketMock.emit).toHaveBeenCalledWith('selectClan', 'ventrue')
  })

  it('自己已選氏族後其他氏族按鈕應 disabled', () => {
    render(
      <ClanSelectScreen
        myId="p1"
        gameState={gameState({
          phase: 'CLAN_SELECT',
          players: {
            p1: { ...gameState().players.p1, clan: 'toreador' },
            p2: { ...gameState().players.p2, clan: null },
          },
          waitingFor: ['p2'],
        })}
      />
    )
    const gangrelBtn = screen.getByRole('button', { name: /Gangrel/i }) as HTMLButtonElement
    expect(gangrelBtn.disabled).toBe(true)
  })

  it('他人已選的氏族按鈕應 disabled', () => {
    render(
      <ClanSelectScreen
        myId="p1"
        gameState={gameState({
          phase: 'CLAN_SELECT',
          players: {
            p1: { ...gameState().players.p1, clan: null },
            p2: { ...gameState().players.p2, clan: 'nosferatu' },
          },
          waitingFor: ['p1'],
        })}
      />
    )
    const nosferatuBtn = screen.getByRole('button', { name: /Nosferatu/i }) as HTMLButtonElement
    expect(nosferatuBtn.disabled).toBe(true)
  })

  it('自己已選時顯示等待其他玩家的提示', () => {
    const { container } = render(
      <ClanSelectScreen
        myId="p1"
        gameState={gameState({
          phase: 'CLAN_SELECT',
          players: {
            p1: { ...gameState().players.p1, clan: 'gangrel' },
            p2: { ...gameState().players.p2, clan: null },
          },
          waitingFor: ['p2'],
        })}
      />
    )
    const statusDiv = container.querySelector('.clan-select__status')
    expect(statusDiv?.textContent).toContain('你選擇了')
    expect(statusDiv?.textContent).toContain('甘格瑞爾')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// HandBuildScreen – 手牌建造
// ══════════════════════════════════════════════════════════════════════════════

describe('HandBuildScreen – draft states', () => {
  beforeEach(() => socketMock.emit.mockClear())

  it('顯示所有草稿牌作為可點擊按鈕', () => {
    const draftCards = [
      card({ id: 'BR02', name_en: 'Punk Posse', name_zh: 'Punk Posse' }),
      card({ id: 'BR03', name_en: 'Street Fight', name_zh: 'Street Fight' }),
    ]
    render(
      <HandBuildScreen
        myId="p1"
        gameState={gameState({ phase: 'HAND_BUILD', myHandBuildDraft: draftCards, waitingFor: ['p1'] })}
      />
    )
    expect(screen.getByRole('button', { name: /Punk Posse/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Street Fight/i })).toBeInTheDocument()
  })

  it('draft 為空時顯示已選擇提示，不顯示確認按鈕', () => {
    render(
      <HandBuildScreen
        myId="p1"
        gameState={gameState({ phase: 'HAND_BUILD', myHandBuildDraft: [], waitingFor: ['p2'] })}
      />
    )
    expect(screen.getByText('已選擇，等待其他玩家…')).toBeInTheDocument()
    expect(screen.queryByText('確認加入手牌')).not.toBeInTheDocument()
  })

  it('選擇草稿牌前不顯示確認按鈕', () => {
    const draftCard = card({ id: 'BR02', name_en: 'Punk Posse', name_zh: 'Punk Posse' })
    render(
      <HandBuildScreen
        myId="p1"
        gameState={gameState({ phase: 'HAND_BUILD', myHandBuildDraft: [draftCard], waitingFor: ['p1'] })}
      />
    )
    expect(screen.queryByText('確認加入手牌')).not.toBeInTheDocument()
  })

  it('點擊草稿牌後顯示確認按鈕', () => {
    const draftCard = card({ id: 'BR02', name_en: 'Punk Posse', name_zh: 'Punk Posse' })
    render(
      <HandBuildScreen
        myId="p1"
        gameState={gameState({ phase: 'HAND_BUILD', myHandBuildDraft: [draftCard], waitingFor: ['p1'] })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Punk Posse/i }))
    expect(screen.getByText('確認加入手牌')).toBeInTheDocument()
  })

  it('點擊「重新選擇」取消已選擇的草稿牌', () => {
    const draftCard = card({ id: 'BR02', name_en: 'Punk Posse', name_zh: 'Punk Posse' })
    render(
      <HandBuildScreen
        myId="p1"
        gameState={gameState({ phase: 'HAND_BUILD', myHandBuildDraft: [draftCard], waitingFor: ['p1'] })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Punk Posse/i }))
    fireEvent.click(screen.getByText('重新選擇'))
    expect(screen.queryByText('確認加入手牌')).not.toBeInTheDocument()
  })

  it('目前手牌（已有牌）應顯示在手牌區域', () => {
    const starterCard = card({ id: 'BR09', name_en: 'Hunt', name_zh: 'Hunt', is_starter: true })
    const draftCard   = card({ id: 'BR02', name_en: 'Punk Posse', name_zh: 'Punk Posse' })
    render(
      <HandBuildScreen
        myId="p1"
        gameState={gameState({
          phase: 'HAND_BUILD',
          myHand: [starterCard],
          myHandBuildDraft: [draftCard],
          waitingFor: ['p1'],
        })}
      />
    )
    expect(screen.getByText(/目前手牌（1 張）/)).toBeInTheDocument()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// LobbyScreen – 房間互動
// ══════════════════════════════════════════════════════════════════════════════

describe('LobbyScreen – room interactions', () => {
  beforeEach(() => socketMock.emit.mockClear())

  it('切換至加入畫面並提交：emit joinRoom', () => {
    const { container } = render(<LobbyScreen myId="" gameState={null} onError={vi.fn()} />)
    fireEvent.click(screen.getByText('加入房間'))
    const [nameInput, codeInput] = container.querySelectorAll('input')
    fireEvent.change(nameInput, { target: { value: 'Dave' } })
    fireEvent.change(codeInput, { target: { value: 'ABCD' } })
    fireEvent.click(screen.getByText('加入'))
    expect(socketMock.emit).toHaveBeenCalledWith('joinRoom', { code: 'ABCD', name: 'Dave' })
  })

  it('名字為空時建立房間呼叫 onError，不 emit', () => {
    const onError = vi.fn()
    const { container } = render(<LobbyScreen myId="" gameState={null} onError={onError} />)
    fireEvent.click(container.querySelector('.btn-primary')!)
    expect(socketMock.emit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('請輸入名字')
  })

  it('名字為空時加入房間呼叫 onError，不 emit', () => {
    const onError = vi.fn()
    const { container } = render(<LobbyScreen myId="" gameState={null} onError={onError} />)
    fireEvent.click(screen.getByText('加入房間'))
    const [, codeInput] = container.querySelectorAll('input')
    fireEvent.change(codeInput, { target: { value: 'ABCD' } })
    fireEvent.click(screen.getByText('加入'))
    expect(socketMock.emit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('請輸入名字')
  })

  it('代碼不足 4 碼時加入呼叫 onError', () => {
    const onError = vi.fn()
    const { container } = render(<LobbyScreen myId="" gameState={null} onError={onError} />)
    fireEvent.click(screen.getByText('加入房間'))
    const [nameInput, codeInput] = container.querySelectorAll('input')
    fireEvent.change(nameInput, { target: { value: 'Dave' } })
    fireEvent.change(codeInput, { target: { value: 'AB' } })
    fireEvent.click(screen.getByText('加入'))
    expect(socketMock.emit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('房間代碼為 4 碼')
  })

  it('人數不足 3 人時開始按鈕 disabled', () => {
    const { container } = render(
      <LobbyScreen
        myId="p1"
        onError={vi.fn()}
        gameState={gameState({
          phase: 'LOBBY',
          players: {
            p1: player('p1', { name: 'Alice' }),
            p2: player('p2', { name: 'Bob' }),
          },
          playerOrder: ['p1', 'p2'],
        })}
      />
    )
    const startBtn = container.querySelector('.btn-primary') as HTMLButtonElement
    expect(startBtn.disabled).toBe(true)
  })

  it('在房間中顯示房間代碼', () => {
    render(
      <LobbyScreen
        myId="p1"
        onError={vi.fn()}
        gameState={gameState({
          phase: 'LOBBY',
          roomCode: 'XYZW',
          players: {
            p1: player('p1', { name: 'Alice' }),
            p2: player('p2', { name: 'Bob' }),
            p3: player('p3', { name: 'Casey' }),
          },
          playerOrder: ['p1', 'p2', 'p3'],
        })}
      />
    )
    expect(screen.getByText('XYZW')).toBeInTheDocument()
  })

  it('玩家清單中顯示所有玩家名字', () => {
    render(
      <LobbyScreen
        myId="p1"
        onError={vi.fn()}
        gameState={gameState({
          phase: 'LOBBY',
          players: {
            p1: player('p1', { name: 'Alice' }),
            p2: player('p2', { name: 'Bob' }),
            p3: player('p3', { name: 'Casey' }),
          },
          playerOrder: ['p1', 'p2', 'p3'],
        })}
      />
    )
    expect(screen.getByText(/Alice/)).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.getByText('Casey')).toBeInTheDocument()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// GameOverScreen – 遊戲結束顯示
// ══════════════════════════════════════════════════════════════════════════════

describe('GameOverScreen – end state display', () => {
  it('影響力相同時以血液為平局決定排名', () => {
    render(
      <GameOverScreen
        myId="p1"
        gameState={gameState({
          phase: 'GAME_OVER',
          winner: 'p2',
          players: {
            p1: player('p1', { name: 'Alice', influence: 5, blood: 3, clan: 'brujah' }),
            p2: player('p2', { name: 'Bob',   influence: 5, blood: 8, clan: 'ventrue' }),
          },
        })}
      />
    )
    const rows = document.querySelectorAll('.gameover__row')
    expect(rows[0]).toHaveTextContent('Bob')   // 更多血液
    expect(rows[1]).toHaveTextContent('Alice')
  })

  it('自己是勝者時顯示勝利標題', () => {
    render(
      <GameOverScreen
        myId="p1"
        gameState={gameState({
          phase: 'GAME_OVER',
          winner: 'p1',
          players: {
            p1: player('p1', { name: 'Alice', influence: 8, clan: 'brujah' }),
            p2: player('p2', { name: 'Bob',   influence: 4, clan: 'ventrue' }),
          },
        })}
      />
    )
    expect(screen.getByText('你成為了芝加哥的新王子！')).toBeInTheDocument()
  })

  it('他人是勝者時顯示勝者名稱', () => {
    render(
      <GameOverScreen
        myId="p2"
        gameState={gameState({
          phase: 'GAME_OVER',
          winner: 'p1',
          players: {
            p1: player('p1', { name: 'Alice', influence: 8, clan: 'brujah' }),
            p2: player('p2', { name: 'Bob',   influence: 4, clan: 'ventrue' }),
          },
        })}
      />
    )
    expect(screen.getByText('Alice 成為了芝加哥的新王子')).toBeInTheDocument()
  })

  it('三人遊戲時依影響力排序', () => {
    render(
      <GameOverScreen
        myId="p1"
        gameState={gameState({
          phase: 'GAME_OVER',
          winner: 'p3',
          players: {
            p1: player('p1', { name: 'Alice',  influence: 4, clan: 'brujah' }),
            p2: player('p2', { name: 'Bob',    influence: 7, clan: 'ventrue' }),
            p3: player('p3', { name: 'Casey',  influence: 9, clan: 'toreador' }),
          },
        })}
      />
    )
    const rows = document.querySelectorAll('.gameover__row')
    expect(rows[0]).toHaveTextContent('Casey')
    expect(rows[1]).toHaveTextContent('Bob')
    expect(rows[2]).toHaveTextContent('Alice')
  })

  it('有業報代幣的玩家在結果顯示業報圖示', () => {
    const { container } = render(
      <GameOverScreen
        myId="p1"
        gameState={gameState({
          phase: 'GAME_OVER',
          winner: 'p2',
          players: {
            p1: player('p1', { name: 'Alice', influence: 3, diablerie: 2, clan: 'brujah' }),
            p2: player('p2', { name: 'Bob',   influence: 7, diablerie: 0, clan: 'ventrue' }),
          },
        })}
      />
    )
    expect(container.querySelector('.gameover__diablerie')).toBeInTheDocument()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// PlayerHUD – 資訊顯示
// ══════════════════════════════════════════════════════════════════════════════

describe('PlayerHUD – stat display', () => {
  it('業報代幣 > 0 時顯示弒親統計', () => {
    const { container } = render(
      <PlayerHUD
        myId="p1"
        gameState={gameState({
          phase: 'PLANNING',
          players: {
            ...gameState().players,
            p1: { ...gameState().players.p1, diablerie: 1 },
          },
        })}
      />
    )
    expect(container.querySelector('.player-hud__stat--diablerie')).toBeInTheDocument()
  })

  it('業報代幣 ≥ 2 時顯示警告樣式', () => {
    const { container } = render(
      <PlayerHUD
        myId="p1"
        gameState={gameState({
          phase: 'PLANNING',
          players: {
            ...gameState().players,
            p1: { ...gameState().players.p1, diablerie: 2 },
          },
        })}
      />
    )
    expect(container.querySelector('.player-hud__stat--diab-warn')).toBeInTheDocument()
  })

  it('業報代幣為 0 時不顯示弒親統計', () => {
    const { container } = render(
      <PlayerHUD
        myId="p1"
        gameState={gameState({
          phase: 'PLANNING',
          players: {
            ...gameState().players,
            p1: { ...gameState().players.p1, diablerie: 0 },
          },
        })}
      />
    )
    expect(container.querySelector('.player-hud__stat--diablerie')).not.toBeInTheDocument()
  })

  it('同盟數量 > 0 時顯示同盟統計', () => {
    const { container } = render(
      <PlayerHUD
        myId="p1"
        gameState={gameState({
          phase: 'PLANNING',
          players: {
            ...gameState().players,
            p1: { ...gameState().players.p1, allianceCount: 3 },
          },
        })}
      />
    )
    expect(container.querySelector('.player-hud__stat--alliance')).toBeInTheDocument()
  })

  it('PLANNING 階段顯示部署數統計', () => {
    const { container } = render(
      <PlayerHUD
        myId="p1"
        gameState={gameState({
          phase: 'PLANNING',
          players: {
            ...gameState().players,
            p1: { ...gameState().players.p1, deploymentsLeft: 2 },
          },
        })}
      />
    )
    expect(container.querySelector('.player-hud__stat--deploys')).toBeInTheDocument()
  })

  it('非 PLANNING 階段不顯示部署數統計', () => {
    const { container } = render(
      <PlayerHUD
        myId="p1"
        gameState={gameState({ phase: 'REVELATION' })}
      />
    )
    expect(container.querySelector('.player-hud__stat--deploys')).not.toBeInTheDocument()
  })

  it('myId 不在玩家列表時回傳空元素', () => {
    const { container } = render(
      <PlayerHUD myId="unknown" gameState={gameState()} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
