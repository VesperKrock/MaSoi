import { useMemo, useState } from 'react'
import { AppShell } from '../../components/app-shell'
import {
  countSelectedRoles,
  maximumSeatCount,
  minimumSeatCount,
} from '../../domain/game/room-setup'
import {
  getOfflineEligibleActionTargetIds,
  getOfflinePlayers,
  getOfflineRoleHolderIds,
  getUnassignedOfflinePlayerIds,
  validateOfflineSetup,
  type OfflineSessionCommand,
  type OfflineSessionState,
} from '../../domain/offline/offline-session'
import { projectOfflineModeratorJournal } from '../../domain/offline/offline-journal'
import type { OfflineSessionStorageStatus } from '../../domain/offline/offline-storage'
import {
  classicRoleById,
  classicRoleCatalog,
  roleMarketGroupLabels,
  type RoleId,
  type RoleMarketGroup,
} from '../../domain/roles/classic-catalog'
import { useOfflineSession } from '../../state/use-offline-session'
import { appUrl } from '../../lib/app-url'
import { ModeratorJournalView } from '../journal/moderator-journal-view'
import { OfflineMatchView } from './offline-match-view'

const groupOrder: RoleMarketGroup[] = [
  'VILLAGE',
  'WEREWOLF',
  'INDEPENDENT',
  'SPECIAL',
]

