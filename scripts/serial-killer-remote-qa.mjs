import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function parseEnv(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

const values = { ...process.env }
if (fs.existsSync('.env.local')) {
  Object.assign(values, parseEnv(fs.readFileSync('.env.local', 'utf8')))
}
const url = values.VITE_SUPABASE_URL
const key = values.VITE_SUPABASE_PUBLISHABLE_KEY
invariant(url && key, 'Thiếu remote Supabase frontend environment.')

function isolatedClient() {
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

async function authenticate(client) {
  const result = await client.auth.signInAnonymously()
  invariant(
    !result.error && result.data.user?.id,
    `Anonymous Auth thất bại: ${result.error?.message ?? 'missing user'}`,
  )
  if (result.data.session?.access_token) {
    await client.realtime.setAuth(result.data.session.access_token)
  }
  return result.data.user.id
}

async function rpc(client, name, args = undefined) {
  const result = await client.rpc(name, args)
  if (result.error) throw new Error(`${name}:${result.error.message}`)
  return result.data
}

async function rpcFailure(client, name, args, expected) {
  const result = await client.rpc(name, args)
  invariant(Boolean(result.error), `${name} unexpectedly succeeded.`)
  if (expected) {
    invariant(
      result.error.message === expected,
      `${name}: expected ${expected}, got ${result.error.message}`,
    )
  }
}

const moderator = isolatedClient()
const players = Array.from({ length: 7 }, () => isolatedClient())
const clients = [moderator, ...players]
const identities = []
for (const client of clients) identities.push(await authenticate(client))
invariant(new Set(identities).size === 8, 'Remote QA cần đúng 8 isolated identities.')

const config = {
  villager: 2,
  werewolf: 1,
  'serial-killer': 1,
  protector: 1,
  witch: 1,
  seer: 1,
}
const label = `g1r-${Date.now().toString(36)}`
let roomsCreated = 0

const created = await rpc(moderator, 'ms1a_create_room', {
  p_request_id: randomUUID(),
  p_seat_count: 7,
  p_role_config: config,
  p_wolf_policy: 'RANDOM_ON_TIE',
})
roomsCreated += 1
const joined = []
for (let index = 0; index < players.length; index += 1) {
  joined.push(await rpc(players[index], 'ms1a_join_room', {
    p_code: created.room.code,
    p_display_name: `${label.slice(0, 12)}-${index + 1}`,
  }))
}
const dealt = await rpc(moderator, 'ms1a_lock_and_assign_roles', {
  p_room_id: created.room.id,
})
await Promise.all(players.map((client) => rpc(client, 'ms1a_confirm_role_reveal', {
  p_room_id: created.room.id,
})))
await rpc(moderator, 'ms1a_start_room', { p_room_id: created.room.id })

const clientByPlayerId = new Map(
  joined.map((payload, index) => [payload.self.id, players[index]]),
)
const playerIdsByRole = new Map()
for (const assignment of dealt.assignments) {
  const ids = playerIdsByRole.get(assignment.roleId) ?? []
  ids.push(assignment.playerId)
  playerIdsByRole.set(assignment.roleId, ids)
}
const room = {
  id: created.room.id,
  clientByPlayerId,
  playerIdsByRole,
}

function role(roleId, offset = 0) {
  const playerId = (room.playerIdsByRole.get(roleId) ?? [])[offset]
  const client = room.clientByPlayerId.get(playerId)
  invariant(playerId && client, `Focused remote room thiếu ${roleId}.`)
  return { playerId, client }
}

async function moderatorProjection() {
  return rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: room.id })
}

async function playerProjection(actor) {
  return rpc(actor.client, 'ms1a_get_player_room', { p_room_id: room.id })
}

const wolf = role('werewolf')
const serialKiller = role('serial-killer')
const protector = role('protector')
const witch = role('witch')
const seer = role('seer')
const villagers = [role('villager', 0), role('villager', 1)]
const protectedVillager = villagers[0]
const ordinary = villagers[1]

const realtimePayloads = []
const channel = moderator
  .channel(`room:${room.id}`, { config: { private: true } })
  .on('broadcast', { event: 'room_changed' }, (payload) => realtimePayloads.push(payload))
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Remote Realtime subscribe timeout.')), 10_000)
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      clearTimeout(timeout)
      resolve()
    }
  })
})
await new Promise((resolve) => setTimeout(resolve, 300))

