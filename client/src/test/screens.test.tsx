import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ClanSelectScreen from '../ClanSelectScreen'
import GameOverScreen from '../GameOverScreen'
import HandBuildScreen from '../HandBuildScreen'
import LobbyScreen from '../LobbyScreen'
import PlayerHUD from '../PlayerHUD'
import PlanningScreen from '../PlanningScreen'
import RevelationScreen from '../RevelationScreen'
import WithdrawScreen from '../WithdrawScreen'
import { card, gameState, player } from './fixtures'

// useGameActions() 回傳一個 Proxy：actions.selectClan('brujah') → emit('selectClan', 'brujah')。
// 讓所有既有的 `socketMock.emit).toHaveBeenCalledWith('event', payload)` 斷言原封不動。
const socketMock = vi.hoisted(() => ({
  emit: vi.fn(),
}))

vi.mock('../convexGame', () => ({
  useGameActions: () =>
    new Proxy({} as Record<string, (...a: unknown[]) => void>, {
      get: (_t, prop) =>
        typeof prop === 'string'
          ? (...args: unknown[]) => socketMock.emit(prop, ...args)
          : undefined,
    }),
}))

describe('ClanSelectScreen', () => {
  beforeEach(() => {
    socketMock.emit.mockClear()
  })

  it('emits selectClan when the player chooses an available clan', () => {
    render(
      <ClanSelectScreen
        myId="p1"
        gameState={gameState({
          phase: 'CLAN_SELECT',
          players: {
            p1: { ...gameState().players.p1, clan: null },
            p2: { ...gameState().players.p2, clan: 'ventrue' },
          },
          waitingFor: ['p1'],
        })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Brujah/i }))

    expect(socketMock.emit).toHaveBeenCalledWith('selectClan', 'brujah')
  })

  it('does not emit when the clan has already been taken', () => {
    render(
      <ClanSelectScreen
        myId="p1"
        gameState={gameState({
          phase: 'CLAN_SELECT',
          players: {
            p1: { ...gameState().players.p1, clan: null },
            p2: { ...gameState().players.p2, clan: 'brujah' },
          },
          waitingFor: ['p1'],
        })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Brujah/i }))

    expect(socketMock.emit).not.toHaveBeenCalled()
  })
})

describe('HandBuildScreen', () => {
  beforeEach(() => {
    socketMock.emit.mockClear()
  })

  it('emits selectHandCard after a draft card is selected and confirmed', () => {
    const draftCard = card({ id: 'BR02', name_en: "Punk's Posse", name_zh: "Punk's Posse" })
    const { container } = render(
      <HandBuildScreen
        myId="p1"
        gameState={gameState({
          phase: 'HAND_BUILD',
          myHand: [card({ id: 'BR09', name_en: 'Hunt', name_zh: 'Hunt', is_starter: true })],
          myHandBuildDraft: [draftCard],
          waitingFor: ['p1'],
        })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Punk's Posse/i }))
    fireEvent.click(container.querySelector('.handbuild__confirm-btn')!)

    expect(socketMock.emit).toHaveBeenCalledWith('selectHandCard', 'BR02')
  })
})

describe('PlanningScreen', () => {
  beforeEach(() => {
    socketMock.emit.mockClear()
  })

  it('emits submitDeployment after selecting a card, a location, and confirming the dialog', () => {
    const handCard = card({ id: 'BR01', name_en: 'Bloody Fury', name_zh: 'Bloody Fury' })
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={gameState({
          phase: 'PLANNING',
          myHand: [handCard],
          myBlood: 6,
          waitingFor: ['p1'],
          currentTurnPlayerId: 'p1',
          players: {
            p1: { ...gameState().players.p1, clan: 'brujah', deploymentsLeft: 1 },
            p2: { ...gameState().players.p2, clan: 'ventrue' },
          },
        })}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Bloody Fury/i }))
    fireEvent.click(screen.getByText('The Rack'))
    fireEvent.click(container.querySelector('.deploy-dialog .btn-primary')!)

    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', {
      locationId: 'rack',
      cardId: 'BR01',
      faceDown: false,
      bloodTokens: 0,
    })
  })

  it('emits a skip deployment after the player confirms skipping', () => {
    const { container } = render(
      <PlanningScreen
        myId="p1"
        gameState={gameState({
          phase: 'PLANNING',
          myHand: [],
          myBlood: 6,
          waitingFor: ['p1'],
          currentTurnPlayerId: 'p1',
          players: {
            p1: { ...gameState().players.p1, clan: 'brujah', deploymentsLeft: 1 },
            p2: { ...gameState().players.p2, clan: 'ventrue' },
          },
        })}
      />
    )

    fireEvent.click(container.querySelector('.planning__skip-btn')!)
    fireEvent.click(container.querySelector('.skip-confirm .btn-primary')!)

    expect(socketMock.emit).toHaveBeenCalledWith('submitDeployment', { skip: true })
  })
})

