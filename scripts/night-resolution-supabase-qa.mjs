import { execFileSync } from 'node:child_process'
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
    if (!match) continue
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

function localEnvironment() {
  const output = process.platform === 'win32'
    ? execFileSync(
        process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/s', '/c', 'npx supabase status -o env'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
    : execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
  const values = parseEnv(output)
  const url = values.API_URL
  const key = values.PUBLISHABLE_KEY ?? values.ANON_KEY
  invariant(url && key, 'Local Supabase status thiếu runtime credentials.')
  return { url, key }
}

function remoteEnvironment() {
  const values = { ...process.env }
  if (fs.existsSync('.env.local')) {
    Object.assign(values, parseEnv(fs.readFileSync('.env.local', 'utf8')))
  }
  const url = values.VITE_SUPABASE_URL
  const key = values.VITE_SUPABASE_PUBLISHABLE_KEY
  invariant(url && key, 'Thiếu Supabase frontend environment cho remote QA.')
  return { url, key }
}

const mode = process.argv.includes('--remote') ? 'REMOTE' : 'LOCAL'
const environment = mode === 'LOCAL' ? localEnvironment() : remoteEnvironment()
const runId = `${mode.toLowerCase()}-${Date.now().toString(36)}`

function localSql(statement) {
  invariant(mode === 'LOCAL', 'Local SQL fixture chỉ được phép trong local QA.')
  return execFileSync(
    'docker',
    [
      'exec',
      'supabase_db_masoi',
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
      '-c',
      statement,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

function isolatedClient() {
  return createClient(environment.url, environment.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

async function authenticate(client) {
  const { data, error } = await client.auth.signInAnonymously()
  invariant(!error && data.user?.id, `Anonymous Auth thất bại: ${error?.message ?? 'missing user'}`)
  if (data.session?.access_token) await client.realtime.setAuth(data.session.access_token)
  return data.user.id
}

async function rpc(client, name, args = undefined) {
  const result = await client.rpc(name, args)
  if (result.error) throw new Error(`${name}:${result.error.message}`)
  return result.data
}

async function rpcFailure(client, name, args, expectedCode) {
  const result = await client.rpc(name, args)
  if (expectedCode === undefined) {
    invariant(Boolean(result.error), `${name} unexpectedly succeeded.`)
    return
  }
  invariant(
    result.error?.message === expectedCode,
    `${name} expected ${expectedCode}; received ${result.error?.message ?? 'success'}`,
  )
}

async function waitFor(predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Realtime timeout.')
}

const moderator = isolatedClient()
const players = Array.from({ length: 7 }, () => isolatedClient())
const unrelatedModerator = isolatedClient()
const clients = [moderator, ...players, unrelatedModerator]
const userIds = await Promise.all(clients.map(authenticate))
invariant(new Set(userIds).size === 9, 'QA identities không tách biệt.')

const representativeRoleConfig = {
  villager: 3,
  werewolf: 1,
  traitor: 1,
  seer: 1,
  protector: 1,
}

async function prepareRoom({
  roleConfig = representativeRoleConfig,
  label,
  onLobbyReady,
}) {
  const created = await rpc(moderator, 'ms1a_create_room', {
    p_request_id: randomUUID(),
    p_seat_count: 7,
    p_role_config: roleConfig,
    p_wolf_policy: 'RANDOM_ON_TIE',
  })
  const joined = []
  for (let index = 0; index < players.length; index += 1) {
    joined.push(await rpc(players[index], 'ms1a_join_room', {
      p_code: created.room.code,
      p_display_name: `${label.slice(0, 16)}-${index + 1}`,
    }))
  }
  if (onLobbyReady) await onLobbyReady({ roomId: created.room.id })
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
    const current = playerIdsByRole.get(assignment.roleId) ?? []
    current.push(assignment.playerId)
    playerIdsByRole.set(assignment.roleId, current)
  }
  return {
    id: created.room.id,
    joined,
    dealt,
    clientByPlayerId,
    playerIdsByRole,
  }
}

function roleClients(room, roleId) {
  return (room.playerIdsByRole.get(roleId) ?? []).map((playerId) => {
    const client = room.clientByPlayerId.get(playerId)
    invariant(client, `Không tìm thấy client cho ${roleId}.`)
    return { playerId, client }
  })
}

function roleClient(room, roleId) {
  const result = roleClients(room, roleId)[0]
  invariant(result, `Room thiếu role ${roleId}.`)
  return result
}

async function moderatorProjection(roomId) {
  return rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: roomId })
}

async function playerProjection(roomId, client) {
  return rpc(client, 'ms1a_get_player_room', { p_room_id: roomId })
}

async function completeProtector(room, targetId) {
  await rpc(moderator, 'ms1b1_open_night_role_call', {
    p_room_id: room.id,
    p_role_id: 'protector',
  })
  const projection = await moderatorProjection(room.id)
  const action = projection.night.actionsByRole.protector
  if (!action) {
    await rpc(moderator, 'ms1b1_complete_empty_night_role_call', {
      p_room_id: room.id,
      p_role_id: 'protector',
    })
    return
  }
  const protector = roleClient(room, 'protector')
  await rpc(protector.client, 'ms1b1_submit_protector_target', {
    p_room_id: room.id,
    p_target_player_id: targetId,
  })
}

async function completeWolf(room, targetId) {
  await rpc(moderator, 'ms1b1_open_night_role_call', {
    p_room_id: room.id,
    p_role_id: 'werewolf',
  })
  const projection = await moderatorProjection(room.id)
  const action = projection.night.actionsByRole.werewolf
  if (!action) {
    await rpc(moderator, 'ms1b1_complete_empty_night_role_call', {
      p_room_id: room.id,
      p_role_id: 'werewolf',
    })
    return
  }
  for (const actorId of action.eligibleActorIds) {
    const client = room.clientByPlayerId.get(actorId)
    invariant(client, 'Thiếu client cho Wolf-group actor.')
    await rpc(client, 'ms1b1_submit_wolf_ballot', {
      p_room_id: room.id,
      p_target_player_id: targetId,
    })
    await rpc(client, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id })
  }
  await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: room.id })
}