function OfflineSetup({
  state,
  dispatch,
}: {
  state: OfflineSessionState
  dispatch: (command: OfflineSessionCommand) => void
}) {
  const validation = useMemo(() => validateOfflineSetup(state), [state])
  const selectedCount = countSelectedRoles(state.roleComposition)

  const setQuantity = (roleId: RoleId, quantity: number) => {
    dispatch({ type: 'SET_ROLE_QUANTITY', roleId, quantity })
  }

  const countMessage =
    selectedCount < state.seatCount
      ? `Còn thiếu ${state.seatCount - selectedCount} vai trò.`
      : selectedCount > state.seatCount
        ? `Đang dư ${selectedCount - state.seatCount} vai trò.`
        : 'Bộ bài đã đủ số người.'

  return (
    <main className="offline-layout offline-setup-layout">
      <header className="offline-heading">
        <div>
          <p className="eyebrow">Quản trò 1 máy · Offline</p>
          <h1>Chuẩn bị ván vật lý</h1>
          <p>Nhập đúng thứ tự chỗ ngồi và số lá thật sẽ được chia.</p>
        </div>
        <span className="offline-phase-pill">THIẾT LẬP</span>
      </header>

      <section className="panel offline-basics">
        <label>
          Số người chơi
          <select
            value={state.seatCount}
            onChange={(event) =>
              dispatch({
                type: 'SET_SEAT_COUNT',
                seatCount: Number(event.target.value),
              })
            }
          >
            {Array.from(
              { length: maximumSeatCount - minimumSeatCount + 1 },
              (_, index) => minimumSeatCount + index,
            ).map((count) => (
              <option key={count}>{count}</option>
            ))}
          </select>
        </label>
        <div className={`selection-meter ${selectedCount === state.seatCount ? 'complete' : ''}`}>
          <span>Bộ bài vật lý</span>
          <strong>{selectedCount} / {state.seatCount}</strong>
          <small>{countMessage}</small>
        </div>
      </section>

      <section className="panel offline-names-panel">
        <div className="section-title">
          <div>
            <p className="eyebrow">Theo thứ tự chỗ ngồi</p>
            <h2>Tên người chơi</h2>
          </div>
          <span>{state.seatCount} người</span>
        </div>
        <div className="offline-name-grid">
          {state.playerNames.map((name, index) => {
            const nameError = validation.nameErrors[index]
            return (
              <label className="offline-name-field" key={index}>
                <span>#{index + 1}</span>
                <input
                  value={name}
                  maxLength={40}
                  autoComplete="off"
                  placeholder={`Người chơi ${index + 1}`}
                  aria-label={`Tên người chơi ${index + 1}`}
                  aria-invalid={Boolean(nameError && name)}
                  onChange={(event) =>
                    dispatch({
                      type: 'SET_PLAYER_NAME',
                      index,
                      name: event.target.value,
                    })
                  }
                />
                {nameError && name && <small>{nameError}</small>}
              </label>
            )
          })}
        </div>
      </section>

      <div className="role-market offline-role-market">
        {groupOrder.map((group) => (
          <section className="market-group panel" key={group}>
            <div className="market-group-heading">
              <p className="eyebrow">{roleMarketGroupLabels[group]}</p>
              <span>
                {classicRoleCatalog
                  .filter((role) => role.marketGroup === group)
                  .reduce(
                    (total, role) =>
                      total + (state.roleComposition[role.id] ?? 0),
                    0,
                  )}{' '}
                lá
              </span>
            </div>
            <div className="market-rows">
              {classicRoleCatalog
                .filter((role) => role.marketGroup === group)
                .map((role) => {
                  const quantity = state.roleComposition[role.id] ?? 0
                  return (
                    <article className="market-role" key={role.id}>
                      <div className="offline-role-copy">
                        <strong>{role.displayName}</strong>
                        <span>
                          {role.quantityMode === 'MULTIPLE'
                            ? 'Có thể dùng nhiều lá'
                            : 'Tối đa 1 lá'}
                        </span>
                      </div>
                      {role.quantityMode === 'MULTIPLE' ? (
                        <div
                          className="quantity-control"
                          aria-label={`Số lượng ${role.displayName}`}
                        >
                          <button
                            aria-label={`Giảm ${role.displayName}`}
                            onClick={() => setQuantity(role.id, quantity - 1)}
                            disabled={quantity === 0}
                          >
                            −
                          </button>
                          <strong>{quantity}</strong>
                          <button
                            aria-label={`Tăng ${role.displayName}`}
                            onClick={() => setQuantity(role.id, quantity + 1)}
                            disabled={quantity >= state.seatCount}
                          >
                            +
                          </button>
                        </div>
                      ) : (
                        <button
                          className={`singleton-toggle ${quantity === 1 ? 'selected' : ''}`}
                          onClick={() =>
                            setQuantity(role.id, quantity === 1 ? 0 : 1)
                          }
                        >
                          {quantity === 1 ? '✓ Đã chọn' : '+ Thêm'}
                        </button>
                      )}
                    </article>
                  )
                })}
            </div>
          </section>
        ))}
      </div>

      <div className="offline-sticky-footer">
        <div>
          <strong>{selectedCount} / {state.seatCount} lá</strong>
          <span>{validation.valid ? 'Tên và bộ bài hợp lệ.' : countMessage}</span>
          {state.blockingError && (
            <span className="inline-error" role="alert">
              {state.blockingError}
            </span>
          )}
        </div>
        <button
          className="button primary"
          disabled={!validation.valid}
          onClick={() => dispatch({ type: 'CONTINUE_TO_PHYSICAL_DEAL' })}
        >
          Xác nhận thiết lập
        </button>
      </div>
    </main>
  )
}

function PhysicalDeal({
  state,
  dispatch,
}: {
  state: OfflineSessionState
  dispatch: (command: OfflineSessionCommand) => void
}) {
  const players = getOfflinePlayers(state)
  return (
    <main className="offline-layout offline-checkpoint-layout">
      <header className="offline-heading">
        <div>
          <p className="eyebrow">Checkpoint vật lý</p>
          <h1>Chia bài thật</h1>
          <p>Ứng dụng chưa biết người nào đang giữ vai nào.</p>
        </div>
        <span className="offline-phase-pill">CHIA BÀI</span>
      </header>

      <section className="panel offline-deal-instruction">
        <span className="offline-ritual-mark" aria-hidden="true">12</span>
        <div>
          <p className="eyebrow">Không xáo hoặc gán vai trong ứng dụng</p>
          <h2>Hãy chia các lá bài vật lý</h2>
          <p>
            Dùng đúng bộ bài đã cấu hình. Mỗi người tự xem lá của mình rồi úp
            xuống. Khi tất cả đã sẵn sàng, bắt đầu nghi thức Đêm 1.
          </p>
        </div>
      </section>

      <div className="offline-checkpoint-grid">
        <section className="panel">
          <div className="section-title">
            <h2>Thứ tự người chơi</h2>
            <span>{players.length} người</span>
          </div>
          <ol className="offline-roster-list">
            {players.map((player) => (
              <li key={player.id}>
                <span>#{player.seat}</span>
                <strong>{player.alias}</strong>
              </li>
            ))}
          </ol>
        </section>
        <section className="panel">
          <div className="section-title">
            <h2>Bộ bài vật lý</h2>
            <span>{state.seatCount} lá</span>
          </div>
          <div className="offline-deck-list">
            {classicRoleCatalog
              .filter((role) => (state.roleComposition[role.id] ?? 0) > 0)
              .map((role) => (
                <div key={role.id}>
                  <strong>{role.displayName}</strong>
                  <span>× {state.roleComposition[role.id]}</span>
                </div>
              ))}
          </div>
        </section>
      </div>

      <button
        className="button primary offline-primary-action"
        onClick={() => dispatch({ type: 'BEGIN_NIGHT_ONE_DISCOVERY' })}
      >
        Bắt đầu Đêm 1 — khám phá vai
      </button>
    </main>
  )
}

