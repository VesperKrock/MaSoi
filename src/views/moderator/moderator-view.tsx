import { useEffect, useMemo, useState } from 'react'
import { playerLabel } from '../../components/player-label'
import type {
  NightAction,
  PlayerId,
  RoomCommand,
  RoomState,
  WolfPolicy,
} from '../../domain/game/types'
import { getNightResolutionReadiness } from '../../domain/gameplay/night-resolution'
import { getDayVoteWeight, resolveDayVote } from '../../domain/voting/day-vote'
import { classicRoleById } from '../../domain/roles/classic-catalog'
import { getPreWitchNightRoleIds } from '../../domain/roles/role-definitions'

interface ModeratorViewProps {
  state: RoomState
  dispatch: (command: RoomCommand) => Promise<boolean>
}

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

function playerName(state: RoomState, playerId: PlayerId | null | undefined) {
  if (!playerId) return 'Không có mục tiêu hợp lệ'
  const player = state.players.find((entry) => entry.id === playerId)
  return player ? playerLabel(player) : playerId
}

function PhaseHeader({ state }: { state: RoomState }) {
  const label =
    state.phase === 'SETUP'
      ? 'CHUẨN BỊ'
      : state.phase === 'NIGHT'
        ? `ĐÊM ${state.dayNumber}`
        : state.phase === 'DAY'
          ? `NGÀY ${state.dayNumber}`
          : 'ĐÃ KẾT THÚC'

  return (
    <div className="phase-heading">
      <div>
        <p className="eyebrow">Bảng điều khiển Quản trò</p>
        <h1>{label}</h1>
      </div>
      <span className={`phase-pill phase-${state.phase.toLowerCase()}`}>
        {state.phase}
      </span>
    </div>
  )
}

function SetupPanel({ state, dispatch }: ModeratorViewProps) {
  const [playerCount, setPlayerCount] = useState(state.players.length)
  const [policy, setPolicy] = useState<WolfPolicy>(state.config.wolfPolicy)

  const reset = async () => {
    if (
      window.confirm(
        'Tạo lại phòng phát triển? Snapshot và journal hiện tại sẽ được thay thế.',
      )
    ) {
      await dispatch({ type: 'RESET_ROOM', playerCount, wolfPolicy: policy })
    }
  }

  return (
    <section className="panel setup-panel">
      <div className="section-title">
        <div>
          <p className="eyebrow">Phòng phát triển local</p>
          <h2>Chuẩn bị bàn chơi</h2>
        </div>
      </div>
      <div className="form-grid">
        <label>
          Số ghế
          <input
            type="number"
            min={3}
            max={12}
            value={playerCount}
            onChange={(event) => setPlayerCount(Number(event.target.value))}
          />
        </label>
        <label>
          Luật hòa của Ma Sói
          <select
            value={policy}
            onChange={(event) => setPolicy(event.target.value as WolfPolicy)}
          >
            <option value="RANDOM_ON_TIE">Random khi hòa</option>
            <option value="REVOTE_10S">Bỏ phiếu lại 10 giây</option>
          </select>
        </label>
      </div>
      <div className="button-row">
        <button className="button secondary" onClick={reset}>
          Tạo lại phòng
        </button>
        <button
          className="button primary"
          onClick={() => dispatch({ type: 'START_NIGHT' })}
        >
          Bắt đầu Đêm 1
        </button>
      </div>
      <p className="hint">
        Mở từng ghế từ menu phía trên trong tab mới để nhận vai trò bí mật.
      </p>
    </section>
  )
}

