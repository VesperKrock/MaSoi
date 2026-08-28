import { useEffect, useMemo, useState } from 'react'
import { playerLabel } from '../../components/player-label'
import { getEligibleDayTargets } from '../../domain/actions/target-rules'
import { projectEndMatch } from '../../domain/gameplay/end-match'
import {
  isHalfWolfTransformed,
  isTraitorConverted,
} from '../../domain/gameplay/faction-transitions'
import { getDayVoteWeight, resolveDayVote } from '../../domain/voting/day-vote'
import type { NightAction, PlayerId, RoomState } from '../../domain/game/types'
import type {
  OfflineSessionCommand,
  OfflineSessionState,
} from '../../domain/offline/offline-session'
import { classicRoleById } from '../../domain/roles/classic-catalog'
import { appUrl } from '../../lib/app-url'
import { ModeratorEndMatch } from '../end-match/end-match-view'

interface OfflineMatchProps {
  state: OfflineSessionState
  dispatch: (command: OfflineSessionCommand) => void
  onOpenJournal?: () => void
}

function nameFor(room: RoomState, playerId: PlayerId | null | undefined) {
  if (!playerId) return 'Không ai'
  const player = room.players.find((entry) => entry.id === playerId)
  return player ? playerLabel(player) : 'Không rõ'
}