describe('RevelationScreen', () => {
  it('shows the current pending-choice location for non-choosing players instead of the previous result', () => {
    render(
      <RevelationScreen
        myId="p2"
        gameState={gameState({
          phase: 'REVELATION',
          currentLocIndex: 1,
          waitingFor: ['p1'],
          hasPendingChoices: true,
          myPendingChoice: null,
          lastConflictResults: [{
            locationId: 'rack',
            winner: 'p1',
            second: 'p2',
            scores: { p1: 6, p2: 2 },
            influenceGained: { p1: 1 },
            bloodEvents: [],
            stepEvents: { prepare: [], conflict: [], aftermath: [] },
            tie: false,
          }],
          deployments: {
            ...gameState().deployments,
            asylum: [{
              playerId: 'p1',
              cardId: 'MA01',
              faceDown: false,
              bloodTokensHidden: false,
              bloodTokens: 0,
              withdrawn: false,
              effectivePower: 0,
            }],
          },
        })}
      />
    )

    expect(screen.getByText('等待玩家選擇效果')).toBeInTheDocument()
    // LocationStrip 與戰場概覽都會列出地點名,取多筆確認存在
    expect(screen.getAllByText('The Asylum').length).toBeGreaterThan(0)
  })

  it('shows the server-synced active effect and highlights the active card slot', () => {
    const { container } = render(
      <RevelationScreen
        myId="p2"
        gameState={gameState({
          phase: 'REVELATION',
          activeEffect: {
            locationId: 'rack',
            step: 'conflict',
            sourceCardId: 'BR01',
            sourcePlayerName: 'Alice',
            text: 'Bloody Fury resolves now',
            delta: { power: 2 },
            eventIndex: 0,
            eventCount: 1,
          },
          lastConflictResults: [{
            locationId: 'rack',
            winner: 'p1',
            second: 'p2',
            scores: { p1: 8, p2: 4 },
            influenceGained: { p1: 1 },
            bloodEvents: [],
            stepEvents: {
              prepare: [],
              conflict: [{ text: 'Bloody Fury resolves now', sourceCardId: 'BR01', delta: { power: 2 } }],
              aftermath: [],
            },
            tie: false,
          }],
          deployments: {
            ...gameState().deployments,
            rack: [{
              playerId: 'p1',
              cardId: 'BR01',
              faceDown: false,
              bloodTokensHidden: false,
              bloodTokens: 0,
              withdrawn: false,
              effectivePower: 8,
            }],
          },
        })}
      />
    )

    expect(screen.getByText('Bloody Fury resolves now')).toBeInTheDocument()
    expect(container.querySelector('.active-effect--conflict')).toBeInTheDocument()
    expect(container.querySelector('.result-slot--current-effect')).toBeInTheDocument()
  })
})

describe('WithdrawScreen', () => {
  beforeEach(() => {
    socketMock.emit.mockClear()
  })

  it('emits submitWithdraw for the current location after the player chooses to stay', () => {
    const { container } = render(
      <WithdrawScreen
        myId="p1"
        gameState={gameState({
          phase: 'WITHDRAW',
          currentLocIndex: 0,
          waitingFor: ['p1'],
          deployments: {
            ...gameState().deployments,
            rack: [{
              playerId: 'p1',
              cardId: 'BR01',
              faceDown: true,
              bloodTokensHidden: true,
              bloodTokens: 2,
              withdrawn: false,
              effectivePower: null,
            }],
          },
        })}
      />
    )

    fireEvent.click(container.querySelector('.wd-btn--stay, .wd-btn')!)
    fireEvent.click(container.querySelector('.withdraw__submit')!)

    expect(socketMock.emit).toHaveBeenCalledWith('submitWithdraw', {
      locationId: 'rack',
      withdraw: false,
    })
  })

  it('renders an empty withdrawal state when the current location index is invalid', () => {
    const { container } = render(
      <WithdrawScreen
        myId="p1"
        gameState={gameState({ phase: 'WITHDRAW', currentLocIndex: 99 })}
      />
    )

    expect(container.querySelector('.withdraw__header')).toBeInTheDocument()
    expect(container.querySelector('.withdraw__submit')).not.toBeInTheDocument()
  })
})

describe('LobbyScreen', () => {
  beforeEach(() => {
    socketMock.emit.mockClear()
  })

  it('emits createRoom with the entered player name', () => {
    const onError = vi.fn()
    const { container } = render(<LobbyScreen myId="" gameState={null} onError={onError} />)

    fireEvent.change(container.querySelector('input')!, { target: { value: 'Casey' } })
    fireEvent.click(container.querySelector('.btn-primary')!)

    expect(socketMock.emit).toHaveBeenCalledWith('createRoom', { name: 'Casey' })
    expect(onError).not.toHaveBeenCalled()
  })

  it('lets the host start once the room has at least three players', () => {
    const { container } = render(
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

    fireEvent.click(container.querySelector('.btn-primary')!)

    expect(socketMock.emit).toHaveBeenCalledWith('readyStart')
  })
})

describe('PlayerHUD', () => {
  it('shows the current player stats and stays empty for an unknown player id', () => {
    const { container, rerender } = render(
      <PlayerHUD
        myId="p1"
        gameState={gameState({
          phase: 'PLANNING',
          myBlood: 5,
          players: {
            ...gameState().players,
            p1: { ...gameState().players.p1, handCount: 2, allianceCount: 1, diablerie: 1, deploymentsLeft: 2 },
          },
        })}
      />
    )

    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(container.querySelector('.player-hud__stat--deploys')).toBeInTheDocument()

    rerender(<PlayerHUD myId="missing" gameState={gameState()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('GameOverScreen', () => {
  it('orders players by influence and shows the winner', () => {
    render(
      <GameOverScreen
        myId="p1"
        gameState={gameState({
          phase: 'GAME_OVER',
          winner: 'p2',
          players: {
            p1: player('p1', { name: 'Alice', influence: 4, blood: 6, clan: 'brujah' }),
            p2: player('p2', { name: 'Bob', influence: 7, blood: 1, clan: 'ventrue' }),
            p3: player('p3', { name: 'Casey', influence: 2, blood: 8, clan: 'toreador' }),
          },
        })}
      />
    )

    const rows = document.querySelectorAll('.gameover__row')
    expect(rows[0]).toHaveTextContent('Bob')
    expect(rows[1]).toHaveTextContent('Alice')
    expect(rows[2]).toHaveTextContent('Casey')
  })
})