function ModeratorLobby({ state, dispatch }: ModeratorViewProps) {
  const full = state.players.length === state.config.seatCount

  return (
    <main className="moderator-layout lobby-moderator">
      <div className="phase-heading lobby-heading">
        <div>
          <p className="eyebrow">Lobby · Mã vào phòng</p>
          <h1>
            <span>Phòng</span>
            <strong>{state.roomCode.slice(0, 3)} {state.roomCode.slice(3)}</strong>
          </h1>
          <p>Mời người chơi nhập mã này tại <strong>Vào phòng</strong>.</p>
        </div>
        <div className="lobby-heading-status">
          <span className="phase-pill">LOBBY</span>
          <strong>{state.players.length} / {state.config.seatCount}</strong>
          <small>người đã vào</small>
        </div>
      </div>
      <div className="moderator-grid">
        <section className="panel lobby-roster-panel">
          <div className="lobby-count">
            <span>Đã vào phòng</span>
            <strong>{state.players.length} / {state.config.seatCount}</strong>
          </div>
          <div className="joined-list">
            {Array.from({ length: state.config.seatCount }, (_, index) => {
              const player = state.players[index]
              return (
                <div className={player ? 'joined-seat occupied' : 'joined-seat'} key={index}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{player?.alias ?? 'Đang chờ người chơi…'}</strong>
                </div>
              )
            })}
          </div>
        </section>
        <aside>
          <section className="panel lobby-control-panel">
            <p className="eyebrow">Bộ vai trò đã khóa cấu hình</p>
            <h2>{state.config.seatCount} lá</h2>
            <div className="deck-summary">
              {Object.entries(state.config.roleComposition)
                .filter(([, quantity]) => (quantity ?? 0) > 0)
                .map(([roleId, quantity]) => (
                  <div key={roleId}>
                    <span>{classicRoleById[roleId as keyof typeof classicRoleById].displayName}</span>
                    <strong>× {quantity}</strong>
                  </div>
                ))}
            </div>
            <button
              className="button primary full"
              disabled={!full}
              onClick={() => dispatch({ type: 'LOCK_AND_ASSIGN_ROLES' })}
            >
              Khóa phòng & chia vai
            </button>
            <p className="hint">
              Vai trò chưa được gán cho bất kỳ người chơi nào trước thao tác này.
            </p>
          </section>
        </aside>
      </div>
    </main>
  )
}

function ModeratorRoleReveal({ state, dispatch }: ModeratorViewProps) {
  const confirmed = new Set(state.roleRevealConfirmedPlayerIds)
  const allConfirmed = state.players.every((player) => confirmed.has(player.id))

  return (
    <main className="moderator-layout reveal-moderator">
      <div className="phase-heading">
        <div>
          <p className="eyebrow">Phòng {state.roomCode} · Đã khóa</p>
          <h1>CHIA VAI</h1>
          <p>Chờ từng người xem và xác nhận lá vai trò riêng.</p>
        </div>
        <div className="reveal-heading-status">
          <span className="phase-pill">ROLE REVEAL</span>
          <strong>{confirmed.size} / {state.players.length}</strong>
          <small>đã xác nhận</small>
        </div>
      </div>
      <section className="panel reveal-readiness">
        <div className="joined-list compact">
          {state.players.map((player) => {
            const assignment = state.roleAssignments.find(
              (entry) => entry.playerId === player.id,
            )
            return (
              <div className="joined-seat occupied" key={player.id}>
                <span>{String(player.seat).padStart(2, '0')}</span>
                <strong>{player.alias}</strong>
                <small>
                  <span>
                    {assignment
                      ? classicRoleById[assignment.roleId].displayName
                      : 'Chưa gán'}
                  </span>
                  <span className={confirmed.has(player.id) ? 'confirmed' : 'pending'}>
                    {confirmed.has(player.id) ? 'Đã xác nhận' : 'Đang xem'}
                  </span>
                </small>
              </div>
            )
          })}
        </div>
        <button
          className="button primary full"
          disabled={!allConfirmed}
          onClick={() => dispatch({ type: 'START_NIGHT' })}
        >
          Bắt đầu ván · Đêm 1
        </button>
      </section>
    </main>
  )
}

function WolfActionPanel({
  state,
  action,
  dispatch,
}: ModeratorViewProps & { action: NightAction }) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const allConfirmed = action.eligibleActorIds.every((playerId) =>
    action.confirmedActorIds.includes(playerId),
  )
  const deadlineAt = action.wolf?.deadlineAt

  useEffect(() => {
    if (!deadlineAt || action.status !== 'OPEN') return

    const tick = () => {
      const remaining = Math.max(0, deadlineAt - Date.now())
      setSecondsLeft(Math.ceil(remaining / 1000))
      if (remaining === 0) {
        void dispatch({ type: 'RESOLVE_WOLF_VOTE', atDeadline: true })
      }
    }
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [action.status, deadlineAt, dispatch])

  if (action.status !== 'OPEN') {
    return null
  }

  return (
    <div className="action-monitor">
      <div className="monitor-line">
        <span>
          {action.wolf?.round === 'REVOTE' ? 'Lượt chọn lại' : 'Phiếu đã xác nhận'}
        </span>
        <strong>
          {action.confirmedActorIds.length}/{action.eligibleActorIds.length}
        </strong>
      </div>
      {secondsLeft !== null && (
        <div className="countdown" aria-live="polite">
          00:{String(secondsLeft).padStart(2, '0')}
        </div>
      )}
      <div className="vote-details">
        {action.eligibleActorIds.map((actorId) => (
          <div key={actorId}>
            <span>{playerName(state, actorId)}</span>
            <strong>
              {Object.prototype.hasOwnProperty.call(action.selections, actorId)
                ? action.selections[actorId]
                  ? playerName(state, action.selections[actorId])
                  : 'Không chọn'
                : 'Đang chờ'}
            </strong>
          </div>
        ))}
      </div>
      <button
        className="button primary full"
        disabled={!allConfirmed}
        onClick={() => dispatch({ type: 'RESOLVE_WOLF_VOTE' })}
      >
        {action.wolf?.round === 'REVOTE'
          ? 'Chốt sớm lượt chọn lại'
          : 'Phân giải phiếu Ma Sói'}
      </button>
    </div>
  )
}