function NightOneDiscovery({
  state,
  dispatch,
}: {
  state: OfflineSessionState
  dispatch: (command: OfflineSessionCommand) => void
}) {
  const players = getOfflinePlayers(state)
  const playerById = new Map(players.map((player) => [player.id, player]))
  const step = state.nightOne.activeStep
  if (!step) return null
  const role = classicRoleById[step.roleId]
  const callNumber = state.nightOne.callIndex + 1

  if (step.kind === 'HOLDER_DISCOVERY') {
    const unassignedIds = getUnassignedOfflinePlayerIds(state)
    const selectedIds = new Set(state.nightOne.draftHolderIds)
    return (
      <main className="offline-layout offline-discovery-layout">
        <header className="offline-heading">
          <div>
            <p className="eyebrow">
              Đêm 1 · Lượt {callNumber}/{state.nightOne.callPlan.length}
            </p>
            <h1>AI LÀ {role.displayName.toLocaleUpperCase('vi')}?</h1>
            <p>Chỉ chọn người chưa được xác định vai.</p>
          </div>
          <span className="offline-phase-pill">TÌM NGƯỜI GIỮ VAI</span>
        </header>

        <section className="panel offline-holder-panel">
          <div className="offline-selection-status">
            <span>Cần chọn đúng</span>
            <strong>
              {state.nightOne.draftHolderIds.length} / {step.requiredHolderCount}
            </strong>
          </div>
          <div className="offline-holder-selector" aria-label={`Người giữ vai ${role.displayName}`}>
            {unassignedIds.map((playerId) => {
              const player = playerById.get(playerId)
              if (!player) return null
              const selected = selectedIds.has(playerId)
              return (
                <button
                  className={selected ? 'selected' : ''}
                  key={player.id}
                  aria-pressed={selected}
                  onClick={() => dispatch({ type: 'TOGGLE_HOLDER', playerId })}
                >
                  <span>#{player.seat}</span>
                  <strong>{player.alias}</strong>
                  <small>{selected ? 'Đã chọn' : 'Chưa có vai'}</small>
                </button>
              )
            })}
          </div>
          {state.blockingError && (
            <p className="inline-error" role="alert">
              {state.blockingError}
            </p>
          )}
          <button
            className="button primary offline-primary-action"
            disabled={
              state.nightOne.draftHolderIds.length !== step.requiredHolderCount
            }
            onClick={() => dispatch({ type: 'CONFIRM_HOLDERS' })}
          >
            Xác nhận người giữ vai
          </button>
        </section>
      </main>
    )
  }

  const holderIds = getOfflineRoleHolderIds(state, step.roleId)
  const targetIds = getOfflineEligibleActionTargetIds(state)
  const noAction = step.actionType === 'NONE'
  return (
    <main className="offline-layout offline-discovery-layout">
      <header className="offline-heading">
        <div>
          <p className="eyebrow">
            Đêm 1 · Lượt {callNumber}/{state.nightOne.callPlan.length}
          </p>
          <h1>{role.displayName}</h1>
          <p>
            Người giữ vai:{' '}
            <strong>
              {holderIds
                .map((playerId) => playerById.get(playerId)?.alias)
                .join(', ')}
            </strong>
          </p>
        </div>
        <span className="offline-phase-pill">ROLE_ACTION · {step.actionType}</span>
      </header>

      <section className="panel offline-action-handoff">
        {noAction ? (
          <div className="offline-no-action">
            <span aria-hidden="true">—</span>
            <h2>Vai này không có hành động Đêm</h2>
            <p>Danh tính đã được ghi nhận. Kết thúc lượt gọi theo nghi thức.</p>
          </div>
        ) : (
          <>
            <div className="section-title">
              <div>
                <p className="eyebrow">Tách biệt khỏi người giữ vai</p>
                <h2>Mục tiêu hành động hợp lệ</h2>
              </div>
              <span>{targetIds.length} người</span>
            </div>
            {targetIds.length > 0 ? (
              <div className="offline-action-targets" aria-label="Mục tiêu hành động hợp lệ">
                {targetIds.map((playerId) => {
                  const player = playerById.get(playerId)
                  return player ? (
                    <div key={player.id}>
                      <span>#{player.seat}</span>
                      <strong>{player.alias}</strong>
                    </div>
                  ) : null
                })}
              </div>
            ) : (
              <p className="hint">
                Vai này dùng checkpoint riêng hoặc chưa có target trực tiếp.
              </p>
            )}
          </>
        )}

        {state.blockingError && (
          <p className="inline-error" role="alert">
            {state.blockingError}
          </p>
        )}
        <button
          className="button primary offline-primary-action"
          onClick={() => dispatch({ type: 'ADVANCE_FROM_ROLE_ACTION' })}
        >
          {noAction ? '[ĐÃ GỌI — ĐI NGỦ]' : '[ĐÃ GỌI — CHUYỂN VAI KẾ TIẾP]'}
        </button>
      </section>
    </main>
  )
}