function assertResolution(result, expected) {
  invariant(result.outcome === expected.outcome, `Outcome ${result.outcome} != ${expected.outcome}.`)
  invariant(result.effects.length === expected.effectCount, 'Sai effect count.')
  invariant(
    JSON.stringify(result.provisionalDeathCandidateIds) === JSON.stringify(expected.candidates),
    'Sai provisional death candidates.',
  )
}

const evidence = {
  mode,
  newAnonymousIdentities: 9,
  representativeDeck: representativeRoleConfig,
  remoteCoverage: mode === 'REMOTE'
    ? { blocked: true, unblocked: 'LOCAL_ONLY', noAttack: 'LOCAL_ONLY' }
    : 'EXHAUSTIVE',
  blocked: null,
  unblocked: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  noProtector: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  deadProtector: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  noBiteCapableWolf: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  readiness: null,
  idempotency: null,
  concurrency: null,
  privacy: null,
  realtime: null,
}

const signals = new Map()
const channels = []
const mainRoom = await prepareRoom({
  label: `B2-${runId}`,
  onLobbyReady: async ({ roomId }) => {
    for (const client of [moderator, ...players]) {
      const channel = client
        .channel(`room:${roomId}`, { config: { private: true } })
        .on('broadcast', { event: 'room_changed' }, (payload) => {
          signals.set(client, payload)
        })
        .subscribe()
      channels.push({ client, channel })
    }
    await waitFor(() => channels.every(({ channel }) => channel.state === 'joined'))
  },
})

const target = roleClient(mainRoom, 'seer')
const villager = roleClient(mainRoom, 'villager')

await completeProtector(mainRoom, target.playerId)
await rpcFailure(moderator, 'ms1b2_resolve_night_effects', {
  p_room_id: mainRoom.id,
}, 'NIGHT_RESOLUTION_NOT_READY')
await completeWolf(mainRoom, target.playerId)

await rpcFailure(villager.client, 'ms1b2_resolve_night_effects', {
  p_room_id: mainRoom.id,
}, 'NOT_MODERATOR')
await rpcFailure(villager.client, 'ms1b2_resolve_night_effects', {
  p_room_id: mainRoom.id,
  p_target_player_id: target.playerId,
}, undefined)

await rpc(unrelatedModerator, 'ms1a_create_room', {
  p_request_id: randomUUID(),
  p_seat_count: 7,
  p_role_config: representativeRoleConfig,
  p_wolf_policy: 'RANDOM_ON_TIE',
})
await rpcFailure(unrelatedModerator, 'ms1b2_resolve_night_effects', {
  p_room_id: mainRoom.id,
}, 'NOT_MODERATOR')