function ActionResult({ state, action }: { state: RoomState; action: NightAction }) {
  if (action.seer) {
    return (
      <div className="final-target">
        <span>
          Tiên Tri · {action.seer.result === 'WOLF' ? 'SÓI' : 'KHÔNG PHẢI SÓI'}
        </span>
        <strong>{playerName(state, action.seer.targetId)}</strong>
      </div>
    )
  }

  if (action.result) {
    return (
      <div className="final-target">
        <span>
          {action.result.random ? 'Đã chọn ngẫu nhiên' : 'Đã chọn'}
        </span>
        <strong>{playerName(state, action.result.targetId)}</strong>
      </div>
    )
  }

  if (action.status === 'COMPLETED') {
    return (
      <div className="action-summary">
        {Object.entries(action.selections).map(([actorId, targetId]) => (
          <span key={actorId}>
            {playerName(state, actorId)} → {playerName(state, targetId)}
          </span>
        ))}
      </div>
    )
  }

  return null
}

function NightResolutionPanel({ state, dispatch }: ModeratorViewProps) {
  const night = state.night
  if (!night) return null
  const resolution =
    state.nightResolution?.nightNumber === state.dayNumber
      ? state.nightResolution
      : null
  const readiness = getNightResolutionReadiness({
    configuredRoleIds: state.config.nightRoleIds,
    calls: night.calls,
  })

  if (!resolution) {
    const pendingNames = readiness.incompleteRoleIds.map(
      (roleId) => classicRoleById[roleId].displayName,
    )
    return (
      <div className="night-resolution-summary pending-resolution">
        <div>
          <p className="eyebrow">Tổng hợp hiệu ứng đêm</p>
          <strong>
            {readiness.ready
              ? 'Đã đủ dữ liệu Ma Sói · Bảo Vệ'
              : `Chờ hoàn tất: ${pendingNames.join(', ')}`}
          </strong>
        </div>
        <button
          className="button primary"
          disabled={!readiness.ready}
          onClick={() => dispatch({ type: 'RESOLVE_NIGHT_EFFECTS' })}
        >
          Phân giải đòn đêm
        </button>
      </div>
    )
  }

  const wolfEffect = resolution.effects.find(
    (effect) => effect.sourceType === 'WOLF_ATTACK',
  )
  return (
    <div className="night-resolution-summary resolved-resolution">
      <div>
        <p className="eyebrow">Tổng hợp hiệu ứng đêm</p>
        {resolution.outcome === 'NO_ATTACK' ? (
          <strong>Không có đòn tấn công Ma Sói.</strong>
        ) : (
          <>
            <span>
              Ma Sói tấn công: <strong>{playerName(state, wolfEffect?.targetPlayerId)}</strong>
            </span>
            {resolution.outcome === 'BLOCKED' ? (
              <strong>Bảo Vệ đã chặn đòn tấn công.</strong>
            ) : (
              <strong>
                Ứng viên tử vong đêm nay: {playerName(state, wolfEffect?.targetPlayerId)}
              </strong>
            )}
          </>
        )}
      </div>
      <small>Trạng thái tạm thời · chưa áp dụng tử vong cuối.</small>
    </div>
  )
}

