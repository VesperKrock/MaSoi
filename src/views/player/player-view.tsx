import { useEffect, useState } from 'react'
import { playerLabel } from '../../components/player-label'
import type { RoomCommand } from '../../domain/game/types'
import type {
  PlayerActionSnapshot,
  PlayerRoomSnapshot,
} from '../../state/room-projection'
import { PlayerEndMatch } from '../end-match/end-match-view'

interface PlayerViewProps {
  snapshot: PlayerRoomSnapshot
  dispatch: (command: RoomCommand) => Promise<boolean>
  homeHref: string
}

type PlayerGameplayProps = Pick<PlayerViewProps, 'snapshot' | 'dispatch'>

function useCountdownSeconds(deadlineAt: number | undefined) {
  const [seconds, setSeconds] = useState(() =>
    deadlineAt ? Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)) : 0,
  )
  useEffect(() => {
    if (!deadlineAt) return
    const tick = () =>
      setSeconds(Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)))
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [deadlineAt])
  return seconds
}

function PlayerLobby({ snapshot }: { snapshot: PlayerRoomSnapshot }) {
  return (
    <section className="player-center player-lobby">
      <p className="eyebrow">Phòng {snapshot.roomCode}</p>
      <div className="lobby-check" aria-hidden="true">✓</div>
      <h1>Đã vào phòng.</h1>
      <p>{snapshot.self.alias}</p>
      <small>
        {snapshot.players.length} / {snapshot.seatCount} người · Chờ Quản trò bắt đầu.
      </small>
    </section>
  )
}

function RoleIdentityCard({
  snapshot,
  mode,
  onClose,
  dispatch,
}: PlayerGameplayProps & { mode: 'REVEAL' | 'RECHECK'; onClose?: () => void }) {
  const role = snapshot.roleIdentity
  if (!role) return null

  const close = () => {
    if (mode === 'RECHECK') {
      onClose?.()
    } else {
      void dispatch({
        type: 'CONFIRM_ROLE_REVEAL',
        playerId: snapshot.self.id,
      })
    }
  }

  return (
    <section className="role-identity-surface">
      <p className="eyebrow">
        {mode === 'REVEAL' ? 'Vai trò bí mật của bạn' : 'Xem lại vai trò'}
      </p>
      <div className="role-art-frame">
        <img src={role.cardAsset} alt={`Lá bài ${role.displayName}`} />
      </div>
      <div className="role-identity-caption">
        <strong>{role.displayName}</strong>
        <span>Phe: {role.factionMeaning}</span>
        {mode === 'RECHECK' && snapshot.loverRelationship && (
          <small>
            Người Yêu: {playerLabel(snapshot.loverRelationship.partner)}
          </small>
        )}
      </div>
      <button className="button primary full" onClick={close} data-required-control>
        {mode === 'REVEAL' ? 'Đã nhớ vai trò · Úp máy' : 'Đóng · Úp máy'}
      </button>
    </section>
  )
}