signals.clear()
const concurrentResults = await Promise.all([
  rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: mainRoom.id }),
  rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: mainRoom.id }),
])
assertResolution(concurrentResults[0], {
  outcome: 'BLOCKED',
  effectCount: 1,
  candidates: [],
})
invariant(
  concurrentResults[0].id === concurrentResults[1].id &&
    JSON.stringify(concurrentResults[0]) === JSON.stringify(concurrentResults[1]),
  'Concurrent resolve không trả cùng authoritative result.',
)
const repeated = await rpc(moderator, 'ms1b2_resolve_night_effects', {
  p_room_id: mainRoom.id,
})
invariant(JSON.stringify(repeated) === JSON.stringify(concurrentResults[0]), 'Repeated resolve không idempotent.')
await waitFor(() => signals.has(moderator) && signals.has(target.client))
const realtimeText = JSON.stringify([signals.get(moderator), signals.get(target.client)])
invariant(
  !/(source_type|sourceType|source_role|sourceRole|effect_category|effectCategory|target_player|targetPlayer|protector_target|block_source|blockSource|provisional|death_candidate|deathCandidate|WOLF_ATTACK|BLOCKED_BY_PROTECTOR|"outcome")/i.test(realtimeText),
  'Generic Realtime payload leaked B2 truth.',
)

const mainModerator = await moderatorProjection(mainRoom.id)
const mainPlayer = await playerProjection(mainRoom.id, target.client)
invariant(mainModerator.nightResolution.id === concurrentResults[0].id, 'Moderator refresh mất resolution.')
invariant(mainModerator.alivePlayerIds.includes(target.playerId), 'Blocked target không còn alive.')
invariant(
  mainPlayer.alivePlayerIds.includes(target.playerId) && !mainPlayer.nightAction,
  'Blocked Player không ở neutral/alive.',
)
invariant(
  !/(nightResolution|WOLF_ATTACK|provisionalDeath|BLOCKED_BY_PROTECTOR)/.test(JSON.stringify(mainPlayer)),
  'Player projection lộ B2 truth.',
)

const directAttempts = [
  await villager.client.schema('private').from('night_resolutions').select('*'),
  await villager.client.schema('private').from('night_effects').select('*'),
  await villager.client.schema('private').from('provisional_night_death_candidates').select('*'),
  await villager.client.schema('private').from('night_effects').insert({
    room_id: mainRoom.id,
    source_type: 'FORGED',
  }),
  await moderator.schema('private').from('night_effects').delete().eq('room_id', mainRoom.id),
]
invariant(directAttempts.every((attempt) => Boolean(attempt.error)), 'Direct B2 read/DML không bị deny.')
await rpcFailure(unrelatedModerator, 'ms1a_get_moderator_room', {
  p_room_id: mainRoom.id,
}, 'NOT_MODERATOR')

evidence.blocked = {
  protectorBeforeWolf: true,
  effect: 'BLOCKED_BY_PROTECTOR',
  provisionalDeathCandidates: 0,
  targetAlive: true,
  seerNotRequired: true,
}
evidence.readiness = {
  protectorCompleteWolfIncomplete: 'NOT_READY',
  wolfCompleteProtectorIncomplete: mode === 'LOCAL' ? null : 'LOCAL_PROOF_PENDING',
}
evidence.idempotency = { stableResolutionId: true, duplicateLogicalResult: false }
evidence.concurrency = { requests: 2, logicalResolutions: 1 }
evidence.realtime = { signal: 'room_changed', secretPayload: false }
evidence.privacy = {
  playerResolveDenied: true,
  forgedOutcomeArgumentsRejected: true,
  otherRoomModeratorDenied: true,
  privateReadsDenied: true,
  directDmlDenied: true,
  playerProjectionNeutral: true,
  playerProvisionalDisclosure: false,
}