function WitchFinalizationPanel({ state, dispatch }: ModeratorViewProps) {
  const night = state.night
  if (!night) return null
  const resolutionReady =
    state.nightResolution?.nightNumber === state.dayNumber
  const checkpoint =
    state.witchCheckpoint?.nightNumber === state.dayNumber
      ? state.witchCheckpoint
      : null
  const witchConfigured = state.config.nightRoleIds.includes('witch')
  const witchComplete =
    night.calls.find((call) => call.roleId === 'witch')?.status === 'COMPLETED'
  const canFinalize =
    resolutionReady && (!witchConfigured || witchComplete)

  if (checkpoint) {
    return (
      <div className="night-resolution-summary resolved-resolution morning-ready">
        <div>
          <p className="eyebrow">Checkpoint cuối Đêm</p>
          {checkpoint.rescuedPlayerIds.map((playerId) => (
            <span key={`rescued-${playerId}`}>
              Đã cứu: <strong>{playerName(state, playerId)}</strong>
            </span>
          ))}
          {checkpoint.finalDeaths.length === 0 ? (
            <strong>Không có tử vong cuối Đêm.</strong>
          ) : (
            checkpoint.finalDeaths.map((death) => (
              <strong key={death.playerId}>
                Tử vong đã chốt: {playerName(state, death.playerId)}
              </strong>
            ))
          )}
          <small>Server đã áp dụng · vẫn giữ phase Đêm.</small>
        </div>
        <button
          className="button primary"
          onClick={() => dispatch({ type: 'START_DAY' })}
        >
          Công bố buổi sáng
        </button>
      </div>
    )
  }

  return (
    <div className="night-resolution-summary pending-resolution">
      <div>
        <p className="eyebrow">Checkpoint cuối Đêm</p>
        <strong>
          {!resolutionReady
            ? 'Chờ phân giải hiệu ứng đầu Đêm.'
            : witchConfigured && !witchComplete
              ? 'Chờ hoàn tất nghi thức Phù Thủy.'
              : 'Sẵn sàng chốt tử vong hiện tại.'}
        </strong>
      </div>
      <button
        className="button primary"
        disabled={!canFinalize}
        onClick={() => dispatch({ type: 'FINALIZE_NIGHT_CHECKPOINT' })}
      >
        Chốt tử vong Đêm
      </button>
    </div>
  )
}

function NightPanel({ state, dispatch }: ModeratorViewProps) {
  const night = state.night
  if (!night) return null
  const preWitchComplete = getPreWitchNightRoleIds(
    state.config.nightRoleIds,
  ).every(
    (roleId) =>
      night.calls.find((call) => call.roleId === roleId)?.status ===
      'COMPLETED',
  )

  return (
    <section className="panel night-panel">
      <div className="section-title">
        <div>
          <p className="eyebrow">Nghi thức do con người điều khiển</p>
          <h2>Danh sách gọi role</h2>
        </div>
        <span className="policy-chip">{state.config.wolfPolicy}</span>
      </div>
      <p className="ritual-note">
        Nói lời gọi ngoài đời trước, sau đó mới bấm Gọi. Mỗi role cấu hình đều
        phải được gọi.
      </p>
      <div className="night-calls">
        {night.calls.map((call) => {
          const displayName = classicRoleById[call.roleId].displayName
          const action = night.actionsByRole[call.roleId]
          const isActive = night.activeRoleId === call.roleId

          return (
            <article className={`call-row ${isActive ? 'active-call' : ''}`} key={call.roleId}>
              <div className="call-main">
                <div>
                  <strong>{displayName}</strong>
                  <small>
                    {call.status === 'NOT_CALLED'
                      ? 'Chưa gọi'
                      : call.status === 'COMPLETED'
                        ? 'Đã gọi'
                        : 'Đang gọi'}
                  </small>
                </div>
                {call.status === 'NOT_CALLED' ? (
                  <button
                    className="button call-button"
                    disabled={
                      night.activeRoleId !== null ||
                      (call.roleId === 'witch' &&
                        (!preWitchComplete ||
                          state.nightResolution?.nightNumber !== state.dayNumber))
                    }
                    onClick={() =>
                      dispatch({ type: 'CALL_NIGHT_ROLE', roleId: call.roleId })
                    }
                  >
                    Gọi {displayName}
                  </button>
                ) : (
                  <span className={`call-status status-${call.status.toLowerCase()}`}>
                    {call.status === 'COMPLETED' ? '✓ Đã gọi' : '… Đang gọi'}
                  </span>
                )}
              </div>

              {isActive && action?.kind === 'WOLF_VOTE' && (
                <WolfActionPanel state={state} action={action} dispatch={dispatch} />
              )}
              {isActive && !action && (
                <div className="action-monitor silent-call">
                  <p>
                    Khi hành động hoặc nhịp gọi ngoài đời đã xong, xác nhận để
                    tiếp tục.
                  </p>
                  <button
                    className="button primary full"
                    onClick={() =>
                      dispatch({
                        type: 'COMPLETE_NIGHT_CALL',
                        roleId: call.roleId,
                      })
                    }
                  >
                    Xác nhận đã gọi
                  </button>
                </div>
              )}
              {isActive && action?.kind === 'SELECT_TARGET' && (
                <div className="action-monitor silent-call">
                  <p>Đang chờ hành động riêng trên điện thoại người chơi.</p>
                </div>
              )}
              {isActive && action?.kind === 'HUNTER_PRELOCK' && (
                <div className="action-monitor silent-call">
                  <p>Đang chờ Thợ Săn khóa trước mục tiêu riêng.</p>
                </div>
              )}
              {isActive && action?.kind === 'WITCH_DECISION' && (
                <div className="action-monitor silent-call">
                  <p>Đang chờ quyết định kết hợp trên điện thoại Phù Thủy.</p>
                </div>
              )}
              {action && <ActionResult state={state} action={action} />}
            </article>
          )
        })}
      </div>
      <NightResolutionPanel state={state} dispatch={dispatch} />
      <WitchFinalizationPanel state={state} dispatch={dispatch} />
    </section>
  )
}