function NeutralScreen({
  snapshot,
  onRecheck,
}: {
  snapshot: PlayerRoomSnapshot
  onRecheck: () => void
}) {
  const waitingForStart = snapshot.lifecycle === 'ROLE_REVEAL'
  const hunterPending =
    snapshot.phase === 'DAY' &&
    snapshot.dayVote?.result?.hunterRevealed &&
    snapshot.dayVote.result.hunterRevengeStatus === 'PENDING'
  const copy = hunterPending
    ? {
        eyebrow: `NGÀY ${snapshot.dayNumber} · KẾT QUẢ TREO CỔ`,
        title: 'THỢ SĂN BỊ TREO CỔ.',
        body: `${snapshot.dayVote?.result?.hangedPlayer?.alias ?? 'Thợ Săn'} đang chọn người đi cùng.`,
      }
    : !snapshot.self.alive
    ? {
        eyebrow:
          snapshot.phase === 'DAY'
            ? `NGÀY ${snapshot.dayNumber}`
            : `ĐÊM ${snapshot.dayNumber}`,
        title: 'Bạn đã chết.',
        body: 'Hãy úp điện thoại xuống và tiếp tục theo dõi bàn chơi.',
      }
    : waitingForStart
    ? {
        eyebrow: `PHÒNG ${snapshot.roomCode}`,
        title: 'Đã nhớ vai trò.',
        body: 'Chờ Quản trò bắt đầu.',
      }
    : snapshot.phase === 'NIGHT'
      ? {
          eyebrow: `ĐÊM ${snapshot.dayNumber}`,
          title: 'Hãy úp điện thoại xuống.',
          body: 'Lắng nghe Quản trò.',
        }
      : snapshot.phase === 'DAY'
        ? {
            eyebrow: `NGÀY ${snapshot.dayNumber}`,
            title: 'Thảo luận cùng mọi người.',
            body: 'Hãy nhìn nhau, không cần nhìn màn hình.',
          }
        : snapshot.phase === 'ENDED'
          ? {
              eyebrow: 'VÁN CHƠI ĐÃ KẾT THÚC',
              title: 'Cảm ơn mọi người.',
              body: 'Quản trò sẽ công bố kết quả tại bàn.',
            }
          : {
              eyebrow: 'CHỜ QUẢN TRÒ',
              title: 'Hãy úp điện thoại xuống.',
              body: 'Ván chơi sẽ sớm bắt đầu.',
            }

  return (
    <section className="player-center neutral-screen">
      <p className="eyebrow">{copy.eyebrow}</p>
      <div className="moon-mark" aria-hidden="true">◐</div>
      <h1>{copy.title}</h1>
      <p>{copy.body}</p>
      {snapshot.roleIdentity && snapshot.self.alive && (
        <button className="quiet-action" onClick={onRecheck} data-required-control>
          Xem lại vai trò
        </button>
      )}
    </section>
  )
}

function TargetButton({
  seat,
  name,
  selected,
  onClick,
  total,
  disabled = false,
  peerNames,
}: {
  seat: number | string
  name: string
  selected: boolean
  onClick: () => void
  total?: number
  disabled?: boolean
  peerNames?: string[]
}) {
  return (
    <button
      className={selected ? 'target selected' : 'target'}
      onClick={onClick}
      disabled={disabled}
      title={name}
      data-required-control
    >
      <span>{typeof seat === 'number' ? String(seat).padStart(2, '0') : seat}</span>
      <strong>{name}</strong>
      {peerNames && peerNames.length > 0 && (
        <small
          className="wolf-peer-marker"
          title={peerNames.join(', ')}
          aria-label={`Ma Sói đã chọn: ${peerNames.join(', ')}`}
        >
          🐺 {peerNames[0]}
          {peerNames.length > 1 ? ` · +${peerNames.length - 1}` : ''}
        </small>
      )}
      {total !== undefined && <em className="target-total">{total}</em>}
    </button>
  )
}

