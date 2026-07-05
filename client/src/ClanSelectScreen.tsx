import type { ClanId, GameStateClient } from '@kindred/shared'
import { useGameActions } from './convexGame'
import { CLANS, CLAN_ORDER } from './clans'
import WaitingPlayers from './WaitingPlayers'
import './ClanSelectScreen.css'

const CLAN_INFO: Record<ClanId, {
  archetype: string
  desc: string
  mechanic: string
}> = {
  brujah:    { archetype: '全攻快攻',     desc: '怒火與力量。以最快速度擊倒對手，血液即是武器。',           mechanic: '秘技：戰鬥牌可追加部署血液代幣，擊倒對手後竊取血液。' },
  nosferatu: { archetype: '情報控制',     desc: '潛伏於黑暗，掌握所有情報。讓敵人的計畫永遠失敗。',         mechanic: '秘技：部署免費且不顯示地點，可中途撤退並偷取對手血液。' },
  toreador:  { archetype: '同盟操控',     desc: '美麗是一種武器。操控人心，讓盟友為你拚命戰鬥。',           mechanic: '秘技：可結交跨氏族同盟，同盟牌分享影響力加成。' },
  tremere:   { archetype: '血液魔法爆發', desc: '血是魔法的根源。以神秘儀式將一滴血化為毀滅之力。',         mechanic: '秘技：犧牲自身血液施放強力咒術，可竊取敵方血液或影響力。' },
  malkavian: { archetype: '混亂干擾',     desc: '瘋狂本身就是力量。讓敵人的計畫在混沌中崩潰。',             mechanic: '秘技：可強制對手棄牌或重置部署，混亂技能在人多時效益倍增。' },
  gangrel:   { archetype: '耐久消耗',     desc: '野獸的血液流淌其中。在長期消耗戰中，永不倒下。',           mechanic: '秘技：受傷時觸發反擊，血量越低傷害越高，耗戰克制快攻。' },
  ventrue:   { archetype: '棋盤控制',     desc: '統治是天生的權利。控制每一個地點，讓敵人無處立足。',       mechanic: '秘技：可鎖定並獨佔地點影響力，阻止對手部署於同一地點。' },
}

interface Props {
  myId: string
  gameState: GameStateClient
}

export default function ClanSelectScreen({ myId, gameState }: Props) {
  const actions = useGameActions()
  const me = gameState.players[myId]
  const takenClans = new Set(
    Object.values(gameState.players)
      .filter(p => p.clan !== null)
      .map(p => p.clan as ClanId)
  )

  const waiting = gameState.waitingFor

  function pickClan(clan: ClanId) {
    if (me?.clan) return
    if (takenClans.has(clan)) return
    actions.selectClan(clan)
  }

  return (
    <div className="clan-select">
      <div className="clan-select__status">
        {me?.clan
          ? <span>你選擇了 <strong>{CLANS[me.clan].zh}</strong>，等待其他玩家…</span>
          : <span>選擇你的氏族</span>
        }
      </div>

      <div className="clan-grid">
        {CLAN_ORDER.map(clanId => {
          const info = CLAN_INFO[clanId]
          const clan = CLANS[clanId]
          const isTaken = takenClans.has(clanId)
          const isMine = me?.clan === clanId
          const takenBy = isTaken && !isMine
            ? Object.values(gameState.players).find(p => p.clan === clanId)?.name
            : null

          return (
            <button
              key={clanId}
              className={`clan-card ${isMine ? 'clan-card--mine' : ''} ${isTaken && !isMine ? 'clan-card--taken' : ''}`}
              style={{ '--clan-color': clan.color } as React.CSSProperties}
              onClick={() => pickClan(clanId)}
              disabled={isTaken || !!me?.clan}
            >
              <div className="clan-card__color-bar" />
              <div className="clan-card__image">
                <img src={`/assets/${clanId}/card_00.webp`} alt={`${clan.zh} 氏族卡牌`} />
              </div>
              <div className="clan-card__body">
                <div className="clan-card__name">{clan.zh}</div>
                <div className="clan-card__name-en">{clan.en}</div>
                <div className="clan-card__archetype">{info.archetype}</div>
                <div className="clan-card__desc">{info.desc}</div>
                <div className="clan-card__mechanic">{info.mechanic}</div>
                {takenBy && (
                  <div className="clan-card__taken-by">{takenBy} 已選擇</div>
                )}
                {isMine && (
                  <div className="clan-card__chosen">✓ 你的選擇</div>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {waiting.length > 0 && (
        <WaitingPlayers gameState={gameState} myId={myId} doneLabel="已選擇" />
      )}
    </div>
  )
}