await rpc(moderator, 'ms1b1_open_night_role_call', {
  p_room_id: room.id,
  p_role_id: 'seer',
})
const inspection = await rpc(seer.client, 'ms1b1_submit_seer_inspection', {
  p_room_id: room.id,
  p_target_player_id: serialKiller.playerId,
})
invariant(inspection.seerResult === 'NON_WOLF', 'Seer không đọc Serial Killer là NON_WOLF.')
await rpc(seer.client, 'ms1b1_acknowledge_seer_result', { p_room_id: room.id })

await rpc(moderator, 'ms1b1_open_night_role_call', {
  p_room_id: room.id,
  p_role_id: 'protector',
})
await rpc(protector.client, 'ms1b1_submit_protector_target', {
  p_room_id: room.id,
  p_target_player_id: protectedVillager.playerId,
})

await rpc(moderator, 'ms1g1_open_serial_killer_call', { p_room_id: room.id })
const serialKillerView = await playerProjection(serialKiller)
invariant(
  serialKillerView.nightAction?.mode === 'SERIAL_KILLER_ATTACK',
  'Serial Killer không nhận private action.',
)
invariant(
  serialKillerView.nightAction.candidates.some(
    (candidate) => candidate.id === protectedVillager.playerId,
  ),
  'Protected Villager không có trong SK eligible targets.',
)
const ordinaryDuringCall = await playerProjection(ordinary)
invariant(!ordinaryDuringCall.nightAction, 'Ordinary Player nhận SK action.')
invariant(
  !/(SERIAL_KILLER|serial-killer|immun|provisional|sourceType)/i.test(
    JSON.stringify(ordinaryDuringCall),
  ),
  'Ordinary projection lộ SK target/source/immunity truth.',
)

const privateRead = await serialKiller.client
  .schema('private')
  .from('serial_killer_intents')
  .select('*')
invariant(Boolean(privateRead.error), 'Player đọc được private.serial_killer_intents.')
const privateWrite = await serialKiller.client
  .schema('private')
  .from('serial_killer_intents')
  .insert({ room_id: room.id, night_number: 1 })
invariant(Boolean(privateWrite.error), 'Player ghi được private.serial_killer_intents.')
await rpcFailure(ordinary.client, 'ms1g1_open_serial_killer_call', {
  p_room_id: room.id,
}, 'NOT_MODERATOR')
await rpcFailure(ordinary.client, 'ms1b2_resolve_night_effects', {
  p_room_id: room.id,
}, 'NOT_MODERATOR')

await rpc(serialKiller.client, 'ms1g1_submit_serial_killer_intent', {
  p_room_id: room.id,
  p_target_player_id: protectedVillager.playerId,
})
await rpc(serialKiller.client, 'ms1g1_confirm_serial_killer_intent', {
  p_room_id: room.id,
})

await rpc(moderator, 'ms1b1_open_night_role_call', {
  p_room_id: room.id,
  p_role_id: 'werewolf',
})
const wolfAction = (await moderatorProjection()).night.actionsByRole.werewolf
invariant(wolfAction, 'Wolf action authority missing.')
invariant(
  wolfAction.eligibleTargetIds.includes(serialKiller.playerId),
  'Serial Killer không còn Wolf-targetable.',
)
for (const actorId of wolfAction.eligibleActorIds) {
  const actorClient = room.clientByPlayerId.get(actorId)
  invariant(actorClient, 'Wolf actor thiếu authenticated client.')
  await rpc(actorClient, 'ms1b1_submit_wolf_ballot', {
    p_room_id: room.id,
    p_target_player_id: serialKiller.playerId,
  })
  await rpc(actorClient, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id })
}
await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: room.id })