function WitchDecisionView({
  action,
  snapshot,
  dispatch,
}: PlayerGameplayProps & { action: PlayerActionSnapshot }) {
  const [mode, setMode] = useState<'RESURRECTION' | 'POISON'>(
    action.resurrectionAvailable ? 'RESURRECTION' : 'POISON',
  )
  const [resurrectionTargetId, setResurrectionTargetId] = useState<
    string | null
  >(null)
  const [poisonTargetId, setPoisonTargetId] = useState<string | null>(null)
  const candidates =
    mode === 'RESURRECTION'
      ? action.resurrectionCandidates ?? []
      : action.poisonCandidates ?? []
  const selectedTargetId =
    mode === 'RESURRECTION' ? resurrectionTargetId : poisonTargetId
  const selectTarget = (targetId: string | null) => {
    if (mode === 'RESURRECTION') setResurrectionTargetId(targetId)
    else setPoisonTargetId(targetId)
  }
  const resurrectionName = action.resurrectionCandidates?.find(
    (player) => player.id === resurrectionTargetId,
  )?.alias
  const poisonName = action.poisonCandidates?.find(
    (player) => player.id === poisonTargetId,
  )?.alias

  return (
    <section className="player-action compact-action witch-action">
      <header>
        <p className="eyebrow">CHECKPOINT CUỐI ĐÊM</p>
        <h1>Quyết định của Phù Thủy</h1>
        <p>Chỉ tên nạn nhân hiện tại được hiển thị. Không có thông tin nguồn.</p>
      </header>
      {(action.resurrectionAvailable || action.poisonAvailable) && (
        <div className="witch-tabs" role="tablist" aria-label="Chọn loại bình">
          {action.resurrectionAvailable && (
            <button
              className={mode === 'RESURRECTION' ? 'selected' : ''}
              onClick={() => setMode('RESURRECTION')}
              role="tab"
              aria-selected={mode === 'RESURRECTION'}
              data-required-control
            >
              Bình cứu
            </button>
          )}
          {action.poisonAvailable && (
            <button
              className={mode === 'POISON' ? 'selected' : ''}
              onClick={() => setMode('POISON')}
              role="tab"
              aria-selected={mode === 'POISON'}
              data-required-control
            >
              Bình độc
            </button>
          )}
        </div>
      )}
      {action.witchAttackedThisNight && (
        <p className="witch-status">Bạn không thể dùng bình cứu trong Đêm này.</p>
      )}
      {candidates.length > 0 ? (
        <div className="target-list">
          {candidates.map((candidate) => (
            <TargetButton
              key={candidate.id}
              seat={candidate.seat}
              name={candidate.alias}
              selected={selectedTargetId === candidate.id}
              onClick={() => selectTarget(candidate.id)}
            />
          ))}
          <TargetButton
            seat="—"
            name="Không dùng"
            selected={selectedTargetId === null}
            onClick={() => selectTarget(null)}
          />
        </div>
      ) : (
        <div className="witch-no-action">
          Không có lựa chọn hợp lệ cho bình này trong Đêm hiện tại.
        </div>
      )}
      <p className="witch-choice-summary">
        Cứu: <strong>{resurrectionName ?? 'Không dùng'}</strong> · Độc:{' '}
        <strong>{poisonName ?? 'Không dùng'}</strong>
      </p>
      <button
        className="button primary full action-confirm"
        onClick={() =>
          dispatch({
            type: 'SUBMIT_WITCH_DECISION',
            playerId: snapshot.self.id,
            resurrectionTargetId,
            poisonTargetId,
          })
        }
        data-required-control
      >
        Xác nhận quyết định · Úp máy
      </button>
    </section>
  )
}

function CupidPairingView({ snapshot, dispatch }: PlayerGameplayProps) {
  const action = snapshot.nightAction
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>(
    action?.selectedTargetIds ?? [],
  )
  if (!action || action.mode !== 'CUPID_PAIRING') return null

  const toggle = (targetId: string) => {
    setSelectedTargetIds((current) =>
      current.includes(targetId)
        ? current.filter((entry) => entry !== targetId)
        : current.length < 2
          ? [...current, targetId]
          : [current[1], targetId],
    )
  }

  return (
    <section className="player-action compact-action cupid-pairing-action">
      <header>
        <p className="eyebrow">ĐÊM 1 · GHÉP ĐÔI RIÊNG</p>
        <h1>Chọn hai Người Yêu</h1>
        <p>Chọn đúng hai người khác nhau. Vai trò và phe của họ không thay đổi.</p>
      </header>
      <div className="target-list">
        {action.candidates.map((candidate) => (
          <TargetButton
            key={candidate.id}
            seat={candidate.seat}
            name={candidate.alias}
            selected={selectedTargetIds.includes(candidate.id)}
            onClick={() => toggle(candidate.id)}
          />
        ))}
      </div>
      <p className="witch-choice-summary">
        Đã chọn: <strong>{selectedTargetIds.length} / 2</strong>
      </p>
      <button
        className="button primary full action-confirm"
        disabled={selectedTargetIds.length !== 2}
        onClick={() =>
          void dispatch({
            type: 'SUBMIT_CUPID_PAIRING',
            playerId: snapshot.self.id,
            targetIds: [selectedTargetIds[0], selectedTargetIds[1]],
          })
        }
        data-required-control
      >
        Xác nhận cặp đôi · Úp máy
      </button>
    </section>
  )
}

function LoverRevealView({ snapshot, dispatch }: PlayerGameplayProps) {
  const relationship = snapshot.loverRelationship
  if (!relationship?.revealPending) return null
  return (
    <section className="player-center lover-reveal">
      <p className="eyebrow">THÔNG TIN RIÊNG · NGƯỜI YÊU</p>
      <div className="moon-mark" aria-hidden="true">♡</div>
      <h1>{relationship.partner.alias}</h1>
      <p>Ghế {String(relationship.partner.seat).padStart(2, '0')} là Người Yêu của bạn.</p>
      <small>Không có thông tin vai trò hoặc phe được tiết lộ.</small>
      <button
        className="button primary full action-confirm"
        onClick={() =>
          void dispatch({
            type: 'ACKNOWLEDGE_LOVER_REVEAL',
            playerId: snapshot.self.id,
          })
        }
        data-required-control
      >
        Đã nhớ · Úp máy
      </button>
    </section>
  )
}

