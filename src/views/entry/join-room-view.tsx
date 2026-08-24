import { useState, type FormEvent } from 'react'
import {
  joinFlowAfterValidation,
  type JoinFlowState,
} from '../../domain/game/join-flow'
import type { RoomTransport } from '../../transport/room-transport'

interface JoinRoomViewProps {
  transport: RoomTransport
}

export function JoinRoomView({ transport }: JoinRoomViewProps) {
  const [code, setCode] = useState('')
  const [flow, setFlow] = useState<JoinFlowState>({ step: 'CODE', code: '' })
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const [busy, setBusy] = useState(false)

  const validateCode = async (event: FormEvent) => {
    event.preventDefault()
    if (code.length !== 6) {
      setFlow({
        step: 'CODE',
        code,
        error: 'Mã phòng phải có đúng 6 chữ số.',
      })
      return
    }
    setBusy(true)
    const validation = await transport.validateRoomCode(code)
    setBusy(false)
    setFlow(joinFlowAfterValidation(code, validation))
    if (validation.joinable) {
      setName('')
      setNameError('')
    }
  }

  const join = async (event: FormEvent) => {
    event.preventDefault()
    if (flow.step !== 'NAME') return
    setBusy(true)
    setNameError('')
    const result = await transport.joinRoom(flow.roomCode, name)
    setBusy(false)
    if (!result.ok || !result.roomId || !result.playerId) {
      setNameError(result.error ?? 'Không thể vào phòng.')
      return
    }
    window.location.assign(
      `?room=${encodeURIComponent(result.roomId)}&player=${encodeURIComponent(result.playerId)}${transport.kind === 'LOCAL' ? '&transport=local' : ''}`,
    )
  }

  const formattedCode = code.padEnd(6, '·').split('').join(' ')

  return (
    <main
      className="join-viewport zero-scroll-surface"
      data-player-viewport
      data-surface={flow.step === 'NAME' ? 'name-modal' : 'join'}
    >
      <a className="entry-back" href={transport.kind === 'LOCAL' ? '/?transport=local' : '/'}>← Trang chủ</a>
      <section className="join-card">
        <p className="eyebrow">
          {transport.kind === 'LOCAL' ? 'DEV local · Cùng trình duyệt' : 'Phòng nhiều thiết bị'}
        </p>
        <h1>Vào phòng</h1>
        <p>Nhập mã 6 số do Quản trò hiển thị.</p>
        <form onSubmit={(event) => void validateCode(event)}>
          <label className="room-code-field">
            <span className="code-slots" aria-hidden="true">{formattedCode}</span>
            <input
              aria-label="Mã phòng gồm 6 chữ số"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(event) => {
                const nextCode = event.target.value.replace(/\D/g, '').slice(0, 6)
                setCode(nextCode)
                setFlow({ step: 'CODE', code: nextCode })
              }}
              data-required-control
            />
          </label>
          {flow.step === 'CODE' && flow.error && (
            <p className="form-error">{flow.error}</p>
          )}
          <button
            className="button primary full"
            disabled={code.length !== 6 || busy}
            data-required-control
          >
            {busy ? 'Đang kiểm tra…' : 'Tiếp tục'}
          </button>
        </form>
        <small>
          {transport.kind === 'LOCAL'
            ? 'Mã local chỉ hoạt động trong cùng trình duyệt.'
            : 'Mã phòng được kiểm tra trực tiếp với máy chủ.'}
        </small>
      </section>

      {flow.step === 'NAME' && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="name-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="name-title"
          >
            <p className="eyebrow">Phòng {flow.roomCode}</p>
            <h2 id="name-title">Tên của bạn</h2>
            <p>Tên này sẽ được dùng trong ván chơi.</p>
            <form onSubmit={(event) => void join(event)}>
              <input
                aria-label="Tên của bạn"
                autoFocus
                maxLength={20}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ví dụ: Bảo Châu"
                data-required-control
              />
              {nameError && <p className="form-error">{nameError}</p>}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setFlow({ step: 'CODE', code })}
                  data-required-control
                >
                  Hủy
                </button>
                <button
                  className="button primary"
                  disabled={!name.trim() || busy}
                  data-required-control
                >
                  {busy ? 'Đang vào…' : 'Vào phòng'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </main>
  )
}