function DayPanel({ state, dispatch }: ModeratorViewProps) {
  const finalDeaths = state.witchCheckpoint?.finalDeaths ?? []
  const vote = state.dayVote
  const secondsLeft = useCountdownSeconds(vote?.deadlineAt)
  const livingIds = state.players
    .filter((player) => player.alive)
    .map((player) => player.id)
  const totals =
    vote?.totals ??
    (vote
      ? resolveDayVote(
          vote.votes,
          livingIds,
          livingIds,
          Object.fromEntries(
            livingIds.map((playerId) => [
              playerId,
              getDayVoteWeight(
                state.roleAssignments.find(
                  (assignment) => assignment.playerId === playerId,
                )?.roleId,
              ),
            ]),
          ),
        ).counts
      : {})
  const hangedPlayerId =
    vote?.result?.kind === 'UNIQUE' ? vote.result.targetIds[0] : undefined
  const consequencesStable =
    vote?.status === 'CLOSED' && vote.hunterRevenge?.status !== 'PENDING'
  return (
    <section className="panel day-panel">
      <div className="section-title">
        <div>
          <p className="eyebrow">Buổi sáng do Quản trò công bố</p>
          <h2>Thảo luận ban ngày</h2>
        </div>
      </div>
      <div className="morning-summary">
        <span>Kết quả Đêm để Quản trò tự công bố</span>
        {finalDeaths.length === 0 ? (
          <strong>Không có người chết trong Đêm.</strong>
        ) : (
          finalDeaths.map((death) => (
            <strong key={death.playerId}>{playerName(state, death.playerId)}</strong>
          ))
        )}
        <small>Không công khai vai trò · không tự mở bỏ phiếu.</small>
      </div>
      <div className="day-discussion-note">
        {!vote && (
          <>
            <strong>Thảo luận không giới hạn thời gian.</strong>
            <span>Chỉ bộ đếm bỏ phiếu mới kéo dài đúng 30 giây.</span>
            <button
              className="button primary full"
              onClick={() => dispatch({ type: 'OPEN_DAY_VOTE' })}
            >
              Bắt đầu bỏ phiếu
            </button>
          </>
        )}
        {vote?.status === 'OPEN' && (
          <>
            <div className="day-vote-heading">
              <strong>Bỏ phiếu · 00:{String(secondsLeft).padStart(2, '0')}</strong>
              <span>Deadline do máy chủ sở hữu.</span>
            </div>
            <div className="day-vote-totals">
              {state.players
                .filter((player) => player.alive)
                .map((player) => (
                  <div key={player.id}>
                    <span>{playerLabel(player)}</span>
                    <strong>{totals[player.id] ?? 0}</strong>
                  </div>
                ))}
            </div>
            <button
              className="button primary full"
              disabled={secondsLeft > 0}
              onClick={() => dispatch({ type: 'CLOSE_DAY_VOTE' })}
            >
              {secondsLeft > 0 ? 'Không thể chốt sớm' : 'Chốt kết quả bỏ phiếu'}
            </button>
          </>
        )}
        {vote?.status === 'CLOSED' && (
          <>
            <div className="day-vote-result">
              <span>Kết quả có thẩm quyền</span>
              <strong>
                {vote.result?.kind === 'UNIQUE'
                  ? `Đã treo cổ: ${playerName(state, hangedPlayerId)}`
                  : vote.result?.kind === 'TIE'
                    ? 'Hòa cao nhất · không ai bị treo cổ.'
                    : 'Tất cả bỏ phiếu trắng · không ai bị treo cổ.'}
              </strong>
              {vote.hunterRevenge && (
                <small>
                  Thợ Săn đã được công khai ·{' '}
                  {vote.hunterRevenge.status === 'PENDING'
                    ? 'đang chọn người đi cùng.'
                    : vote.hunterRevenge.targetPlayerId
                      ? `đã bắn ${playerName(state, vote.hunterRevenge.targetPlayerId)}.`
                      : 'đã chọn Không ai.'}
                </small>
              )}
            </div>
            {consequencesStable && (
              <button
                className="button primary full"
                onClick={() => dispatch({ type: 'START_NEXT_NIGHT' })}
              >
                Bắt đầu Đêm {state.dayNumber + 1}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function Roster({ state, dispatch }: ModeratorViewProps) {
  return (
    <section className="panel roster-panel">
      <div className="section-title">
        <div>
          <p className="eyebrow">Thông tin riêng của Quản trò</p>
          <h2>Ghế & trạng thái</h2>
        </div>
      </div>
      <div className="roster">
        {state.players.map((player) => {
          const assignment = state.roleAssignments.find(
            (entry) => entry.playerId === player.id,
          )
          return (
            <div className={`roster-row ${player.alive ? '' : 'dead'}`} key={player.id}>
              <div>
                <strong>{playerLabel(player)}</strong>
                <span>
                  {assignment
                    ? classicRoleById[assignment.roleId].displayName
                    : 'Chưa gán'}
                </span>
              </div>
              <button
                className={`button tiny ${player.alive ? 'secondary' : 'ghost'}`}
                onClick={() =>
                  dispatch({
                    type: 'MODERATOR_SET_ALIVE',
                    playerId: player.id,
                    alive: !player.alive,
                    reason: 'Điều chỉnh tại bàn bởi Quản trò',
                  })
                }
              >
                {player.alive ? 'Đánh dấu chết' : 'Khôi phục sống'}
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Journal({ state }: { state: RoomState }) {
  const recentEvents = useMemo(() => [...state.journal].reverse(), [state.journal])

  return (
    <details className="panel journal-panel">
      <summary>
        <span>
          <span className="eyebrow">Development inspector</span>
          <strong>Match journal</strong>
        </span>
        <span>{state.journal.length} events</span>
      </summary>
      <div className="journal-list">
        {recentEvents.map((event) => (
          <article key={event.id}>
            <time>{new Date(event.timestamp).toLocaleTimeString('vi-VN')}</time>
            <div>
              <strong>{event.type}</strong>
              <span>
                {event.actorPlayerId && `actor=${playerName(state, event.actorPlayerId)} `}
                {event.actorRoleId && `role=${event.actorRoleId} `}
                {event.targetPlayerId && `target=${playerName(state, event.targetPlayerId)} `}
                {event.resolution && `result=${event.resolution}`}
              </span>
              {event.metadata && <code>{JSON.stringify(event.metadata)}</code>}
            </div>
          </article>
        ))}
      </div>
    </details>
  )
}

export function ModeratorView({ state, dispatch }: ModeratorViewProps) {
  if (state.lifecycle === 'LOBBY') {
    return <ModeratorLobby state={state} dispatch={dispatch} />
  }
  if (state.lifecycle === 'ROLE_REVEAL') {
    return <ModeratorRoleReveal state={state} dispatch={dispatch} />
  }

  return (
    <main className="moderator-layout">
      <PhaseHeader state={state} />
      <div className="moderator-grid">
        <div className="primary-column">
          {state.phase === 'SETUP' && <SetupPanel state={state} dispatch={dispatch} />}
          {state.phase === 'NIGHT' && <NightPanel state={state} dispatch={dispatch} />}
          {state.phase === 'DAY' && <DayPanel state={state} dispatch={dispatch} />}
        </div>
        <aside>
          <Roster state={state} dispatch={dispatch} />
        </aside>
      </div>
      {import.meta.env.DEV && <Journal state={state} />}
    </main>
  )
}
