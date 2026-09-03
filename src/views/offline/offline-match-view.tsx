import { useMemo } from 'react'
import { playerLabel } from '../../components/player-label'
import { projectEndMatch } from '../../domain/gameplay/end-match'
import {
  isHalfWolfTransformed,
  isTraitorConverted,
} from '../../domain/gameplay/faction-transitions'
import type { NightAction, PlayerId, RoleId, RoomState } from '../../domain/game/types'
import {
  getOfflineDiscoveryRoleIds,
  getOfflineRoleHolderIds,
  getUnassignedOfflinePlayerIds,
  type OfflineSessionCommand,
  type OfflineSessionState,
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

function runtimeLabel(room: RoomState, playerId: PlayerId) {
  if (isHalfWolfTransformed(room.factionTransitions, playerId)) {
    return 'Đã hóa Sói'
  }
  if (isTraitorConverted(room.factionTransitions, playerId)) {
    return 'Đã về Dân'
  }
  return ''
}

function OfflineRoster({
  state,
  room,
}: {
  state: OfflineSessionState
  room: RoomState
}) {
  const roleByPlayerId = new Map(
    state.roleAssignments.map((assignment) => [
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
                  {roleId ? classicRoleById[roleId].displayName : 'CHƯA KHÁM PHÁ'}
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

function ritualName(roleId: RoleId) {
  return roleId === 'werewolf'
    ? 'Phe Sói'
    : classicRoleById[roleId].displayName
}

function wakeCue(roleId: RoleId) {
  return roleId === 'werewolf'
    ? 'PHE SÓI DẬY ĐI'
    : `${classicRoleById[roleId].displayName.toLocaleUpperCase('vi')} DẬY ĐI`
}

function sleepCue(roleId: RoleId) {
  return roleId === 'werewolf'
    ? 'SÓI NGỦ ĐI'
    : `${classicRoleById[roleId].displayName.toLocaleUpperCase('vi')} NGỦ ĐI`
}

function HolderDiscovery({
  state,
  room,
  dispatch,
}: OfflineMatchProps & { room: RoomState }) {
  const step = state.nightRitual.activeStep
  if (step?.kind !== 'HOLDER_DISCOVERY') return null
  const discoveryRoleIds = getOfflineDiscoveryRoleIds(state, step.roleId)
  const unassignedIds = getUnassignedOfflinePlayerIds(state)
  const draftIds = new Set(
    Object.values(state.nightRitual.draftHolderIdsByRole).flatMap(
      (playerIds) => playerIds ?? [],
    ),
  )
  const complete = discoveryRoleIds.every((roleId) =>
    getOfflineRoleHolderIds(state, roleId).length +
      (state.nightRitual.draftHolderIdsByRole[roleId]?.length ?? 0) ===
    (state.roleComposition[roleId] ?? 0),
  )

  return (
    <section className="panel offline-active-call offline-holder-panel offline-interleaved-discovery">
      <p className="eyebrow">CALL · KHÁM PHÁ NẾU CHƯA BIẾT</p>
      <h2>{wakeCue(step.roleId)}</h2>
      <p>
        Xác nhận đúng holder rồi hành động ngay trong cùng lượt gọi. Người đã có
        vai không thể được gán lần nữa.
      </p>
      {discoveryRoleIds.map((roleId) => {
        const role = classicRoleById[roleId]
        const knownIds = getOfflineRoleHolderIds(state, roleId)
        const selectedIds = state.nightRitual.draftHolderIdsByRole[roleId] ?? []
        const requiredCount = state.roleComposition[roleId] ?? 0
        return (
          <section className="offline-holder-group" key={roleId}>
            <div className="offline-selection-status">
              <span>{role.displayName.toLocaleUpperCase('vi')}</span>
              <strong>{knownIds.length + selectedIds.length} / {requiredCount}</strong>
            </div>
            {knownIds.length > 0 && (
              <p className="hint">
                Đã biết: {knownIds.map((playerId) => nameFor(room, playerId)).join(', ')}
              </p>
            )}
            <div
              className="offline-holder-selector"
              aria-label={`Người giữ vai ${role.displayName}`}
            >
              {unassignedIds.map((playerId) => {
                const player = room.players.find((entry) => entry.id === playerId)
                if (!player) return null
                const selected = selectedIds.includes(playerId)
                const selectedForOtherRole = draftIds.has(playerId) && !selected
                return (
                  <button
                    className={selected ? 'selected' : ''}
                    disabled={selectedForOtherRole}
                    key={player.id}
                    aria-pressed={selected}
                    onClick={() => dispatch({ type: 'TOGGLE_HOLDER', roleId, playerId })}
                  >
                    <span>#{player.seat}</span>
                    <strong>{player.alias}</strong>
                    <small>{selected ? 'Đã chọn' : 'Chưa có vai'}</small>
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
      <button
        className="button primary full"
        disabled={!complete}
        onClick={() => dispatch({ type: 'CONFIRM_HOLDERS' })}
      >
        Xác nhận holder · hành động ngay
      </button>
    </section>
  )
}

function CompletedNightCall({
  state,
  room,
  dispatch,
}: OfflineMatchProps & { room: RoomState }) {
  const step = state.nightRitual.activeStep
  if (step?.kind !== 'CALL_COMPLETE') return null
  const holderRoleIds = getOfflineDiscoveryRoleIds(state, step.roleId)
  const holderNames = holderRoleIds.flatMap((roleId) =>
    getOfflineRoleHolderIds(state, roleId).map((playerId) => nameFor(room, playerId)),
  )
  return (
    <section className="panel offline-active-call offline-call-complete">
      <p className="eyebrow">HÀNH ĐỘNG ĐÃ LƯU · HOÀN TẤT LƯỢT GỌI</p>
      <h2>{sleepCue(step.roleId)}</h2>
      <p>
        {holderNames.length > 0
          ? `Holder: ${holderNames.join(', ')}. Dữ liệu đã được lưu trên thiết bị.`
          : `${ritualName(step.roleId)} đã hoàn tất.`}
      </p>
      <button
        className="button primary full"
        onClick={() => dispatch({ type: 'ADVANCE_FROM_COMPLETED_RITUAL' })}
      >
        Tiếp tục lượt gọi kế tiếp
      </button>
    </section>
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
        {action.seer.result === 'WOLF' ? 'SÓI' : 'KHÔNG PHẢI SÓI'}
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
  const holderNames = getOfflineDiscoveryRoleIds(state, roleId).flatMap(
    (holderRoleId) => getOfflineRoleHolderIds(state, holderRoleId)
      .map((playerId) => nameFor(room, playerId)),
  )
  const livingActorNames = (action?.eligibleActorIds ?? []).map((playerId) =>
    nameFor(room, playerId),
  )
  const targetDraft = state.authorityInput.nightTargetDraft
  const selectedTargetIds = targetDraft.kind === 'PLAYER'
    ? [targetDraft.playerId]
    : []

  if (!action || action.status !== 'OPEN') {
    return (
      <section className="panel offline-active-call">
        <p className="eyebrow">ĐÃ GỌI · {role.displayName}</p>
        <h2>{sleepCue(roleId)}</h2>
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
      <p className="eyebrow">ACTION · {action.kind}</p>
      <h2>{wakeCue(roleId)}</h2>
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
                ? 'HÃY CHỌN NGƯỜI CÁC NGƯƠI MUỐN GIẾT'
                : action.roleId === 'seer'
                  ? 'HÃY CHỌN NGƯỜI NGƯƠI MUỐN SOI'
                  : 'Chọn mục tiêu theo tên người chơi rồi xác nhận.'}
            </p>
            <TargetButtons
              room={room}
              targetIds={action.eligibleTargetIds}
              selectedIds={selectedTargetIds}
              onSelect={(targetId) =>
                dispatch({ type: 'SET_OFFLINE_NIGHT_TARGET_DRAFT', targetId })
              }
            />
            {(action.kind === 'HUNTER_PRELOCK' ||
              action.kind === 'SERIAL_KILLER_ATTACK') && (
              <button
                className={`button secondary full${targetDraft.kind === 'NOBODY' ? ' selected' : ''}`}
                aria-pressed={targetDraft.kind === 'NOBODY'}
                onClick={() =>
                  dispatch({ type: 'SET_OFFLINE_NIGHT_TARGET_DRAFT', targetId: null })
                }
              >
                Không ai
              </button>
            )}
            <button
              className="button primary full"
              disabled={targetDraft.kind === 'UNSET'}
              onClick={() => dispatch({ type: 'CONFIRM_OFFLINE_NIGHT_TARGET' })}
            >
              Xác nhận hành động
            </button>
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
  const ritualStep = state.nightRitual.activeStep
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
              className={`${call.status.toLocaleLowerCase()} ${night.activeRoleId === call.roleId || ritualStep?.roleId === call.roleId ? 'active' : ''}`}
              key={call.roleId}
            >
              {classicRoleById[call.roleId].displayName}
            </span>
          ))}
        </div>
      </section>

      {ritualStep?.kind === 'HOLDER_DISCOVERY' ? (
        <HolderDiscovery state={state} room={room} dispatch={dispatch} />
      ) : ritualStep?.kind === 'CALL_COMPLETE' ? (
        <CompletedNightCall state={state} room={room} dispatch={dispatch} />
      ) : loversPending ? (
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
          <h2>{wakeCue(nextCall.roleId)}</h2>
          <p>Gọi role ngoài đời rồi mở bước ghi nhận trên máy Quản trò.</p>
          <button
            className="button primary full"
            onClick={() => dispatch({ type: 'CALL_NEXT_OFFLINE_NIGHT_ROLE' })}
          >
            GỌI {ritualName(nextCall.roleId).toLocaleUpperCase('vi')}
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

function DayDecision({ state, room, dispatch }: OfflineMatchProps & { room: RoomState }) {
  const decision = state.authorityInput.dayDecision
  const livingIds = room.players
    .filter((player) => player.alive)
    .map((player) => player.id)

  if (decision.stage === 'CANDIDATE_DRAFT') {
    const candidateId = decision.selection.kind === 'PLAYER'
      ? decision.selection.playerId
      : null
    const noCandidate = decision.selection.kind === 'NO_CANDIDATE'
    return (
      <section className="panel offline-day-decision">
        <p className="eyebrow">Bản nháp · có thể đổi</p>
        <h2>Ai được đưa lên trăng trối?</h2>
        <p>Quản trò nhập kết quả đã thống nhất ngoài đời. Ứng dụng không ghi phiếu.</p>
        <TargetButtons
          room={room}
          targetIds={livingIds}
          selectedIds={candidateId ? [candidateId] : []}
          onSelect={(playerId) =>
            dispatch({ type: 'SET_OFFLINE_DAY_CANDIDATE_DRAFT', playerId })
          }
        />
        <button
          className={`button secondary full${noCandidate ? ' selected' : ''}`}
          aria-pressed={noCandidate}
          onClick={() => dispatch({ type: 'SET_OFFLINE_DAY_NO_CANDIDATE_DRAFT' })}
        >
          KHÔNG CÓ AI
        </button>
        {candidateId && (
          <button
            className="button primary full"
            onClick={() => dispatch({ type: 'LOCK_OFFLINE_DAY_CANDIDATE' })}
          >
            🔒 KHÓA NGƯỜI TRĂNG TRỐI
          </button>
        )}
        {noCandidate && (
          <div className="offline-final-confirmation">
            <strong>Xác nhận không có ai?</strong>
            <p>Ngày sẽ kết thúc ngay, không qua trăng trối hay treo cổ.</p>
            <button
              className="button primary full"
              onClick={() => dispatch({ type: 'CONFIRM_OFFLINE_NO_CANDIDATE' })}
            >
              XÁC NHẬN KHÔNG CÓ AI
            </button>
          </div>
        )}
      </section>
    )
  }

  if (decision.stage === 'LAST_WORDS') {
    return (
      <section className="panel offline-day-decision offline-last-words">
        <p className="eyebrow">Đã khóa · thảo luận ngoài đời</p>
        <h2>{nameFor(room, decision.candidatePlayerId)} ĐANG TRĂNG TRỐI</h2>
        <p>Người này vẫn còn sống. Sau biểu quyết ngoài đời, Quản trò chọn phán quyết.</p>
        <div className="offline-verdict-options">
          <button
            className={decision.verdictDraft === 'SPARE' ? 'selected' : ''}
            aria-pressed={decision.verdictDraft === 'SPARE'}
            onClick={() => dispatch({ type: 'SET_OFFLINE_DAY_VERDICT_DRAFT', verdict: 'SPARE' })}
          >
            THA
          </button>
          <button
            className={decision.verdictDraft === 'EXECUTE' ? 'selected danger' : 'danger'}
            aria-pressed={decision.verdictDraft === 'EXECUTE'}
            onClick={() => dispatch({ type: 'SET_OFFLINE_DAY_VERDICT_DRAFT', verdict: 'EXECUTE' })}
          >
            XỬ
          </button>
        </div>
        <button
          className="button primary full"
          disabled={!decision.verdictDraft}
          onClick={() => dispatch({ type: 'LOCK_OFFLINE_DAY_VERDICT' })}
        >
          TIẾP TỤC XÁC NHẬN {decision.verdictDraft === 'SPARE' ? 'THA' : decision.verdictDraft === 'EXECUTE' ? 'XỬ' : ''}
        </button>
      </section>
    )
  }

  return (
    <section className="panel offline-day-decision offline-final-confirmation">
      <p className="eyebrow">Xác nhận cuối · không thể hoàn tác</p>
      <h2>
        {decision.verdict === 'SPARE'
          ? `THA ${nameFor(room, decision.candidatePlayerId)}`
          : `XỬ ${nameFor(room, decision.candidatePlayerId)}`}
      </h2>
      <p>
        {decision.verdict === 'SPARE'
          ? 'Người này sống và Ngày kết thúc bình thường.'
          : 'Hệ thống sẽ áp dụng treo cổ và toàn bộ hậu quả shared rules.'}
      </p>
      <div className="offline-confirm-actions">
        <button
          className="button secondary"
          onClick={() => dispatch({ type: 'RETURN_OFFLINE_DAY_VERDICT_DRAFT' })}
        >
          Quay lại
        </button>
        <button
          className={`button full ${decision.verdict === 'EXECUTE' ? 'danger' : 'primary'}`}
          onClick={() => dispatch({ type: 'CONFIRM_OFFLINE_DAY_VERDICT' })}
        >
          XÁC NHẬN {decision.verdict === 'SPARE' ? 'THA' : 'XỬ'}
        </button>
      </div>
    </section>
  )
}

function DayLifecycle({ state, room, dispatch }: OfflineMatchProps & { room: RoomState }) {
  const verdict = room.dayVerdict
  const finalDeaths = room.witchCheckpoint?.finalDeaths ?? []
  const pendingRevenge = verdict?.hunterRevenge?.status === 'PENDING'

  return (
    <>
      {!verdict && (
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
          <p>Thảo luận và biểu quyết diễn ra ngoài đời. Quản trò chỉ ghi quyết định cuối.</p>
        </section>
      )}

      {!verdict && <DayDecision state={state} room={room} dispatch={dispatch} />}

      {verdict && pendingRevenge && (
        <section className="panel offline-hunter-revenge">
          <p className="eyebrow">Hunter Day revenge</p>
          <h2>THỢ SĂN CHỌN NGƯỜI ĐI CÙNG</h2>
          <p>{nameFor(room, verdict.hunterRevenge?.hunterPlayerId)} vừa bị treo cổ.</p>
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

      {verdict && !pendingRevenge && (
        <section className="panel offline-day-result">
          <p className="eyebrow">Kết quả có thẩm quyền</p>
          <h2>
            {verdict.outcome === 'EXECUTED'
              ? `Đã treo cổ ${nameFor(room, verdict.candidatePlayerId)}`
              : verdict.outcome === 'SPARED'
                ? `${nameFor(room, verdict.candidatePlayerId)} được tha`
                : 'Không ai được đưa lên trăng trối'}
          </h2>
          {verdict.hunterRevenge?.status === 'RESOLVED' && (
            <p>
              Thợ Săn:{' '}
              {verdict.hunterRevenge.targetPlayerId
                ? `đã bắn ${nameFor(room, verdict.hunterRevenge.targetPlayerId)}`
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
        <OfflineRoster state={state} room={room} />
      </div>
    </main>
  )
}