function NightActionView({ snapshot, dispatch }: PlayerGameplayProps) {
  const action = snapshot.nightAction
  if (!action) return null
  if (action.mode === 'CUPID_PAIRING') {
    return <CupidPairingView snapshot={snapshot} dispatch={dispatch} />
  }
  if (action.mode === 'WITCH_DECISION') {
    return (
      <WitchDecisionView
        key={action.id}
        action={action}
        snapshot={snapshot}
        dispatch={dispatch}
      />
    )
  }
  if (action.mode === 'HUNTER_PRELOCK') {
    const choose = (targetId: string | null) =>
      void dispatch({
        type: 'CAST_HUNTER_PRELOCK',
        playerId: snapshot.self.id,
        targetId,
      })
    return (
      <section className="player-action compact-action hunter-prelock-action">
        <header>
          <p className="eyebrow">KHÓA TRƯỚC · CHƯA BẮN</p>
          <h1>Chọn mục tiêu dự phòng</h1>
          <p>{action.instructions}</p>
        </header>
        <div className="target-list">
          {action.candidates.map((candidate) => (
            <TargetButton
              key={candidate.id}
              seat={candidate.seat}
              name={candidate.alias}
              selected={action.currentTargetId === candidate.id}
              onClick={() => choose(candidate.id)}
            />
          ))}
          <TargetButton
            seat="—"
            name="Không ai"
            selected={action.hasSelected && action.currentTargetId === null}
            onClick={() => choose(null)}
          />
        </div>
        <button
          className="button primary full action-confirm"
          disabled={!action.hasSelected}
          onClick={() =>
            void dispatch({
              type: 'CONFIRM_HUNTER_PRELOCK',
              playerId: snapshot.self.id,
            })
          }
          data-required-control
        >
          Khóa lựa chọn · Úp máy
        </button>
      </section>
    )
  }
  if (action.mode === 'SERIAL_KILLER_ATTACK') {
    const choose = (targetId: string | null) =>
      void dispatch({
        type: 'CAST_SERIAL_KILLER_ATTACK',
        playerId: snapshot.self.id,
        targetId,
      })
    return (
      <section className="player-action compact-action serial-killer-action">
        <header>
          <p className="eyebrow">HÀNH ĐỘNG ĐÊM · RIÊNG TƯ</p>
          <h1>Chọn mục tiêu</h1>
          <p>{action.instructions}</p>
        </header>
        <div className="target-list">
          {action.candidates.map((candidate) => (
            <TargetButton
              key={candidate.id}
              seat={candidate.seat}
              name={candidate.alias}
              selected={action.currentTargetId === candidate.id}
              onClick={() => choose(candidate.id)}
            />
          ))}
          <TargetButton
            seat="—"
            name="Không ai"
            selected={action.hasSelected && action.currentTargetId === null}
            onClick={() => choose(null)}
          />
        </div>
        <button
          className="button primary full action-confirm"
          disabled={!action.hasSelected}
          onClick={() =>
            void dispatch({
              type: 'CONFIRM_SERIAL_KILLER_ATTACK',
              playerId: snapshot.self.id,
            })
          }
          data-required-control
        >
          Xác nhận · Úp máy
        </button>
      </section>
    )
  }
  const choose = (targetId: string | null) => {
    if (action.kind === 'WOLF_VOTE' && targetId) {
      void dispatch({
        type: 'CAST_WOLF_VOTE',
        playerId: snapshot.self.id,
        targetId,
      })
    } else if (targetId && action.mode === 'SEER_SELECT') {
      void dispatch({
        type: 'SUBMIT_SEER_INSPECTION',
        playerId: snapshot.self.id,
        targetId,
      })
    } else if (targetId && action.mode === 'PROTECTOR_SELECT') {
      void dispatch({
        type: 'SUBMIT_PROTECTOR_TARGET',
        playerId: snapshot.self.id,
        targetId,
      })
    } else if (targetId) {
      void dispatch({
        type: 'SUBMIT_TARGET_ACTION',
        playerId: snapshot.self.id,
        targetId,
      })
    }
  }

  if (action.mode === 'SEER_RESULT' && action.inspectedTarget && action.seerResult) {
    return (
      <section className="player-action compact-action seer-result-player">
        <header>
          <p className="eyebrow">KẾT QUẢ KIỂM TRA</p>
          <h1>{action.inspectedTarget.alias}</h1>
          <p>Ghế {String(action.inspectedTarget.seat).padStart(2, '0')}</p>
        </header>
        <div className="seer-result" aria-live="polite">
          {action.seerResult === 'WOLF' ? 'SÓI' : 'KHÔNG PHẢI SÓI'}
        </div>
        <button
          className="button primary full action-confirm"
          onClick={() =>
            dispatch({
              type: 'ACKNOWLEDGE_SEER_RESULT',
              playerId: snapshot.self.id,
            })
          }
          data-required-control
        >
          Đã nhớ · Úp máy
        </button>
      </section>
    )
  }

  return (
    <section className="player-action compact-action">
      <header>
        <p className="eyebrow">
          {action.round === 'REVOTE' ? 'CHỌN LẠI · 10 GIÂY' : 'HÀNH ĐỘNG ĐÊM'}
        </p>
        <h1>Chọn mục tiêu</h1>
        <p>{action.instructions}</p>
      </header>
      <div className="target-list">
        {action.candidates.map((candidate) => {
          const peerNames = action.wolfTeammateBallots
            ?.filter((ballot) => ballot.targetId === candidate.id)
            .map((ballot) => ballot.voter.alias)
          return (
            <TargetButton
              key={candidate.id}
              seat={candidate.seat}
              name={candidate.alias}
              selected={action.currentTargetId === candidate.id}
              onClick={() => choose(candidate.id)}
              peerNames={peerNames}
            />
          )
        })}
      </div>
      {action.kind === 'WOLF_VOTE' && (
        <button
          className="button primary full action-confirm"
          disabled={
            !action.hasSelected || typeof action.currentTargetId !== 'string'
          }
          onClick={() =>
            dispatch({
              type: 'CONFIRM_NIGHT_ACTION',
              playerId: snapshot.self.id,
            })
          }
          data-required-control
        >
          Xác nhận · Úp máy
        </button>
      )}
    </section>
  )
}