const resolution = await rpc(moderator, 'ms1b2_resolve_night_effects', {
  p_room_id: room.id,
})
const serialKillerEffect = resolution.effects.find(
  (effect) => effect.sourceType === 'SERIAL_KILLER_ATTACK',
)
const wolfEffect = resolution.effects.find(
  (effect) => effect.sourceType === 'WOLF_ATTACK',
)
invariant(
  serialKillerEffect?.targetPlayerId === protectedVillager.playerId &&
    serialKillerEffect.outcome === 'BLOCKED_BY_PROTECTOR' &&
    serialKillerEffect.protectorBlockable === true,
  'Protector không block đúng SERIAL_KILLER_ATTACK.',
)
invariant(
  wolfEffect?.targetPlayerId === serialKiller.playerId &&
    wolfEffect.outcome === 'IMMUNE_TO_WOLF_ATTACK',
  'Wolf→Serial Killer không persist IMMUNE_TO_WOLF_ATTACK.',
)
invariant(
  !resolution.provisionalDeathCandidateIds.includes(protectedVillager.playerId) &&
    !resolution.provisionalDeathCandidateIds.includes(serialKiller.playerId),
  'Blocked/immune target trở thành provisional death.',
)

const afterResolution = await moderatorProjection()
invariant(
  afterResolution.alivePlayerIds.includes(serialKiller.playerId),
  'Serial Killer chết bởi Wolf attack.',
)
invariant(
  afterResolution.alivePlayerIds.includes(protectedVillager.playerId),
  'Protected Villager chết bởi SK attack.',
)

await rpc(moderator, 'ms1f_open_witch_call', { p_room_id: room.id })
const witchView = await playerProjection(witch)
invariant(
  (witchView.nightAction?.resurrectionCandidates ?? []).length === 0,
  'Witch thấy blocked/immune victim trong death list.',
)
invariant(
  !/(SERIAL_KILLER_ATTACK|WOLF_ATTACK|IMMUNE_TO_WOLF_ATTACK|sourceType)/i.test(
    JSON.stringify(witchView.nightAction),
  ),
  'Witch projection lộ source/immunity.',
)
await rpc(witch.client, 'ms1c_submit_witch_decision', {
  p_room_id: room.id,
  p_resurrection_target_id: null,
  p_poison_target_id: null,
})
await rpc(moderator, 'ms1f_finalize_night_checkpoint', { p_room_id: room.id })

const finalModerator = await moderatorProjection()
invariant(finalModerator.witchCheckpoint.finalDeaths.length === 0, 'Final checkpoint tạo death ngoài ý muốn.')
invariant(finalModerator.alivePlayerIds.length === 7, 'Không giữ đủ 7 Player sống.')
const finalOrdinary = await playerProjection(ordinary)
invariant(
  !/(SERIAL_KILLER|serial-killer|IMMUNE|sourceType|provisionalDeath)/i.test(
    JSON.stringify(finalOrdinary),
  ),
  'Ordinary final projection lộ SK secret truth.',
)

await new Promise((resolve) => setTimeout(resolve, 1_000))
await moderator.removeChannel(channel)
const realtimeText = JSON.stringify(realtimePayloads)
invariant(
  !/(serial|killer|target|source|effect|immune|provisional|death)/i.test(realtimeText),
  'Generic Realtime payload lộ SK target/source/immunity.',
)
invariant(
  !realtimeText.includes(serialKiller.playerId) &&
    !realtimeText.includes(protectedVillager.playerId),
  'Generic Realtime payload lộ SK/target identifier.',
)

await Promise.all(clients.map((client) => client.removeAllChannels()))

console.log('MS-1G1 FOCUSED REMOTE QA PASS')
console.log(JSON.stringify({
  mode: 'REMOTE',
  rooms: roomsCreated,
  isolatedIdentities: identities.length,
  seerSerialKiller: 'NON_WOLF',
  serialKillerAttack: 'BLOCKED_BY_PROTECTOR',
  wolfAttackSerialKiller: 'IMMUNE_TO_WOLF_ATTACK',
  serialKillerAlive: true,
  protectedVillagerAlive: true,
  provisionalDeaths: 0,
  finalDeaths: 0,
  ordinaryProjectionSecretFree: true,
  directPrivateReadWrite: 'DENIED',
  genericRealtime: realtimePayloads.length > 0
    ? 'OBSERVED_SECRET_FREE'
    : 'FRAME_NOT_OBSERVED_STATIC_AND_PROJECTION_PRIVACY_PASS',
  localRoomFallback: false,
}, null, 2))