function NightOneReady({
  state,
  dispatch,
}: {
  state: OfflineSessionState
  dispatch: (command: OfflineSessionCommand) => void
}) {
  const players = getOfflinePlayers(state)
  const roleByPlayerId = new Map(
    state.roleAssignments.map((assignment) => [
      assignment.playerId,
      assignment.roleId,
    ]),
  )
  return (
    <main className="offline-layout offline-ready-layout">
      <header className="offline-heading">
        <div>
          <p className="eyebrow">Đêm 1 · Khám phá hoàn tất</p>
          <h1>Đã xác định đủ vai</h1>
          <p>Dân Làng còn lại đã được gán tự động đúng theo bộ bài.</p>
        </div>
        <span className="offline-phase-pill complete">SẴN SÀNG MS-O2</span>
      </header>
      <section className="panel offline-final-roster">
        <div className="section-title">
          <h2>Danh sách Quản trò</h2>
          <span>{state.roleAssignments.length} / {state.seatCount}</span>
        </div>
        <div className="offline-assignment-list">
          {players.map((player) => {
            const roleId = roleByPlayerId.get(player.id)
            return (
              <div key={player.id}>
                <span>#{player.seat}</span>
                <strong>{player.alias}</strong>
                <small>{roleId ? classicRoleById[roleId].displayName : 'Chưa gán'}</small>
              </div>
            )
          })}
        </div>
        {state.blockingError && (
          <p className="inline-error" role="alert">
            {state.blockingError}
          </p>
        )}
        <button
          className="button primary offline-primary-action"
          onClick={() => dispatch({ type: 'BEGIN_OFFLINE_MATCH' })}
        >
          Bắt đầu hành động Đêm 1
        </button>
      </section>
    </main>
  )
}