function DayVoteView({ snapshot, dispatch }: PlayerGameplayProps) {
  const vote = snapshot.dayVote
  const secondsLeft = useCountdownSeconds(vote?.deadlineAt)
  if (!vote || vote.status !== 'OPEN' || !snapshot.self.alive) return null

  const expired = secondsLeft === 0

  return (
    <section className="player-action compact-action day-vote-player">
      <header>
        <p className="eyebrow">NGÀY {snapshot.dayNumber} · BỎ PHIẾU</p>
        <h1>Chọn người treo cổ</h1>
        <p>Chạm lại lựa chọn hiện tại để bỏ phiếu trắng.</p>
      </header>
      <div className="day-vote-clock" aria-live="polite">
        {expired ? 'Đang chờ kết quả' : `00:${String(secondsLeft).padStart(2, '0')}`}
      </div>
      <div className="target-list">
        {vote.candidates.map((candidate) => (
          <TargetButton
            key={candidate.id}
            seat={candidate.seat}
            name={candidate.alias}
            selected={vote.currentTargetId === candidate.id}
            total={vote.totals[candidate.id] ?? 0}
            disabled={expired}
            onClick={() =>
              void dispatch({
                type: 'CAST_DAY_VOTE',
                playerId: snapshot.self.id,
                targetId: candidate.id,
              })
            }
          />
        ))}
      </div>
      <p className="vote-save-status">
        {expired
          ? 'Thời hạn đã khóa trên máy chủ.'
          : vote.currentTargetId
            ? 'Đã lưu lựa chọn · chạm lại để bỏ phiếu trắng.'
            : 'Phiếu trắng.'}
      </p>
    </section>
  )
}

