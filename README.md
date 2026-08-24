# MaSoi — Boardgame Companion

MS-0B provides the truthful local product flow for a physical Ma Sói table:
landing, room configuration, six-digit room join, Lobby, explicit role deal,
private card reveal, and the MS-0A game foundation.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Choose **Tạo phòng** as Moderator or **Vào phòng**
as Player. All tabs must use the same browser profile because MS-0B synchronizes
through `localStorage` and `BroadcastChannel`; the six-digit code is not yet a
real cross-device room code.

Useful checks:

```bash
npm test
npm run lint
npm run build
npm run qa:zero-scroll
npm run qa:room-flow
```

## MS-0A architecture

- `src/domain`: 12-role Classic catalog, room lifecycle/setup validation, pure
  game transitions, target rules, vote resolvers, injectable randomness, and
  structured journal events.
- `src/state`: audience-specific projections. Player snapshots contain only
  public room data plus that player's currently allowed secret surface.
- `src/transport`: a `RoomTransport` boundary and the local multi-tab adapter.
- `src/views`: separate Moderator and intentionally quiet Player clients.

The local adapter is a development simulator, not secure networking. Browser
DevTools can inspect local storage. Production secrecy, authorization,
reconnection, and cross-device rooms belong to a later Supabase/RLS gate.