function useCurrentTime(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function runtimeLabel(room: RoomState, playerId: PlayerId) {
  if (isHalfWolfTransformed(room.factionTransitions, playerId)) {
    return 'Đã hóa Sói'
  }
  if (isTraitorConverted(room.factionTransitions, playerId)) {
    return 'Đã về Dân'
  }
  return ''
}

function OfflineRoster({ room }: { room: RoomState }) {
  const roleByPlayerId = new Map(
    room.roleAssignments.map((assignment) => [
      assignment.playerId,
      assignment.roleId,
    ]),
  )
  return (
    <aside className="panel offline-live-roster">
      <div className="section-title">
        <div>
          <p className="eyebrow">Riêng Quản trò</p>
          <h2>Trạng thái bàn</h2>
        </div>
        <span>{room.players.filter((player) => player.alive).length} sống</span>
      </div>
      <div className="offline-live-roster-list">
        {room.players.map((player) => {
          const roleId = roleByPlayerId.get(player.id)
          const runtime = runtimeLabel(room, player.id)
          return (
            <div className={player.alive ? '' : 'dead'} key={player.id}>
              <span>#{player.seat}</span>
              <div>
                <strong>{player.alias}</strong>
                <small>
                  {roleId ? classicRoleById[roleId].displayName : 'Chưa rõ'}
                  {runtime ? ` · ${runtime}` : ''}
                </small>
              </div>
              <em>{player.alive ? 'Sống' : 'Đã chết'}</em>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

function TargetButtons({
  room,
  targetIds,
  selectedIds = [],
  onSelect,
}: {
  room: RoomState
  targetIds: readonly PlayerId[]
  selectedIds?: readonly PlayerId[]
  onSelect: (playerId: PlayerId) => void
}) {
  return (
    <div className="offline-match-targets">
      {targetIds.map((playerId) => {
        const player = room.players.find((entry) => entry.id === playerId)
        if (!player) return null
        const selected = selectedIds.includes(playerId)
        return (
          <button
            className={selected ? 'selected' : ''}
            key={player.id}
            aria-pressed={selected}
            onClick={() => onSelect(player.id)}
          >
            <span>#{player.seat}</span>
            <strong>{player.alias}</strong>
          </button>
        )
      })}
    </div>
  )
}

function CupidAction({
  state,
  room,
  action,
  dispatch,
}: OfflineMatchProps & { room: RoomState; action: NightAction }) {
  const selectedIds = state.authorityInput.cupidTargetIds
  return (
    <div className="offline-action-card">
      <p>Chọn đúng hai người còn sống, khác nhau và không phải Cupid.</p>
      <TargetButtons
        room={room}
        targetIds={action.eligibleTargetIds}
        selectedIds={selectedIds}
        onSelect={(playerId) =>
          dispatch({ type: 'TOGGLE_OFFLINE_CUPID_TARGET', playerId })
        }
      />
      <button
        className="button primary full"
        disabled={selectedIds.length !== 2}
        onClick={() => dispatch({ type: 'CONFIRM_OFFLINE_CUPID_PAIR' })}
      >
        Xác nhận hai Người Yêu
      </button>
    </div>
  )
}

function SeerResult({
  room,
  action,
  dispatch,
}: OfflineMatchProps & { room: RoomState; action: NightAction }) {
  if (!action.seer) return null
  return (
    <div className="offline-seer-result">
      <span>{nameFor(room, action.seer.targetId)}</span>
      <strong>
        {action.seer.result === 'WOLF' ? 'LÀ MA SÓI' : 'KHÔNG PHẢI MA SÓI'}
      </strong>
      <button
        className="button primary full"
        onClick={() => dispatch({ type: 'ACKNOWLEDGE_OFFLINE_SEER_RESULT' })}
      >
        Đã ghi nhớ kết quả
      </button>
    </div>
  )
}

function WitchAction({
  state,
  room,
  action,
  dispatch,
}: OfflineMatchProps & { room: RoomState; action: NightAction }) {
  const witch = action.witch
  if (!witch) return null
  const resurrectionId = state.authorityInput.witchResurrectionTargetId
  const poisonId = state.authorityInput.witchPoisonTargetId
  return (
    <div className="offline-witch-action">
      <section>
        <div className="offline-action-subheading">
          <strong>Bình cứu</strong>
          <span>{witch.resurrectionAvailable ? 'Còn bình' : 'Không khả dụng'}</span>
        </div>
        {witch.attackedThisNight && (
          <p className="hint">Phù Thủy là nạn nhân Đêm này nên không thể tự cứu.</p>
        )}
        <div className="offline-option-row">
          <button
            className={resurrectionId === null ? 'selected' : ''}
            onClick={() =>
              dispatch({
                type: 'SET_OFFLINE_WITCH_RESURRECTION_TARGET',
                playerId: null,
              })
            }
          >
            Không dùng bình cứu
          </button>
        </div>
        <TargetButtons
          room={room}
          targetIds={witch.resurrectionCandidateIds}
          selectedIds={resurrectionId ? [resurrectionId] : []}
          onSelect={(playerId) =>
            dispatch({
              type: 'SET_OFFLINE_WITCH_RESURRECTION_TARGET',
              playerId,
            })
          }
        />
      </section>
      <section>
        <div className="offline-action-subheading">
          <strong>Bình độc</strong>
          <span>{witch.poisonAvailable ? 'Còn bình' : 'Không khả dụng Đêm này'}</span>
        </div>
        <div className="offline-option-row">
          <button
            className={poisonId === null ? 'selected' : ''}
            onClick={() =>
              dispatch({
                type: 'SET_OFFLINE_WITCH_POISON_TARGET',
                playerId: null,
              })
            }
          >
            Không dùng bình độc
          </button>
        </div>
        <TargetButtons
          room={room}
          targetIds={witch.poisonCandidateIds}
          selectedIds={poisonId ? [poisonId] : []}
          onSelect={(playerId) =>
            dispatch({
              type: 'SET_OFFLINE_WITCH_POISON_TARGET',
              playerId,
            })
          }
        />
      </section>
      <button
        className="button primary full"
        onClick={() => dispatch({ type: 'CONFIRM_OFFLINE_WITCH_DECISION' })}
      >
        Xác nhận quyết định Phù Thủy
      </button>
    </div>
  )
}

function ActiveNightCall({
  state,
  room,
  dispatch,
}: OfflineMatchProps & { room: RoomState }) {
  const roleId = room.night?.activeRoleId
  if (!roleId) return null
  const role = classicRoleById[roleId]
  const action = room.night?.actionsByRole[roleId]
  const holderNames = room.roleAssignments
    .filter((assignment) => assignment.roleId === roleId)
    .map((assignment) => nameFor(room, assignment.playerId))
  const livingActorNames = (action?.eligibleActorIds ?? []).map((playerId) =>
    nameFor(room, playerId),
  )

  if (!action || action.status !== 'OPEN') {
    return (
      <section className="panel offline-active-call">
        <p className="eyebrow">ĐÃ GỌI · {role.displayName}</p>
        <h2>{role.displayName.toLocaleUpperCase('vi')} ĐI NGỦ</h2>
        <p>
          {holderNames.length > 0
            ? `Người giữ vai: ${holderNames.join(', ')}. Vai thụ động, đã chết hoặc không đủ điều kiện hành động.`
            : 'Không có người giữ vai hợp lệ để hành động.'}
        </p>
        <button
          className="button primary full"
          onClick={() => dispatch({ type: 'COMPLETE_ACTIVE_OFFLINE_RITUAL' })}
        >
          [ĐÃ GỌI — ĐI NGỦ]
        </button>
      </section>
    )
  }

  return (
    <section className="panel offline-active-call">
      <p className="eyebrow">ROLE_ACTION · {action.kind}</p>
      <h2>{role.displayName}</h2>
      <p>
        Quản trò ghi thay cho:{' '}
        <strong>{livingActorNames.join(', ') || holderNames.join(', ')}</strong>
      </p>

      {action.kind === 'CUPID_PAIRING' && (
        <CupidAction state={state} room={room} action={action} dispatch={dispatch} />
      )}
      {action.kind === 'WITCH_DECISION' && (
        <WitchAction state={state} room={room} action={action} dispatch={dispatch} />
      )}
      {action.kind === 'SELECT_TARGET' && action.roleId === 'seer' && action.seer && (
        <SeerResult state={state} room={room} action={action} dispatch={dispatch} />
      )}
      {(action.kind === 'WOLF_VOTE' ||
        action.kind === 'SELECT_TARGET' ||
        action.kind === 'HUNTER_PRELOCK' ||
        action.kind === 'SERIAL_KILLER_ATTACK') &&
        !(action.roleId === 'seer' && action.seer) && (
          <div className="offline-action-card">
            <p>
              {action.kind === 'WOLF_VOTE'
                ? 'Ghi đúng một mục tiêu chung của cả bầy. Mục tiêu là bắt buộc.'
                : 'Chọn mục tiêu theo tên người chơi.'}
            </p>
            <TargetButtons
              room={room}
              targetIds={action.eligibleTargetIds}
              onSelect={(targetId) =>
                dispatch({ type: 'SUBMIT_OFFLINE_NIGHT_TARGET', targetId })
              }
            />
            {(action.kind === 'HUNTER_PRELOCK' ||
              action.kind === 'SERIAL_KILLER_ATTACK') && (
              <button
                className="button secondary full"
                onClick={() =>
                  dispatch({ type: 'SUBMIT_OFFLINE_NIGHT_TARGET', targetId: null })
                }
              >
                Không ai
              </button>
            )}
          </div>
        )}
    </section>
  )
}

function LoversReveal({
  room,
  dispatch,
}: OfflineMatchProps & { room: RoomState }) {
  const couple = room.cupidLovers?.couple
  if (!couple) return null
  return (
    <section className="panel offline-lovers-reveal">
      <p className="eyebrow">Nghi thức riêng · Đêm 1</p>
      <h2>NGƯỜI YÊU THỨC DẬY</h2>
      <p>Cho hai người này nhận biết nhau ngoài đời:</p>
      <strong>
        {nameFor(room, couple.loverPlayerIds[0])} ♡{' '}
        {nameFor(room, couple.loverPlayerIds[1])}
      </strong>
      <button
        className="button primary full"
        onClick={() => dispatch({ type: 'ACKNOWLEDGE_OFFLINE_LOVERS' })}
      >
        Cả hai đã nhận biết nhau
      </button>
    </section>
  )
}

function NightLifecycle({ state, room, dispatch }: OfflineMatchProps & { room: RoomState }) {
  const night = room.night
  if (!night) return null
  const couple = room.cupidLovers?.couple
  const loversPending =
    couple &&
    couple.loverPlayerIds.some(
      (playerId) =>
        !room.cupidLovers?.loverRevealAcknowledgedPlayerIds.includes(playerId),
    )
  const nextCall = night.calls.find((call) => call.status === 'NOT_CALLED')
  const completedCount = night.calls.filter(
    (call) => call.status === 'COMPLETED',
  ).length
  const checkpoint =
    room.witchCheckpoint?.nightNumber === room.dayNumber
      ? room.witchCheckpoint
      : null

  return (
    <>
      <section className="panel offline-night-progress">
        <div className="section-title">
          <div>
            <p className="eyebrow">Mọi role cấu hình · kể cả đã chết</p>
            <h2>Nghi thức Đêm {room.dayNumber}</h2>
          </div>
          <span>{completedCount} / {night.calls.length}</span>
        </div>
        <div className="offline-call-plan">
          {night.calls.map((call) => (
            <span
              className={`${call.status.toLocaleLowerCase()} ${night.activeRoleId === call.roleId ? 'active' : ''}`}
              key={call.roleId}
            >
              {classicRoleById[call.roleId].displayName}
            </span>
          ))}
        </div>
      </section>

      {loversPending ? (
        <LoversReveal state={state} room={room} dispatch={dispatch} />
      ) : night.activeRoleId ? (
        <ActiveNightCall state={state} room={room} dispatch={dispatch} />
      ) : checkpoint ? (
        <section className="panel offline-morning-checkpoint">
          <p className="eyebrow">Tử vong đã ổn định · chưa công bố vai</p>
          <h2>Kết quả cuối Đêm {room.dayNumber}</h2>
          {checkpoint.finalDeaths.length === 0 ? (
            <strong>Không có người chết.</strong>
          ) : (
            <div className="offline-final-deaths">
              {checkpoint.finalDeaths.map((death) => (
                <strong key={death.playerId}>{nameFor(room, death.playerId)}</strong>
              ))}
            </div>
          )}
          <button
            className="button primary full"
            onClick={() => dispatch({ type: 'START_OFFLINE_DAY' })}
          >
            Công bố buổi sáng
          </button>
        </section>
      ) : nextCall ? (
        <section className="panel offline-next-call">
          <p className="eyebrow">Lượt kế tiếp</p>
          <h2>{classicRoleById[nextCall.roleId].displayName}</h2>
          <p>Gọi role ngoài đời rồi mở bước ghi nhận trên máy Quản trò.</p>
          <button
            className="button primary full"
            onClick={() => dispatch({ type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' })}
          >
            GỌI {classicRoleById[nextCall.roleId].displayName.toLocaleUpperCase('vi')}
          </button>
        </section>
      ) : (
        <section className="panel offline-night-finalize">
          <p className="eyebrow">Shared death resolver</p>
          <h2>Đã gọi đủ mọi role</h2>
          <p>Chốt checkpoint Phù Thủy, Hunter và chuỗi Người Yêu đúng một lần.</p>
          <button
            className="button primary full"
            onClick={() => dispatch({ type: 'FINALIZE_OFFLINE_NIGHT' })}
          >
            Chốt tử vong Đêm
          </button>
        </section>
      )}
    </>
  )
}

function DayVoteOpen({ state, room, dispatch }: OfflineMatchProps & { room: RoomState }) {
  const vote = room.dayVote
  const now = useCurrentTime(vote?.status === 'OPEN')
  if (!vote || vote.status !== 'OPEN') return null
  const livingPlayers = room.players.filter((player) => player.alive)
  const unrecorded = livingPlayers.filter(
    (player) => !Object.prototype.hasOwnProperty.call(vote.votes, player.id),
  )
  const activeVoterId =
    state.authorityInput.dayVoterId &&
    livingPlayers.some((player) => player.id === state.authorityInput.dayVoterId)
      ? state.authorityInput.dayVoterId
      : unrecorded[0]?.id
  const activeVoter = livingPlayers.find((player) => player.id === activeVoterId)
  const secondsLeft = Math.max(0, Math.ceil((vote.deadlineAt - now) / 1000))
  const allRecorded = unrecorded.length === 0
  const totals = resolveDayVote(
    vote.votes,
    livingPlayers.map((player) => player.id),
    livingPlayers.map((player) => player.id),
    Object.fromEntries(
      livingPlayers.map((player) => [
        player.id,
        getDayVoteWeight(
          room.roleAssignments.find(
            (assignment) => assignment.playerId === player.id,
          )?.roleId,
        ),
      ]),
    ),
  ).counts

  return (
    <section className="panel offline-day-vote">
      <div className="section-title">
        <div>
          <p className="eyebrow">Phiếu đã ghi {livingPlayers.length - unrecorded.length}/{livingPlayers.length}</p>
          <h2>Bỏ phiếu · 00:{String(secondsLeft).padStart(2, '0')}</h2>
        </div>
      </div>
      {activeVoter && (
        <div className="offline-voter-input">
          <p>
            Phiếu của <strong>{playerLabel(activeVoter)}</strong>
            {getDayVoteWeight(
              room.roleAssignments.find(
                (assignment) => assignment.playerId === activeVoter.id,
              )?.roleId,
            ) === 2 && <span className="offline-mayor-weight"> ×2</span>}
          </p>
          <TargetButtons
            room={room}
            targetIds={getEligibleDayTargets(room, activeVoter.id)}
            selectedIds={
              typeof vote.votes[activeVoter.id] === 'string'
                ? [vote.votes[activeVoter.id] as PlayerId]
                : []
            }
            onSelect={(targetId) =>
              dispatch({
                type: 'CAST_OFFLINE_DAY_VOTE',
                voterId: activeVoter.id,
                targetId,
              })
            }
          />
          <button
            className="button secondary full"
            onClick={() =>
              dispatch({
                type: 'CAST_OFFLINE_DAY_VOTE',
                voterId: activeVoter.id,
                targetId: null,
              })
            }
          >
            Bỏ phiếu trắng
          </button>
        </div>
      )}
      <div className="offline-recorded-votes">
        {livingPlayers
          .filter((player) =>
            Object.prototype.hasOwnProperty.call(vote.votes, player.id),
          )
          .map((player) => (
            <button
              key={player.id}
              onClick={() =>
                dispatch({ type: 'SET_OFFLINE_DAY_VOTER', playerId: player.id })
              }
            >
              <span>{player.alias}</span>
              <strong>{nameFor(room, vote.votes[player.id])}</strong>
              <small>Sửa</small>
            </button>
          ))}
      </div>
      <div className="offline-vote-totals">
        {livingPlayers.map((player) => (
          <div key={player.id}>
            <span>{player.alias}</span>
            <strong>{totals[player.id] ?? 0}</strong>
          </div>
        ))}
      </div>
      <button
        className="button primary full"
        disabled={!allRecorded || secondsLeft > 0}
        onClick={() => dispatch({ type: 'CLOSE_OFFLINE_DAY_VOTE' })}
      >
        {!allRecorded
          ? 'Chưa ghi đủ phiếu'
          : secondsLeft > 0
            ? 'Chưa hết thời gian'
            : 'Chốt kết quả bỏ phiếu'}
      </button>
    </section>
  )
}

function DayLifecycle({ state, room, dispatch }: OfflineMatchProps & { room: RoomState }) {
  const vote = room.dayVote
  const finalDeaths = room.witchCheckpoint?.finalDeaths ?? []
  const pendingRevenge = vote?.hunterRevenge?.status === 'PENDING'
  const hangedId = vote?.result?.kind === 'UNIQUE' ? vote.result.targetIds[0] : null

  return (
    <>
      {!vote && (
        <section className="panel offline-day-discussion">
          <p className="eyebrow">Chỉ công bố tử vong cuối</p>
          <h2>Buổi sáng · Ngày {room.dayNumber}</h2>
          {finalDeaths.length === 0 ? (
            <strong>Đêm qua không có ai chết.</strong>
          ) : (
            <div className="offline-final-deaths">
              {finalDeaths.map((death) => (
                <strong key={death.playerId}>{nameFor(room, death.playerId)}</strong>
              ))}
            </div>
          )}
          <p>Thảo luận ngoài đời. Quản trò chủ động mở lượt bỏ phiếu.</p>
          <button
            className="button primary full"
            onClick={() => dispatch({ type: 'OPEN_OFFLINE_DAY_VOTE' })}
          >
            Bắt đầu bỏ phiếu
          </button>
        </section>
      )}

      {vote?.status === 'OPEN' && (
        <DayVoteOpen state={state} room={room} dispatch={dispatch} />
      )}

      {vote?.status === 'CLOSED' && pendingRevenge && (
        <section className="panel offline-hunter-revenge">
          <p className="eyebrow">Hunter Day revenge</p>
          <h2>THỢ SĂN CHỌN NGƯỜI ĐI CÙNG</h2>
          <p>{nameFor(room, vote.hunterRevenge?.hunterPlayerId)} vừa bị treo cổ.</p>
          <TargetButtons
            room={room}
            targetIds={room.players
              .filter((player) => player.alive)
              .map((player) => player.id)}
            onSelect={(targetId) =>
              dispatch({ type: 'SUBMIT_OFFLINE_HUNTER_REVENGE', targetId })
            }
          />
          <button
            className="button secondary full"
            onClick={() =>
              dispatch({ type: 'SUBMIT_OFFLINE_HUNTER_REVENGE', targetId: null })
            }
          >
            Không ai
          </button>
        </section>
      )}

      {vote?.status === 'CLOSED' && !pendingRevenge && (
        <section className="panel offline-day-result">
          <p className="eyebrow">Kết quả có thẩm quyền</p>
          <h2>
            {vote.result?.kind === 'UNIQUE'
              ? `Đã treo cổ ${nameFor(room, hangedId)}`
              : vote.result?.kind === 'TIE'
                ? 'Hòa cao nhất · không ai bị treo cổ'
                : 'Tất cả bỏ phiếu trắng · không ai bị treo cổ'}
          </h2>
          {vote.hunterRevenge?.status === 'RESOLVED' && (
            <p>
              Thợ Săn:{' '}
              {vote.hunterRevenge.targetPlayerId
                ? `đã bắn ${nameFor(room, vote.hunterRevenge.targetPlayerId)}`
                : 'không bắn ai'}
            </p>
          )}
          <button
            className="button primary full"
            onClick={() => dispatch({ type: 'START_OFFLINE_NEXT_NIGHT' })}
          >
            Bắt đầu Đêm {room.dayNumber + 1}
          </button>
        </section>
      )}
    </>
  )
}

export function OfflineMatchView({
  state,
  dispatch,
  onOpenJournal,
}: OfflineMatchProps) {
  const room = state.authority
  const endMatch = useMemo(
    () => (room ? projectEndMatch(room) : undefined),
    [room],
  )
  if (!room) return null
  if (endMatch) {
    return (
      <ModeratorEndMatch
        endMatch={endMatch}
        homeHref={appUrl('')}
        onOpenJournal={onOpenJournal}
      />
    )
  }

  return (
    <main className="offline-match-layout">
      <header className="offline-heading">
        <div>
          <p className="eyebrow">Offline authority · shared engine</p>
          <h1>{room.phase === 'NIGHT' ? `ĐÊM ${room.dayNumber}` : `NGÀY ${room.dayNumber}`}</h1>
          <p>Quản trò ghi thao tác theo tên người chơi trên bộ bài vật lý.</p>
        </div>
        <span className="offline-phase-pill">{room.phase}</span>
      </header>
      {state.blockingError && (
        <div className="error-banner offline-match-error" role="alert">
          <span>{state.blockingError}</span>
          <button
            onClick={() => dispatch({ type: 'CLEAR_ERROR' })}
            aria-label="Đóng thông báo lỗi"
          >
            ×
          </button>
        </div>
      )}
      <div className="offline-match-grid">
        <div className="offline-match-primary">
          {room.phase === 'NIGHT' && (
            <NightLifecycle state={state} room={room} dispatch={dispatch} />
          )}
          {room.phase === 'DAY' && (
            <DayLifecycle state={state} room={room} dispatch={dispatch} />
          )}
        </div>
        <OfflineRoster room={room} />
      </div>
    </main>
  )
}
