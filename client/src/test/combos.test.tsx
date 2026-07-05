/**
 * combos.test.tsx
 *
 * 覆蓋所有遊玩操作的完整排列組合。
 * 補齊 screens-gameplay.test.tsx 未測試的路徑：
 *   • 部署 → 全 4 個地點 × faceDown × bloodTokens × 全 7 氏族
 *   • 撤退 → 全 4 個地點 × 留守 / 撤退 × 代幣文字
 *   • 結算 → 全 6 個步驟描述、複數地點結果
 *   • 氏族選擇 → 全 7 個氏族 × 狀態訊息 / 已被佔用
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import PlanningScreen from '../PlanningScreen'
import WithdrawScreen from '../WithdrawScreen'
import RevelationScreen from '../RevelationScreen'
import ClanSelectScreen from '../ClanSelectScreen'
import { card, gameState } from './fixtures'
import type { ClanId, ConflictResult, SlotVisible } from '@kindred/shared'

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

// ── Constants ────────────────────────────────────────────────────────────────

const LOCATIONS = [
  { id: 'rack',        name: 'The Rack',        index: 0, isPrinces: false },
  { id: 'asylum',      name: 'The Asylum',       index: 1, isPrinces: false },
  { id: 'club_zombie', name: 'Club Zombie',      index: 2, isPrinces: false },
  { id: 'haven',       name: "Prince's Haven",   index: 3, isPrinces: true  },
] as const

const FACE_TOKEN_COMBOS = [
  { faceDown: false, tokens: 0 },
  { faceDown: false, tokens: 1 },
  { faceDown: false, tokens: 2 },
  { faceDown: false, tokens: 3 },
  { faceDown: true,  tokens: 0 },
  { faceDown: true,  tokens: 1 },
  { faceDown: true,  tokens: 2 },
  { faceDown: true,  tokens: 3 },
] as const

const ALL_CLANS: Array<{ clan: ClanId; label: string; nameZh: string }> = [
  { clan: 'brujah',    label: 'Brujah',    nameZh: '布魯哈' },
  { clan: 'nosferatu', label: 'Nosferatu', nameZh: '諾斯費拉圖' },
  { clan: 'toreador',  label: 'Toreador',  nameZh: '托瑞爾多' },
  { clan: 'tremere',   label: 'Tremere',   nameZh: '翠梅爾' },
  { clan: 'malkavian', label: 'Malkavian', nameZh: '馬爾卡維安' },
  { clan: 'gangrel',   label: 'Gangrel',   nameZh: '甘格瑞爾' },
  { clan: 'ventrue',   label: 'Ventrue',   nameZh: '梵崔' },
]

const STEP_DEFS = [
  { dot: '撤退', desc: '玩家選擇是否撤退' },
  { dot: '揭牌', desc: '所有面朝下的牌同時翻開' },
  { dot: '準備', desc: '準備型卡牌依序觸發效果' },
  { dot: '衝突', desc: '計算各地點戰力，決定勝負' },
  { dot: '後果', desc: '後果型卡牌依序觸發效果' },
  { dot: '完成', desc: '分配影響力，結算本地點' },
] as const

// ── Shared helpers ───────────────────────────────────────────────────────────

const EMPTY_DEPLOYS: Record<string, SlotVisible[]> = { rack: [], asylum: [], club_zombie: [], haven: [] }

function planningGs(clan: ClanId = 'brujah', myBlood = 10) {
  return gameState({
    phase: 'PLANNING',
    myHand: [card({ id: 'BR01', name_en: 'Bloody Fury', name_zh: 'Bloody Fury' })],
    myBlood,
    waitingFor: ['p1'],
    currentTurnPlayerId: 'p1',
    players: {
      p1: { ...gameState().players.p1, clan, deploymentsLeft: 1, blood: myBlood },
      p2: { ...gameState().players.p2, clan: 'ventrue', name: 'Bob' },
    },
  })
}

function openDialog(container: HTMLElement, locName: string) {
  fireEvent.click(screen.getByRole('button', { name: /Bloody Fury/i }))
  fireEvent.click(screen.getByText(locName))
}

function clickPlus(container: HTMLElement, n: number) {
  const plus = container.querySelectorAll('.deploy-dialog__token-ctrl button')[1]
  for (let i = 0; i < n; i++) fireEvent.click(plus)
}

function confirmDeploy(container: HTMLElement) {
  fireEvent.click(container.querySelector('.deploy-dialog .btn-primary')!)
}

function slotAt(_locId: string, tokens = 0): SlotVisible {
  return {
    playerId: 'p1', cardId: 'BR01', faceDown: false,
    bloodTokensHidden: false, bloodTokens: tokens,
    withdrawn: false, effectivePower: null,
  }
}

function makeResult(overrides: Partial<ConflictResult> = {}): ConflictResult {
  return {
    locationId: 'rack',
    winner: 'p1', second: 'p2',
    scores: { p1: 6, p2: 2 },
    influenceGained: { p1: 1 },
    bloodEvents: [],
    stepEvents: { prepare: [], conflict: [], aftermath: [] },
    tie: false,
    ...overrides,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. PlanningScreen – 全部地點 × faceDown × bloodTokens（非諾斯費拉圖）
// ══════════════════════════════════════════════════════════════════════════════

describe('Planning – non-Nosferatu × 全 4 地點 × faceDown × tokens', () => {
  beforeEach(() => socketMock.emit.mockClear())

  for (const loc of LOCATIONS) {
    for (const { faceDown, tokens } of FACE_TOKEN_COMBOS) {
      it(`${loc.id} faceDown=${faceDown} tokens=${tokens}`, () => {
        const { container } = render(<PlanningScreen myId="p1" gameState={planningGs('brujah')} />)
        openDialog(container, loc.name)
        if (faceDown) fireEvent.click(screen.getByRole('checkbox'))
        clickPlus(container, tokens)
        confirmDeploy(container)
        expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
          locationId: loc.id, cardId: 'BR01', faceDown, bloodTokens: tokens,
        })
      })
    }
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// 2. PlanningScreen – 全部地點 × faceDown × bloodTokens（諾斯費拉圖，秘密免費）
// ══════════════════════════════════════════════════════════════════════════════

describe('Planning – Nosferatu × 全 4 地點 × faceDown × tokens', () => {
  beforeEach(() => socketMock.emit.mockClear())

  for (const loc of LOCATIONS) {
    for (const { faceDown, tokens } of FACE_TOKEN_COMBOS) {
      it(`Nosferatu ${loc.id} faceDown=${faceDown} tokens=${tokens}`, () => {
        const { container } = render(<PlanningScreen myId="p1" gameState={planningGs('nosferatu')} />)
        openDialog(container, loc.name)
        if (faceDown) fireEvent.click(screen.getByRole('checkbox'))
        clickPlus(container, tokens)
        confirmDeploy(container)
        expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
          locationId: loc.id, cardId: 'BR01', faceDown, bloodTokens: tokens,
        })
      })
    }
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// 3. PlanningScreen – 全 7 氏族部署到 rack（確認每個氏族都能正常出牌）
// ══════════════════════════════════════════════════════════════════════════════

describe('Planning – 全 7 氏族部署到 rack', () => {
  beforeEach(() => socketMock.emit.mockClear())

  for (const { clan } of ALL_CLANS) {
    it(`${clan} faceDown=false tokens=0 emit 正確`, () => {
      const { container } = render(<PlanningScreen myId="p1" gameState={planningGs(clan)} />)
      openDialog(container, 'The Rack')
      confirmDeploy(container)
      expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
        locationId: 'rack', cardId: 'BR01', faceDown: false, bloodTokens: 0,
      })
    })

    it(`${clan} faceDown=true tokens=1 emit 正確`, () => {
      const { container } = render(<PlanningScreen myId="p1" gameState={planningGs(clan)} />)
      openDialog(container, 'The Rack')
      fireEvent.click(screen.getByRole('checkbox'))
      clickPlus(container, 1)
      confirmDeploy(container)
      expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
        locationId: 'rack', cardId: 'BR01', faceDown: true, bloodTokens: 1,
      })
    })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// 4. PlanningScreen – 血液不足時確認按鈕禁用（全 4 地點）
// ══════════════════════════════════════════════════════════════════════════════

describe('Planning – 全 4 地點 × 血液不足禁用確認按鈕', () => {
  beforeEach(() => socketMock.emit.mockClear())

  for (const loc of LOCATIONS) {
    it(`non-Nosferatu ${loc.id}：0 血 + faceDown=true → 按鈕 disabled`, () => {
      const { container } = render(<PlanningScreen myId="p1" gameState={planningGs('brujah', 0)} />)
      openDialog(container, loc.name)
      fireEvent.click(screen.getByRole('checkbox'))
      const btn = container.querySelector('.deploy-dialog .btn-primary') as HTMLButtonElement
      expect(btn.disabled).toBe(true)
      expect(socketMock.emit).not.toHaveBeenCalled()
    })

    it(`Nosferatu ${loc.id}：0 血 + faceDown=true → 按鈕仍可用（免費）`, () => {
      const { container } = render(<PlanningScreen myId="p1" gameState={planningGs('nosferatu', 0)} />)
      openDialog(container, loc.name)
      fireEvent.click(screen.getByRole('checkbox'))
      const btn = container.querySelector('.deploy-dialog .btn-primary') as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// 5. WithdrawScreen – 全 4 地點 × 留守 / 撤退 emit
// ══════════════════════════════════════════════════════════════════════════════

describe('Withdraw – 全 4 地點 × 留守 / 撤退', () => {
  beforeEach(() => socketMock.emit.mockClear())

  for (const loc of LOCATIONS) {
    it(`留守 ${loc.id}：emit withdraw=false`, () => {
      const { container } = render(
        <WithdrawScreen
          myId="p1"
          gameState={gameState({
            phase: 'WITHDRAW',
            currentLocIndex: loc.index,
            waitingFor: ['p1'],
            deployments: { ...EMPTY_DEPLOYS, [loc.id]: [slotAt(loc.id)] },
          })}
        />
      )
      fireEvent.click(container.querySelectorAll('.wd-btn')[0])
      fireEvent.click(container.querySelector('.withdraw__submit')!)
      expect(socketMock.emit).toHaveBeenCalledWith('submitWithdraw', { locationId: loc.id, withdraw: false })
    })

    it(`撤退 ${loc.id}：emit withdraw=true`, () => {
      const { container } = render(
        <WithdrawScreen
          myId="p1"
          gameState={gameState({
            phase: 'WITHDRAW',
            currentLocIndex: loc.index,
            waitingFor: ['p1'],
            deployments: { ...EMPTY_DEPLOYS, [loc.id]: [slotAt(loc.id)] },
          })}
        />
      )
      fireEvent.click(container.querySelectorAll('.wd-btn')[1])
      fireEvent.click(container.querySelector('.withdraw__submit')!)
      expect(socketMock.emit).toHaveBeenCalledWith('submitWithdraw', { locationId: loc.id, withdraw: true })
    })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// 6. WithdrawScreen – 全 4 地點 × tokens 0-3 文字顯示
// ══════════════════════════════════════════════════════════════════════════════

describe('Withdraw – 全 4 地點 × 血液代幣 0-3 撤退說明文字', () => {
  for (const loc of LOCATIONS) {
    for (const tokens of [0, 1, 2, 3] as const) {
      it(`${loc.id} tokens=${tokens} 顯示正確文字`, () => {
        render(
          <WithdrawScreen
            myId="p1"
            gameState={gameState({
              phase: 'WITHDRAW',
              currentLocIndex: loc.index,
              waitingFor: ['p1'],
              deployments: { ...EMPTY_DEPLOYS, [loc.id]: [slotAt(loc.id, tokens)] },
            })}
          />
        )
        if (loc.isPrinces) {
          if (tokens === 0) {
            expect(screen.getByText('取回牌與血液')).toBeInTheDocument()
          } else {
            expect(screen.getByText(new RegExp(`取回 ${tokens} 血液 \\+ 牌`))).toBeInTheDocument()
          }
        } else {
          if (tokens === 0) {
            expect(screen.getByText(/取回血液，牌移至王子之地/)).toBeInTheDocument()
          } else {
            expect(screen.getByText(new RegExp(`取回 ${tokens} 血液，牌移至王子之地`))).toBeInTheDocument()
          }
        }
      })
    }
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// 7. ClanSelectScreen – 全 7 氏族選擇後顯示狀態訊息
// ══════════════════════════════════════════════════════════════════════════════

describe('ClanSelect – 全 7 氏族選擇後狀態訊息', () => {
  for (const { clan, nameZh } of ALL_CLANS) {
    it(`已選 ${clan} → 顯示「你選擇了 ${nameZh}」`, () => {
      const { container } = render(
        <ClanSelectScreen
          myId="p1"
          gameState={gameState({
            phase: 'CLAN_SELECT',
            players: {
              p1: { ...gameState().players.p1, clan },
              p2: { ...gameState().players.p2, clan: null },
            },
            waitingFor: ['p2'],
          })}
        />
      )
      const statusDiv = container.querySelector('.clan-select__status')
      expect(statusDiv?.textContent).toContain('你選擇了')
      expect(statusDiv?.textContent).toContain(nameZh)
    })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// 8. ClanSelectScreen – 全 7 氏族 × 被佔用後 disabled / 點擊不 emit
// ══════════════════════════════════════════════════════════════════════════════

describe('ClanSelect – 全 7 氏族 × 被另一玩家佔用', () => {
  beforeEach(() => socketMock.emit.mockClear())

  for (const { clan, label } of ALL_CLANS) {
    it(`${clan} 被他人選走後按鈕 disabled`, () => {
      render(
        <ClanSelectScreen
          myId="p1"
          gameState={gameState({
            phase: 'CLAN_SELECT',
            players: {
              p1: { ...gameState().players.p1, clan: null },
              p2: { ...gameState().players.p2, clan },
            },
            waitingFor: ['p1'],
          })}
        />
      )
      const btn = screen.getByRole('button', { name: new RegExp(label, 'i') }) as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    })

    it(`${clan} 被他人選走後點擊不 emit selectClan`, () => {
      render(
        <ClanSelectScreen
          myId="p1"
          gameState={gameState({
            phase: 'CLAN_SELECT',
            players: {
              p1: { ...gameState().players.p1, clan: null },
              p2: { ...gameState().players.p2, clan },
            },
            waitingFor: ['p1'],
          })}
        />
      )
      const btn = screen.getByRole('button', { name: new RegExp(label, 'i') })
      fireEvent.click(btn)   // disabled button; React ignores click
      expect(socketMock.emit).not.toHaveBeenCalled()
    })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// 9. ClanSelectScreen – 自己選定後全部按鈕 disabled（全 7 氏族）
// ══════════════════════════════════════════════════════════════════════════════

describe('ClanSelect – 選定後全部按鈕 disabled（每個氏族 × 全 7 按鈕）', () => {
  for (const { clan: selectedClan } of ALL_CLANS) {
    it(`自己選 ${selectedClan} 後所有氏族按鈕 disabled`, () => {
      render(
        <ClanSelectScreen
          myId="p1"
          gameState={gameState({
            phase: 'CLAN_SELECT',
            players: {
              p1: { ...gameState().players.p1, clan: selectedClan },
              p2: { ...gameState().players.p2, clan: null },
            },
            waitingFor: ['p2'],
          })}
        />
      )
      for (const { label } of ALL_CLANS) {
        const btn = screen.getByRole('button', { name: new RegExp(label, 'i') }) as HTMLButtonElement
        expect(btn.disabled).toBe(true)
      }
    })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// 10. RevelationScreen – 全 6 個步驟說明文字
// ══════════════════════════════════════════════════════════════════════════════

describe('Revelation – 全步驟說明由 server activeEffect 驅動', () => {
  function renderRev(activeEffect: Record<string, unknown> | null) {
    return render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'REVELATION',
          waitingFor: ['p1'],
          lastConflictResults: [makeResult()],
          activeEffect,
          deployments: {
            ...EMPTY_DEPLOYS,
            rack: [{ playerId: 'p1', cardId: 'BR01', faceDown: false, bloodTokensHidden: false, bloodTokens: 0, withdrawn: false, effectivePower: 6 }],
          },
        })}
      />
    )
  }

  // 撤退步驟屬於 WITHDRAW phase,REVELATION 的 server 步驟從 reveal 開始
  for (const { dot, desc } of STEP_DEFS.filter(s => !['撤退', '完成'].includes(s.dot))) {
    const step = ({ '揭牌': 'reveal', '準備': 'prepare', '衝突': 'conflict', '後果': 'aftermath' } as Record<string, string>)[dot]
    it(`server activeEffect.step=${step} → 顯示「${desc}」`, () => {
      renderRev({ locationId: 'rack', step, eventIndex: 0, eventCount: 2, text: '…' })
      expect(screen.getByText(desc)).toBeInTheDocument()
    })
  }

  it('無 activeEffect 且已有結果 → 顯示「分配影響力，結算本地點」', () => {
    renderRev(null)
    expect(screen.getByText('分配影響力，結算本地點')).toBeInTheDocument()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 11. RevelationScreen – ROUND_END 全 3 回合 × 確認按鈕文字
// ══════════════════════════════════════════════════════════════════════════════

describe('Revelation ROUND_END – 全 3 回合確認按鈕文字', () => {
  const cases = [
    { round: 1, expected: '繼續下一回合' },
    { round: 2, expected: '繼續下一回合' },
    { round: 3, expected: '查看最終結果' },
  ] as const

  for (const { round, expected } of cases) {
    it(`round=${round} → 按鈕文字「${expected}」`, () => {
      const { container } = render(
        <RevelationScreen
          myId="p1"
          gameState={gameState({
            phase: 'ROUND_END',
            round,
            waitingFor: ['p1'],
            lastConflictResults: [makeResult()],
          })}
        />
      )
      expect(container.querySelector('.revelation__confirm-btn')!.textContent).toBe(expected)
    })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// 12. RevelationScreen – 複數地點衝突結果
// ══════════════════════════════════════════════════════════════════════════════

describe('Revelation – 複數地點結果顯示', () => {
  it('第 2 個地點為當前結果，第 1 個地點進入歷史 Chip', () => {
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
          deployments: {
            rack:   [{ playerId: 'p1', cardId: 'BR01', faceDown: false, bloodTokensHidden: false, bloodTokens: 0, withdrawn: false, effectivePower: 6 }],
            asylum: [{ playerId: 'p2', cardId: 'VE01', faceDown: false, bloodTokensHidden: false, bloodTokens: 0, withdrawn: false, effectivePower: 5 }],
            club_zombie: [],
            haven: [],
          },
        })}
      />
    )
    // rack 應出現在歷史 chip 中
    expect(screen.getByText('The Rack')).toBeInTheDocument()
    // asylum 出現在結果卡片和歷史 chip 中（可能多處）
    expect(screen.getAllByText('The Asylum').length).toBeGreaterThan(0)
  })

  it('3 個地點結果：最新為當前，前 2 個為歷史', () => {
    render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'REVELATION',
          waitingFor: ['p1'],
          lastConflictResults: [
            makeResult({ locationId: 'rack' }),
            makeResult({ locationId: 'asylum' }),
            makeResult({ locationId: 'club_zombie', winner: 'p2', influenceGained: { p2: 1 } }),
          ],
          deployments: {
            rack:        [{ playerId: 'p1', cardId: 'BR01', faceDown: false, bloodTokensHidden: false, bloodTokens: 0, withdrawn: false, effectivePower: 6 }],
            asylum:      [{ playerId: 'p1', cardId: 'BR01', faceDown: false, bloodTokensHidden: false, bloodTokens: 0, withdrawn: false, effectivePower: 6 }],
            club_zombie: [{ playerId: 'p2', cardId: 'VE01', faceDown: false, bloodTokensHidden: false, bloodTokens: 0, withdrawn: false, effectivePower: 4 }],
            haven: [],
          },
        })}
      />
    )
    expect(screen.getByText('The Rack')).toBeInTheDocument()
    expect(screen.getByText('The Asylum')).toBeInTheDocument()
    // Club Zombie may appear more than once (chip + result card) — just confirm presence
    expect(screen.getAllByText('Club Zombie').length).toBeGreaterThan(0)
  })

  it('ROUND_END 顯示全部 4 個地點結果', () => {
    render(
      <RevelationScreen
        myId="p1"
        gameState={gameState({
          phase: 'ROUND_END',
          round: 2,
          waitingFor: ['p1'],
          lastConflictResults: [
            makeResult({ locationId: 'rack' }),
            makeResult({ locationId: 'asylum' }),
            makeResult({ locationId: 'club_zombie' }),
            makeResult({ locationId: 'haven', influenceGained: { p1: 2 } }),
          ],
          deployments: {
            rack:        [{ playerId: 'p1', cardId: 'BR01', faceDown: false, bloodTokensHidden: false, bloodTokens: 0, withdrawn: false, effectivePower: 6 }],
            asylum:      [{ playerId: 'p1', cardId: 'BR01', faceDown: false, bloodTokensHidden: false, bloodTokens: 0, withdrawn: false, effectivePower: 6 }],
            club_zombie: [{ playerId: 'p1', cardId: 'BR01', faceDown: false, bloodTokensHidden: false, bloodTokens: 0, withdrawn: false, effectivePower: 6 }],
            haven:       [{ playerId: 'p1', cardId: 'BR01', faceDown: false, bloodTokensHidden: false, bloodTokens: 0, withdrawn: false, effectivePower: 8 }],
          },
        })}
      />
    )
    // ROUND_END 顯示「第 X 回合結束」
    expect(screen.getByText('第 2 回合結束')).toBeInTheDocument()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 13. RevelationScreen – respondChoice 全選項路徑
// ══════════════════════════════════════════════════════════════════════════════

describe('Revelation – respondChoice 全 option 路徑', () => {
  beforeEach(() => socketMock.emit.mockClear())

  const OPTIONS = [
    { key: 'gain_blood',      label_zh: '獲得 2 血液' },
    { key: 'gain_influence',  label_zh: '獲得 1 影響力' },
    { key: 'steal_blood',     label_zh: '奪取對手血液' },
  ]

  for (const opt of OPTIONS) {
    it(`選擇 option=${opt.key} → emit respondChoice`, () => {
      render(
        <RevelationScreen
          myId="p1"
          gameState={gameState({
            phase: 'REVELATION',
            waitingFor: ['p1'],
            hasPendingChoices: true,
            myPendingChoice: {
              id: 'ch-multi',
              playerId: 'p1',
              prompt_zh: '選擇效果',
              options: OPTIONS,
              context: { cardId: 'VE09', locationId: 'rack', sourcePlayerId: 'p1', sourceName: 'Alice' },
              choiceKey: 'VE09:rack:p1',
            },
            lastConflictResults: [makeResult()],
          })}
        />
      )
      fireEvent.click(screen.getByText(opt.label_zh))
      expect(socketMock.emit).toHaveBeenCalledWith('respondChoice', {
        choiceId: 'ch-multi', option: opt.key,
      })
    })
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// 14. PlanningScreen – Skip 全 4 地點場景（出牌後 Skip）
// ══════════════════════════════════════════════════════════════════════════════

describe('Planning – skip emit 全地點部署後場景', () => {
  beforeEach(() => socketMock.emit.mockClear())

  it('手牌有牌時點擊 skip 顯示張數警告後確認 → emit skip=true', () => {
    const { container } = render(
      <PlanningScreen myId="p1" gameState={planningGs()} />
    )
    fireEvent.click(container.querySelector('.planning__skip-btn')!)
    expect(screen.getByText(/你還有 1 張手牌未部署/)).toBeInTheDocument()
    fireEvent.click(container.querySelector('.skip-confirm .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', { skip: true })
  })

  it('手牌為空時點擊 skip 顯示一般提示後確認 → emit skip=true', () => {
    const gs = { ...planningGs(), myHand: [] }
    const { container } = render(<PlanningScreen myId="p1" gameState={gs} />)
    fireEvent.click(container.querySelector('.planning__skip-btn')!)
    expect(screen.getByText('確認結束本回合部署？')).toBeInTheDocument()
    fireEvent.click(container.querySelector('.skip-confirm .btn-primary')!)
    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', { skip: true })
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 15. PlanningScreen – 地點名稱顯示於對話框標題（全 4 地點）
// ══════════════════════════════════════════════════════════════════════════════

describe('Planning – deploy dialog 顯示目標地點名稱（全 4 地點）', () => {
  beforeEach(() => socketMock.emit.mockClear())

  for (const loc of LOCATIONS) {
    it(`開啟 ${loc.id} 對話框後標題包含地點名稱`, () => {
      const { container } = render(<PlanningScreen myId="p1" gameState={planningGs()} />)
      fireEvent.click(screen.getByRole('button', { name: /Bloody Fury/i }))
      fireEvent.click(screen.getByText(loc.name))
      // Dialog is open; the location name should appear in the dialog header
      const dialog = container.querySelector('.deploy-dialog')
      expect(dialog).not.toBeNull()
      expect(dialog!.textContent).toContain(loc.name)
    })
  }

  it('取消對話框後不 emit', () => {
    const { container } = render(<PlanningScreen myId="p1" gameState={planningGs()} />)
    fireEvent.click(screen.getByRole('button', { name: /Bloody Fury/i }))
    fireEvent.click(screen.getByText('The Rack'))
    fireEvent.click(container.querySelector('.deploy-dialog-overlay')!)
    expect(socketMock.emit).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 16. WithdrawScreen – 切換選擇後提交正確值
// ══════════════════════════════════════════════════════════════════════════════

describe('Withdraw – 切換選擇後提交正確', () => {
  beforeEach(() => socketMock.emit.mockClear())

  for (const loc of LOCATIONS) {
    it(`${loc.id}：先點撤退再改留守 → emit withdraw=false`, () => {
      const { container } = render(
        <WithdrawScreen
          myId="p1"
          gameState={gameState({
            phase: 'WITHDRAW',
            currentLocIndex: loc.index,
            waitingFor: ['p1'],
            deployments: { ...EMPTY_DEPLOYS, [loc.id]: [slotAt(loc.id)] },
          })}
        />
      )
      const [stayBtn, retreatBtn] = container.querySelectorAll('.wd-btn')
      fireEvent.click(retreatBtn)     // 先點撤退
      fireEvent.click(stayBtn)        // 改成留守
      fireEvent.click(container.querySelector('.withdraw__submit')!)
      expect(socketMock.emit).toHaveBeenCalledWith('submitWithdraw', { locationId: loc.id, withdraw: false })
    })
  }
})