function OfflineSessionReplacement({
  status,
  onConfirm,
}: {
  status: OfflineSessionStorageStatus
  onConfirm: () => void
}) {
  const corrupt = status === 'CORRUPT'
  const finished = status === 'FINISHED'
  return (
    <main className="offline-layout offline-replacement-layout">
      <header className="offline-heading">
        <div>
          <p className="eyebrow">Offline · Xác nhận phá hủy dữ liệu</p>
          <h1>{corrupt ? 'Bản lưu không thể đọc' : 'Đang có ván được lưu'}</h1>
          <p>
            {corrupt
              ? 'Ứng dụng đã dừng khôi phục và chưa ghi đè lên bản lưu lỗi.'
              : finished
                ? 'Ván đã kết thúc và Nhật ký vẫn còn trên thiết bị này.'
                : 'Ván hiện tại chưa kết thúc. Bạn vẫn có thể quay lại tiếp tục.'}
          </p>
        </div>
        <span className="offline-phase-pill">XÁC NHẬN</span>
      </header>
      <section className="panel offline-replacement-card">
        <h2>Xóa ván Offline cũ và bắt đầu ván mới?</h2>
        <p>
          Thao tác này chỉ xóa namespace Offline trên thiết bị này. Phòng và
          phiên Online không bị thay đổi.
        </p>
        <div className="offline-replacement-actions">
          <a
            className="button secondary link-button"
            href={appUrl(corrupt ? '' : '?screen=offline')}
          >
            {corrupt ? 'Về trang chủ' : 'Giữ ván đã lưu'}
          </a>
          <button className="button danger" onClick={onConfirm}>
            Xóa và bắt đầu mới
          </button>
        </div>
      </section>
    </main>
  )
}

export function OfflineModeratorView() {
  const {
    state,
    dispatch,
    savedStatusAtEntry,
    startNewSession,
  } = useOfflineSession()
  const [journalOpen, setJournalOpen] = useState(false)
  const [replacementConfirmed, setReplacementConfirmed] = useState(false)
  const intentNew = new URLSearchParams(window.location.search).get('intent') === 'new'
  const requiresReplacementConfirmation =
    !replacementConfirmed &&
    (savedStatusAtEntry === 'CORRUPT' ||
      (intentNew && savedStatusAtEntry !== 'NONE'))
  const journal = useMemo(
    () => projectOfflineModeratorJournal(state),
    [state],
  )

  const confirmReplacement = () => {
    startNewSession()
    setReplacementConfirmed(true)
    window.history.replaceState({}, '', appUrl('?screen=offline'))
  }

  return (
    <AppShell authorityMode="OFFLINE">
      {requiresReplacementConfirmation ? (
        <OfflineSessionReplacement
          status={savedStatusAtEntry}
          onConfirm={confirmReplacement}
        />
      ) : journalOpen ? (
        <ModeratorJournalView
          journal={journal}
          onClose={() => setJournalOpen(false)}
        />
      ) : (
        <>
      {(savedStatusAtEntry === 'ACTIVE' || savedStatusAtEntry === 'FINISHED') && !intentNew && (
        <div className="offline-resume-notice" role="status">
          <strong>Đã khôi phục bản lưu Offline</strong>
          <span>
            {savedStatusAtEntry === 'FINISHED'
              ? 'Ván đã kết thúc · có thể mở Nhật ký.'
              : 'Tiếp tục đúng checkpoint đã lưu.'}
          </span>
        </div>
      )}
      {journal.facts.length > 0 && state.phase !== 'FINISHED' && (
        <div className="offline-session-tools">
          <button
            className="button secondary"
            onClick={() => setJournalOpen(true)}
          >
            Mở Nhật ký
          </button>
        </div>
      )}
      {state.phase === 'SETUP' && (
        <OfflineSetup state={state} dispatch={dispatch} />
      )}
      {state.phase === 'PHYSICAL_DEAL' && (
        <PhysicalDeal state={state} dispatch={dispatch} />
      )}
      {state.phase === 'NIGHT_1_DISCOVERY' && (
        <NightOneDiscovery state={state} dispatch={dispatch} />
      )}
      {state.phase === 'NIGHT_1_READY' && (
        <NightOneReady state={state} dispatch={dispatch} />
      )}
      {(state.phase === 'MATCH' || state.phase === 'FINISHED') && (
        <OfflineMatchView
          state={state}
          dispatch={dispatch}
          onOpenJournal={() => setJournalOpen(true)}
        />
      )}
        </>
      )}
    </AppShell>
  )
}
