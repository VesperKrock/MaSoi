import { useMemo, useState } from 'react'
import { AppShell } from '../../components/app-shell'
import {
  countSelectedRoles,
  defaultRoleComposition,
  maximumSeatCount,
  minimumSeatCount,
  validateRoomSetup,
  type RoleComposition,
} from '../../domain/game/room-setup'
import type { WolfPolicy } from '../../domain/game/types'
import {
  classicRoleCatalog,
  roleMarketGroupLabels,
  type RoleId,
  type RoleMarketGroup,
} from '../../domain/roles/classic-catalog'
import type { RoomTransport } from '../../transport/room-transport'

interface CreateRoomViewProps {
  transport: RoomTransport
}

const groupOrder: RoleMarketGroup[] = [
  'VILLAGE',
  'WEREWOLF',
  'INDEPENDENT',
  'SPECIAL',
]

export function CreateRoomView({ transport }: CreateRoomViewProps) {
  const [seatCount, setSeatCount] = useState(7)
  const [composition, setComposition] = useState<RoleComposition>(() =>
    defaultRoleComposition(7),
  )
  const [wolfPolicy, setWolfPolicy] =
    useState<WolfPolicy>('RANDOM_ON_TIE')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const validation = useMemo(
    () => validateRoomSetup({ seatCount, roleComposition: composition, wolfPolicy }),
    [composition, seatCount, wolfPolicy],
  )
  const selectedCount = countSelectedRoles(composition)

  const setQuantity = (roleId: RoleId, quantity: number) => {
    const role = classicRoleCatalog.find((entry) => entry.id === roleId)
    if (!role) return
    const nextQuantity = Math.max(
      0,
      Math.min(role.quantityMode === 'MULTIPLE' ? seatCount : 1, quantity),
    )
    setComposition((current) => ({ ...current, [roleId]: nextQuantity }))
  }

  const createRoom = async () => {
    if (!validation.valid) return
    setSubmitting(true)
    setError('')
    const result = await transport.createRoom({
      seatCount,
      roleComposition: composition,
      wolfPolicy,
    })
    setSubmitting(false)
    if (!result.ok || !result.roomId) {
      setError(result.error ?? 'Không thể tạo phòng local.')
      return
    }
    window.location.assign(
      `?room=${encodeURIComponent(result.roomId)}&as=moderator`,
    )
  }

  const countMessage =
    selectedCount < seatCount
      ? `Còn thiếu ${seatCount - selectedCount} vai trò.`
      : selectedCount > seatCount
        ? `Đang dư ${selectedCount - seatCount} vai trò.`
        : 'Đội hình đã đủ để tạo phòng.'

  return (
    <AppShell>
      <main className="create-room-layout">
        <header className="create-heading">
          <div>
            <p className="eyebrow">Thiết lập bởi Quản trò</p>
            <h1>Tạo phòng</h1>
            <p>Chọn đúng số lá vai trò trước khi mở Lobby.</p>
          </div>
          <div className={`selection-meter ${validation.valid ? 'complete' : ''}`}>
            <span>Đã chọn</span>
            <strong>{selectedCount} / {seatCount}</strong>
            <small>{countMessage}</small>
          </div>
        </header>

        <section className="panel room-basics">
          <label>
            Số người chơi
            <select
              value={seatCount}
              onChange={(event) => setSeatCount(Number(event.target.value))}
            >
              {Array.from(
                { length: maximumSeatCount - minimumSeatCount + 1 },
                (_, index) => minimumSeatCount + index,
              ).map((count) => <option key={count}>{count}</option>)}
            </select>
          </label>
          <label>
            Luật hòa Ma Sói
            <select
              value={wolfPolicy}
              onChange={(event) => setWolfPolicy(event.target.value as WolfPolicy)}
            >
              <option value="RANDOM_ON_TIE">Random khi hòa</option>
              <option value="REVOTE_10S">Chọn lại trong 10 giây</option>
            </select>
          </label>
        </section>

        <div className="role-market">
          {groupOrder.map((group) => (
            <section className="market-group panel" key={group}>
              <div className="market-group-heading">
                <p className="eyebrow">{roleMarketGroupLabels[group]}</p>
                <span>
                  {classicRoleCatalog
                    .filter((role) => role.marketGroup === group)
                    .reduce((total, role) => total + (composition[role.id] ?? 0), 0)} lá
                </span>
              </div>
              <div className="market-rows">
                {classicRoleCatalog
                  .filter((role) => role.marketGroup === group)
                  .map((role) => {
                    const quantity = composition[role.id] ?? 0
                    return (
                      <article className="market-role" key={role.id}>
                        <details>
                          <summary>
                            <strong>{role.displayName}</strong>
                            <span>{role.factionMeaning}</span>
                          </summary>
                          <p>{role.rulesText}</p>
                          {'notes' in role && role.notes?.map((note: string) => (
                            <small key={note}>{note}</small>
                          ))}
                        </details>
                        {role.quantityMode === 'MULTIPLE' ? (
                          <div className="quantity-control" aria-label={`Số lượng ${role.displayName}`}>
                            <button onClick={() => setQuantity(role.id, quantity - 1)} disabled={quantity === 0}>−</button>
                            <strong>{quantity}</strong>
                            <button onClick={() => setQuantity(role.id, quantity + 1)} disabled={quantity >= seatCount}>+</button>
                          </div>
                        ) : (
                          <button
                            className={`singleton-toggle ${quantity === 1 ? 'selected' : ''}`}
                            onClick={() => setQuantity(role.id, quantity === 1 ? 0 : 1)}
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

        <div className="create-room-footer">
          <div>
            <strong>{selectedCount} / {seatCount} lá</strong>
            <span>{countMessage}</span>
            {error && <span className="inline-error">{error}</span>}
          </div>
          <button
            className="button primary"
            disabled={!validation.valid || submitting}
            onClick={() => void createRoom()}
          >
            {submitting ? 'Đang tạo…' : 'Tạo phòng'}
          </button>
        </div>
      </main>
    </AppShell>
  )
}