function HunterRevengeView({ snapshot, dispatch }: PlayerGameplayProps) {
  const action = snapshot.dayVote?.hunterRevengeAction
  const [targetId, setTargetId] = useState<string | null | undefined>(undefined)
  if (!action) return null
  return (
    <section className="player-action compact-action hunter-revenge-action">
      <header>
        <p className="eyebrow">THỢ SĂN · PHÁT BẮN TRẢ THÙ</p>
        <h1>Chọn người đi cùng</h1>
        <p>Chọn đúng một người còn sống hoặc Không ai.</p>
      </header>
      <div className="target-list">
        {action.candidates.map((candidate) => (
          <TargetButton
            key={candidate.id}
            seat={candidate.seat}
            name={candidate.alias}
            selected={targetId === candidate.id}
            onClick={() => setTargetId(candidate.id)}
          />
        ))}
        <TargetButton
          seat="—"
          name="Không ai"
          selected={targetId === null}
          onClick={() => setTargetId(null)}
        />
      </div>
      <button
        className="button primary full action-confirm"
        disabled={targetId === undefined}
        onClick={() =>
          void dispatch({
            type: 'SUBMIT_HUNTER_REVENGE',
            playerId: snapshot.self.id,
            targetId: targetId ?? null,
          })
        }
        data-required-control
      >
        Xác nhận phát bắn
      </button>
    </section>
  )
}

export function PlayerView({ snapshot, dispatch, homeHref }: PlayerViewProps) {
  const [rechecking, setRechecking] = useState(false)
  const [endRevealOpen, setEndRevealOpen] = useState(false)
  const isEndMatch =
    snapshot.lifecycle === 'FINISHED' && Boolean(snapshot.endMatch)
  const activeSurface =
    isEndMatch
      ? endRevealOpen
        ? 'END-MATCH-ROSTER'
        : 'END-MATCH-RESULT'
      : snapshot.lifecycle === 'LOBBY'
      ? 'LOBBY'
      : rechecking
        ? 'RECHECK'
        : snapshot.roleRevealPending
          ? 'REVEAL'
          : snapshot.loverRelationship?.revealPending
            ? 'LOVER_REVEAL'
            : snapshot.nightAction
              ? 'NIGHT_ACTION'
              : snapshot.dayVote?.hunterRevengeAction
                ? 'HUNTER_REVENGE'
                : snapshot.dayVote?.status === 'OPEN' && snapshot.self.alive
                  ? 'DAY_VOTE'
                  : 'NEUTRAL'

  return (
    <main
      className="player-viewport zero-scroll-surface"
      data-player-viewport
      data-surface={activeSurface.toLowerCase()}
    >
      <div className="player-identity">
        <span>Ghế của bạn</span>
        <strong>{playerLabel(snapshot.self)}</strong>
      </div>
      <div className="player-stage">
        {isEndMatch && snapshot.endMatch && (
          <PlayerEndMatch
            endMatch={snapshot.endMatch}
            revealOpen={endRevealOpen}
            onRevealOpenChange={setEndRevealOpen}
            homeHref={homeHref}
          />
        )}
        {!isEndMatch && activeSurface === 'LOBBY' && <PlayerLobby snapshot={snapshot} />}
        {!isEndMatch && activeSurface === 'REVEAL' && (
          <RoleIdentityCard snapshot={snapshot} dispatch={dispatch} mode="REVEAL" />
        )}
        {!isEndMatch && activeSurface === 'RECHECK' && (
          <RoleIdentityCard
            snapshot={snapshot}
            dispatch={dispatch}
            mode="RECHECK"
            onClose={() => setRechecking(false)}
          />
        )}
        {!isEndMatch && activeSurface === 'LOVER_REVEAL' && (
          <LoverRevealView snapshot={snapshot} dispatch={dispatch} />
        )}
        {!isEndMatch && activeSurface === 'NIGHT_ACTION' && (
          <NightActionView snapshot={snapshot} dispatch={dispatch} />
        )}
        {!isEndMatch && activeSurface === 'DAY_VOTE' && (
          <DayVoteView snapshot={snapshot} dispatch={dispatch} />
        )}
        {!isEndMatch && activeSurface === 'HUNTER_REVENGE' && (
          <HunterRevengeView snapshot={snapshot} dispatch={dispatch} />
        )}
        {!isEndMatch && activeSurface === 'NEUTRAL' && (
          <NeutralScreen snapshot={snapshot} onRecheck={() => setRechecking(true)} />
        )}
      </div>
      <footer className="player-footer">Người chơi nhìn nhau · Quản trò nhìn app</footer>
    </main>
  )
}