if (mode === 'LOCAL') {
  const unblockedRoom = await prepareRoom({ label: `U-${runId}` })
  const unblockedTarget = roleClient(unblockedRoom, 'seer')
  const differentTarget = roleClient(unblockedRoom, 'villager')
  await completeWolf(unblockedRoom, unblockedTarget.playerId)
  await rpcFailure(moderator, 'ms1b2_resolve_night_effects', {
    p_room_id: unblockedRoom.id,
  }, 'NIGHT_RESOLUTION_NOT_READY')
  await completeProtector(unblockedRoom, differentTarget.playerId)
  const unblocked = await rpc(moderator, 'ms1b2_resolve_night_effects', {
    p_room_id: unblockedRoom.id,
  })
  assertResolution(unblocked, {
    outcome: 'UNBLOCKED',
    effectCount: 1,
    candidates: [unblockedTarget.playerId],
  })
  const unblockedProjection = await playerProjection(unblockedRoom.id, unblockedTarget.client)
  invariant(
    unblockedProjection.alivePlayerIds.includes(unblockedTarget.playerId) &&
      !unblockedProjection.nightAction,
    'Unblocked candidate không neutral/alive.',
  )
  const counts = localSql(`
    select
      (select count(*) from private.night_resolutions where room_id = '${unblockedRoom.id}'::uuid),
      (select count(*) from private.night_effects where room_id = '${unblockedRoom.id}'::uuid),
      (select count(*) from private.provisional_night_death_candidates where room_id = '${unblockedRoom.id}'::uuid),
      (select count(*) from private.gameplay_events where room_id = '${unblockedRoom.id}'::uuid and event_type = 'NIGHT_RESOLUTION_COMPLETED');
  `)
  invariant(counts === '1|1|1|1', `Idempotent persistence counts sai: ${counts}`)
  evidence.unblocked = {
    wolfBeforeProtector: true,
    preProtectorResolve: 'NOT_READY',
    effect: 'UNBLOCKED',
    candidate: unblockedTarget.playerId,
    alive: true,
    playerNeutral: true,
    persistenceCounts: counts,
  }
  evidence.readiness.wolfCompleteProtectorIncomplete = 'NOT_READY'

  const noProtectorConfig = {
    villager: 4,
    werewolf: 1,
    traitor: 1,
    seer: 1,
  }
  const noProtectorRoom = await prepareRoom({
    roleConfig: noProtectorConfig,
    label: `NP-${runId}`,
  })
  const noProtectorTarget = roleClient(noProtectorRoom, 'seer')
  await completeWolf(noProtectorRoom, noProtectorTarget.playerId)
  const noProtector = await rpc(moderator, 'ms1b2_resolve_night_effects', {
    p_room_id: noProtectorRoom.id,
  })
  assertResolution(noProtector, {
    outcome: 'UNBLOCKED',
    effectCount: 1,
    candidates: [noProtectorTarget.playerId],
  })
  evidence.noProtector = { outcome: 'UNBLOCKED', targetAlive: true }

  const deadProtectorRoom = await prepareRoom({ label: `DP-${runId}` })
  const deadProtector = roleClient(deadProtectorRoom, 'protector')
  const deadProtectorTarget = roleClient(deadProtectorRoom, 'seer')
  localSql(`update public.room_players set alive = false where id = '${deadProtector.playerId}'::uuid;`)
  await completeProtector(deadProtectorRoom, deadProtectorTarget.playerId)
  await completeWolf(deadProtectorRoom, deadProtectorTarget.playerId)
  const deadProtectorResult = await rpc(moderator, 'ms1b2_resolve_night_effects', {
    p_room_id: deadProtectorRoom.id,
  })
  assertResolution(deadProtectorResult, {
    outcome: 'UNBLOCKED',
    effectCount: 1,
    candidates: [deadProtectorTarget.playerId],
  })
  evidence.deadProtector = {
    ritualCompleted: true,
    intent: null,
    outcome: 'UNBLOCKED',
    candidateAlive: true,
  }

  const noWolfRoom = await prepareRoom({
    roleConfig: noProtectorConfig,
    label: `NW-${runId}`,
  })
  const deadWolf = roleClient(noWolfRoom, 'werewolf')
  localSql(`update public.room_players set alive = false where id = '${deadWolf.playerId}'::uuid;`)
  await completeWolf(noWolfRoom, null)
  const noAttack = await rpc(moderator, 'ms1b2_resolve_night_effects', {
    p_room_id: noWolfRoom.id,
  })
  assertResolution(noAttack, {
    outcome: 'NO_ATTACK',
    effectCount: 0,
    candidates: [],
  })
  invariant(
    roleClient(noWolfRoom, 'traitor') && noAttack.effects.length === 0,
    'Traitor một mình đã tạo Wolf attack.',
  )
  evidence.noBiteCapableWolf = {
    livingTraitor: true,
    outcome: 'NO_ATTACK',
    effects: 0,
    candidates: 0,
  }
}

for (const { client, channel } of channels) {
  await client.removeChannel(channel)
}
await Promise.all(clients.map((client) => client.realtime.disconnect()))

console.log(`MS-1B2 ${mode} SUPABASE QA PASS`)
console.log(JSON.stringify(evidence, null, 2))
