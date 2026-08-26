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
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

function localEnvironment() {
  const command = process.platform === 'win32'
    ? [process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', 'npx supabase status -o env']]
    : ['npx', ['supabase', 'status', '-o', 'env']]
  const values = parseEnv(execFileSync(command[0], command[1], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }))
  invariant(values.API_URL && (values.PUBLISHABLE_KEY ?? values.ANON_KEY), 'Local Supabase chưa sẵn sàng.')
  return { url: values.API_URL, key: values.PUBLISHABLE_KEY ?? values.ANON_KEY }
}

function remoteEnvironment() {
  const values = { ...process.env }
  if (fs.existsSync('.env.local')) {
    Object.assign(values, parseEnv(fs.readFileSync('.env.local', 'utf8')))
  }
  invariant(
    values.VITE_SUPABASE_URL && values.VITE_SUPABASE_PUBLISHABLE_KEY,
    'Thiếu remote Supabase frontend environment.',
  )
  return {
    url: values.VITE_SUPABASE_URL,
    key: values.VITE_SUPABASE_PUBLISHABLE_KEY,
  }
}

const mode = process.argv.includes('--remote') ? 'REMOTE' : 'LOCAL'
const environment = mode === 'REMOTE' ? remoteEnvironment() : localEnvironment()
const runId = `${mode.toLowerCase()}-${Date.now().toString(36)}`

function localSql(statement) {
  invariant(mode === 'LOCAL', 'SQL fixture chỉ được dùng trong local QA.')
  return execFileSync('docker', [
    'exec', 'supabase_db_masoi', 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', statement,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
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

async function rpcFailure(client, name, args, expectedCode) {
  const result = await client.rpc(name, args)
  invariant(Boolean(result.error), `${name} unexpectedly succeeded.`)
  if (expectedCode) {
    invariant(
      result.error.message === expectedCode,
      `${name} expected ${expectedCode}; received ${result.error.message}`,
    )
  }
}

async function waitUntil(timestamp) {
  const delay = Math.max(0, timestamp - Date.now() + 180)
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Realtime instrumentation timeout.')
}

const moderator = isolatedClient()
const players = Array.from({ length: 7 }, () => isolatedClient())
const clients = [moderator, ...players]
const userIds = []
for (const client of clients) {
  userIds.push(await authenticate(client))
}
invariant(new Set(userIds).size === 8, 'MS-1F cần đúng 8 isolated identities.')

const baseConfig = {
  villager: 2,
  werewolf: 1,
  cupid: 1,
  witch: 1,
  hunter: 1,
  protector: 1,
}

async function prepareRoom(label, roleConfig = baseConfig) {
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
      p_display_name: `${label.slice(0, 12)}-${index + 1}`,
    }))
  }
  const dealt = await rpc(moderator, 'ms1a_lock_and_assign_roles', {
    p_room_id: created.room.id,
  })
  await Promise.all(players.map((client) => rpc(
    client,
    'ms1a_confirm_role_reveal',
    { p_room_id: created.room.id },
  )))
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
  return {
    id: created.room.id,
    code: created.room.code,
    dealt,
    clientByPlayerId,
    playerIdsByRole,
  }
}

function roleClient(room, roleId, offset = 0) {
  const playerId = (room.playerIdsByRole.get(roleId) ?? [])[offset]
  const client = room.clientByPlayerId.get(playerId)
  invariant(playerId && client, `Room thiếu role/client ${roleId}.`)
  return { playerId, client }
}

async function moderatorProjection(room) {
  return rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: room.id })
}

async function playerProjection(room, actor) {
  return rpc(actor.client, 'ms1a_get_player_room', { p_room_id: room.id })
}

async function openCupid(room) {
  return rpc(moderator, 'ms1f_open_cupid_call', { p_room_id: room.id })
}

async function pair(room, first, second, concurrent = false) {
  const cupid = roleClient(room, 'cupid')
  const args = {
    p_room_id: room.id,
    p_first_target_player_id: first.playerId,
    p_second_target_player_id: second.playerId,
  }
  if (concurrent) {
    const results = await Promise.all([
      rpc(cupid.client, 'ms1f_submit_cupid_pairing', args),
      rpc(cupid.client, 'ms1f_submit_cupid_pairing', args),
    ])
    invariant(results.every((result) => result.room.id === room.id), 'Concurrent pair retry không idempotent.')
  } else {
    await rpc(cupid.client, 'ms1f_submit_cupid_pairing', args)
  }
}

async function completeHunter(room, targetId = null) {
  await rpc(moderator, 'ms1d1_open_hunter_call', { p_room_id: room.id })
  const action = (await moderatorProjection(room)).night.actionsByRole.hunter
  if (!action) {
    await rpc(moderator, 'ms1b1_complete_empty_night_role_call', {
      p_room_id: room.id,
      p_role_id: 'hunter',
    })
    return
  }
  const hunter = roleClient(room, 'hunter')
  await rpc(hunter.client, 'ms1d1_submit_hunter_prelock', {
    p_room_id: room.id,
    p_target_player_id: targetId,
  })
  await rpc(hunter.client, 'ms1d1_confirm_hunter_prelock', {
    p_room_id: room.id,
  })
}

async function completeProtector(room, targetId) {
  await rpc(moderator, 'ms1b1_open_night_role_call', {
    p_room_id: room.id,
    p_role_id: 'protector',
  })
  const action = (await moderatorProjection(room)).night.actionsByRole.protector
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
  const action = (await moderatorProjection(room)).night.actionsByRole.werewolf
  if (!action) {
    await rpc(moderator, 'ms1b1_complete_empty_night_role_call', {
      p_room_id: room.id,
      p_role_id: 'werewolf',
    })
    return
  }
  for (const actorId of action.eligibleActorIds) {
    const client = room.clientByPlayerId.get(actorId)
    invariant(client, 'Thiếu Wolf-group client.')
    await rpc(client, 'ms1b1_submit_wolf_ballot', {
      p_room_id: room.id,
      p_target_player_id: targetId,
    })
    await rpc(client, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id })
  }
  await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: room.id })
}

async function resolvePreWitch(room, { wolfTargetId, protectorTargetId, hunterTargetId = null }) {
  await completeHunter(room, hunterTargetId)
  await completeProtector(room, protectorTargetId)
  await completeWolf(room, wolfTargetId)
  return rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: room.id })
}

async function witchDecision(room, resurrectionTargetId = null) {
  await rpc(moderator, 'ms1f_open_witch_call', { p_room_id: room.id })
  const witch = roleClient(room, 'witch')
  const projection = await playerProjection(room, witch)
  await rpc(witch.client, 'ms1c_submit_witch_decision', {
    p_room_id: room.id,
    p_resurrection_target_id: resurrectionTargetId,
    p_poison_target_id: null,
  })
  return projection
}

async function finalize(room, concurrent = false) {
  const args = { p_room_id: room.id }
  return concurrent
    ? Promise.all([
        rpc(moderator, 'ms1f_finalize_night_checkpoint', args),
        rpc(moderator, 'ms1f_finalize_night_checkpoint', args),
      ])
    : rpc(moderator, 'ms1f_finalize_night_checkpoint', args)
}

async function pairAndPrepare(room, lovers, options = {}) {
  await openCupid(room)
  await pair(room, lovers[0], lovers[1], options.concurrentPair === true)
  return resolvePreWitch(room, {
    wolfTargetId: options.wolfTargetId,
    protectorTargetId: options.protectorTargetId,
    hunterTargetId: options.hunterTargetId ?? null,
  })
}

async function assertPrivateTablesDenied(actor, room) {
  for (const table of [
    'cupid_couples',
    'lover_reveal_acknowledgements',
    'cupid_runtime_objectives',
  ]) {
    const read = await actor.client.schema('private').from(table).select('*').eq('room_id', room.id)
    invariant(Boolean(read.error), `Player đọc được private.${table}.`)
    const write = await actor.client.schema('private').from(table).delete().eq('room_id', room.id)
    invariant(Boolean(write.error), `Player ghi được private.${table}.`)
  }
}

async function subscribeGenericRoomChange(room) {
  const payloads = []
  const channel = moderator
    .channel(`room:${room.id}`, { config: { private: true } })
    .on('broadcast', { event: 'room_changed' }, (payload) => payloads.push(payload))
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Realtime subscribe timeout.')), 8_000)
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timeout)
        resolve()
      }
    })
  })
  // A fresh local Realtime tenant can report channel readiness just before its
  // broadcast-change replication slot begins streaming. Give that one-time
  // initialization boundary a short deterministic settling window; this is
  // not an RPC retry and does not create another room or identity.
  await new Promise((resolve) => setTimeout(resolve, 300))
  return { payloads, channel }
}

const evidence = {
  mode,
  identities: 8,
  rooms: 0,
  nightOnePair: false,
  privatePartner: false,
  ordinaryPrivacy: false,
  witchRescueNoHeartbreak: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  finalHeartbreak: false,
  hunterHeartbreakShot: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  hunterShotLoverChain: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  witchRescuedHunterNoChain: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  bothIndependentDeaths: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  dayHangingHeartbreak: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  dayRevengeHeartbreak: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  deadCupidFallback: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  idempotency: false,
  directDmlDenied: false,
  genericRealtimeSecretFree: false,
}

const primary = await prepareRoom(`f-main-${runId}`)
evidence.rooms += 1
const cupid = roleClient(primary, 'cupid')
const hunter = roleClient(primary, 'hunter')
const protector = roleClient(primary, 'protector')
const lovers = [roleClient(primary, 'villager', 0), roleClient(primary, 'villager', 1)]
const wolf = roleClient(primary, 'werewolf')
const ordinary = protector

await rpcFailure(players[0], 'ms1f_open_cupid_call', { p_room_id: primary.id }, 'NOT_MODERATOR')
await openCupid(primary)
await rpcFailure(cupid.client, 'ms1f_submit_cupid_pairing', {
  p_room_id: primary.id,
  p_first_target_player_id: lovers[0].playerId,
  p_second_target_player_id: lovers[0].playerId,
}, 'CUPID_TARGETS_MUST_BE_DISTINCT')
await rpcFailure(cupid.client, 'ms1f_submit_cupid_pairing', {
  p_room_id: primary.id,
  p_first_target_player_id: cupid.playerId,
  p_second_target_player_id: lovers[0].playerId,
}, 'CUPID_CANNOT_TARGET_SELF')
await rpcFailure(ordinary.client, 'ms1f_submit_cupid_pairing', {
  p_room_id: primary.id,
  p_first_target_player_id: lovers[0].playerId,
  p_second_target_player_id: lovers[1].playerId,
}, 'WRONG_ROLE')

const realtime = await subscribeGenericRoomChange(primary)
await pair(primary, lovers[0], lovers[1], true)
if (mode === 'LOCAL') {
  await waitFor(() => realtime.payloads.length > 0)
} else {
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}
await moderator.removeChannel(realtime.channel)
const realtimeText = JSON.stringify(realtime.payloads)
invariant(!/cupid|lover|heartbreak|partner/i.test(realtimeText), 'Generic Realtime payload lộ quan hệ bí mật.')
invariant(!realtimeText.includes(lovers[0].playerId) && !realtimeText.includes(lovers[1].playerId), 'Generic Realtime payload lộ Lover ID.')
evidence.genericRealtimeSecretFree = realtime.payloads.length > 0
  ? true
  : 'REMOTE_FRAME_NOT_OBSERVED; STATIC_AND_LOCAL_SECRET-SHAPE_ASSERTIONS_PASS'
evidence.nightOnePair = true
evidence.idempotency = true
await rpcFailure(cupid.client, 'ms1f_submit_cupid_pairing', {
  p_room_id: primary.id,
  p_first_target_player_id: lovers[0].playerId,
  p_second_target_player_id: ordinary.playerId,
}, 'CUPID_PAIR_ALREADY_EXISTS')

const loverAProjection = await playerProjection(primary, lovers[0])
const loverBProjection = await playerProjection(primary, lovers[1])
const ordinaryProjection = await playerProjection(primary, ordinary)
const cupidProjection = await playerProjection(primary, cupid)
invariant(loverAProjection.loverRelationship?.partner.id === lovers[1].playerId, 'Lover A không thấy đúng partner.')
invariant(loverBProjection.loverRelationship?.partner.id === lovers[0].playerId, 'Lover B không thấy đúng partner.')
invariant(!('roleId' in loverAProjection.loverRelationship.partner), 'Partner projection lộ role.')
invariant(!ordinaryProjection.loverRelationship && !ordinaryProjection.cupidPair, 'Ordinary Player thấy pair truth.')
invariant(cupidProjection.cupidPair?.lovers.length === 2, 'Cupid không thấy cặp đã chọn.')
invariant(!JSON.stringify(loverAProjection).includes('LOVER_HEARTBREAK'), 'Lover projection lộ death-source truth.')
evidence.privatePartner = true
evidence.ordinaryPrivacy = true

await rpc(lovers[0].client, 'ms1f_acknowledge_lover_reveal', { p_room_id: primary.id })
const acknowledged = await playerProjection(primary, lovers[0])
invariant(acknowledged.loverRelationship?.revealPending === false, 'Lover acknowledgement không bền qua refresh.')
await assertPrivateTablesDenied(ordinary, primary)
evidence.directDmlDenied = true
await rpcFailure(ordinary.client, 'ms1c_finalize_night_checkpoint', { p_room_id: primary.id })

await completeHunter(primary, null)
await completeProtector(primary, protector.playerId)
await completeWolf(primary, lovers[0].playerId)
const resolution = await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: primary.id })
invariant(resolution.provisionalDeathCandidateIds.includes(lovers[0].playerId), 'Thiếu provisional Lover victim.')
const witchProjection = await witchDecision(primary, null)
invariant(witchProjection.nightAction?.resurrectionCandidates.some((candidate) => candidate.id === lovers[0].playerId), 'Witch không thấy Lover victim theo tên.')
invariant(!JSON.stringify(witchProjection).includes('WOLF_ATTACK'), 'Witch thấy source/killer.')
invariant(witchProjection.nightAction?.poisonAvailable === false, 'Poison Night 1 không bị khóa.')
const finalizations = await finalize(primary, true)
invariant(finalizations[0].id === finalizations[1].id, 'Concurrent finalization tạo nhiều checkpoint.')
const finalModerator = await moderatorProjection(primary)
const finalDeathIds = new Set(finalModerator.witchCheckpoint.finalDeaths.map((death) => death.playerId))
invariant(finalDeathIds.has(lovers[0].playerId) && finalDeathIds.has(lovers[1].playerId), 'Heartbreak không final-dead cả cặp.')
const heartbreakEffects = finalModerator.nightResolution.effects.filter((effect) => effect.sourceType === 'LOVER_HEARTBREAK')
invariant(heartbreakEffects.length === 1, 'Heartbreak effect bị thiếu hoặc trùng.')
invariant(heartbreakEffects[0].protectorBlockable === false && heartbreakEffects[0].witchInteractable === false, 'Heartbreak sai block/resurrection contract.')
invariant(finalModerator.cupidLovers.objective.status === 'FALLBACK_VILLAGE', 'Cupid objective không fallback.')
invariant(finalModerator.assignments.find((assignment) => assignment.playerId === cupid.playerId)?.roleId === 'cupid', 'Cupid assignment bị mutate.')
const hiddenNightDeath = await playerProjection(primary, lovers[1])
invariant(hiddenNightDeath.alivePlayerIds.includes(lovers[1].playerId), 'Heartbreak death bị lộ trước Morning.')
evidence.finalHeartbreak = true

await rpc(moderator, 'ms1d1_start_morning', { p_room_id: primary.id })
const dayLoverA = await playerProjection(primary, lovers[0])
const dayLoverB = await playerProjection(primary, lovers[1])
invariant(!dayLoverA.self.alive && !dayLoverB.self.alive, 'Lover death không hiển thị sau Morning.')

if (mode === 'LOCAL') {
  const rescueRoom = await prepareRoom(`f-rescue-${runId}`)
  evidence.rooms += 1
  const rescueLovers = [roleClient(rescueRoom, 'villager', 0), roleClient(rescueRoom, 'villager', 1)]
  const rescueProtector = roleClient(rescueRoom, 'protector')
  await pairAndPrepare(rescueRoom, rescueLovers, {
    wolfTargetId: rescueLovers[0].playerId,
    protectorTargetId: rescueProtector.playerId,
    hunterTargetId: null,
  })
  await witchDecision(rescueRoom, rescueLovers[0].playerId)
  await finalize(rescueRoom)
  const rescued = await moderatorProjection(rescueRoom)
  invariant(rescued.alivePlayerIds.includes(rescueLovers[0].playerId) && rescued.alivePlayerIds.includes(rescueLovers[1].playerId), 'Witch rescue vẫn kích hoạt heartbreak.')
  invariant(!rescued.nightResolution.effects.some((effect) => effect.sourceType === 'LOVER_HEARTBREAK'), 'Rescued provisional death tạo heartbreak effect.')
  evidence.witchRescueNoHeartbreak = true

  const hunterHeartRoom = await prepareRoom(`f-hheart-${runId}`)
  evidence.rooms += 1
  const hhHunter = roleClient(hunterHeartRoom, 'hunter')
  const hhVictim = roleClient(hunterHeartRoom, 'villager', 0)
  const hhShot = roleClient(hunterHeartRoom, 'villager', 1)
  const hhProtector = roleClient(hunterHeartRoom, 'protector')
  await pairAndPrepare(hunterHeartRoom, [hhHunter, hhVictim], {
    wolfTargetId: hhVictim.playerId,
    protectorTargetId: hhProtector.playerId,
    hunterTargetId: hhShot.playerId,
  })
  await witchDecision(hunterHeartRoom, null)
  await finalize(hunterHeartRoom)
  const hhFinal = await moderatorProjection(hunterHeartRoom)
  for (const actor of [hhHunter, hhVictim, hhShot]) {
    invariant(!hhFinal.alivePlayerIds.includes(actor.playerId), 'Hunter-heartbreak fixpoint thiếu death.')
  }
  const hhHunterEffect = hhFinal.nightResolution.effects.find((effect) => effect.sourceType === 'HUNTER_SHOT')
  invariant(hhHunterEffect?.activationStatus === 'ACTIVATED', 'Hunter chết vì heartbreak không kích hoạt pre-lock.')
  evidence.hunterHeartbreakShot = true

  const shotLoverRoom = await prepareRoom(`f-shotlover-${runId}`)
  evidence.rooms += 1
  const slHunter = roleClient(shotLoverRoom, 'hunter')
  const slLovers = [roleClient(shotLoverRoom, 'villager', 0), roleClient(shotLoverRoom, 'villager', 1)]
  const slProtector = roleClient(shotLoverRoom, 'protector')
  await pairAndPrepare(shotLoverRoom, slLovers, {
    wolfTargetId: slHunter.playerId,
    protectorTargetId: slProtector.playerId,
    hunterTargetId: slLovers[0].playerId,
  })
  await witchDecision(shotLoverRoom, null)
  await finalize(shotLoverRoom)
  const slFinal = await moderatorProjection(shotLoverRoom)
  for (const actor of [slHunter, ...slLovers]) {
    invariant(!slFinal.alivePlayerIds.includes(actor.playerId), 'Hunter-shot→Lover chain thiếu death.')
  }
  invariant(slFinal.nightResolution.effects.filter((effect) => effect.sourceType === 'LOVER_HEARTBREAK').length === 1, 'Hunter-shot→Lover tạo sai heartbreak count.')
  evidence.hunterShotLoverChain = true

  const rescuedHunterRoom = await prepareRoom(`f-rescuedhunter-${runId}`)
  evidence.rooms += 1
  const rhHunter = roleClient(rescuedHunterRoom, 'hunter')
  const rhLovers = [roleClient(rescuedHunterRoom, 'villager', 0), roleClient(rescuedHunterRoom, 'villager', 1)]
  const rhProtector = roleClient(rescuedHunterRoom, 'protector')
  await pairAndPrepare(rescuedHunterRoom, rhLovers, {
    wolfTargetId: rhHunter.playerId,
    protectorTargetId: rhProtector.playerId,
    hunterTargetId: rhLovers[0].playerId,
  })
  await witchDecision(rescuedHunterRoom, rhHunter.playerId)
  await finalize(rescuedHunterRoom)
  const rhFinal = await moderatorProjection(rescuedHunterRoom)
  invariant(
    [rhHunter, ...rhLovers].every((actor) => rhFinal.alivePlayerIds.includes(actor.playerId)),
    'Witch-rescued Hunter vẫn tạo shot/Lover chain.',
  )
  const rhHunterEffect = rhFinal.nightResolution.effects.find((effect) => effect.sourceType === 'HUNTER_SHOT')
  invariant(
    rhHunterEffect?.activationStatus === 'CANCELED_SOURCE_SURVIVED',
    'Hunter shot không được hủy sau Witch rescue.',
  )
  invariant(!rhFinal.nightResolution.effects.some((effect) => effect.sourceType === 'LOVER_HEARTBREAK'), 'Canceled Hunter shot vẫn tạo heartbreak.')
  evidence.witchRescuedHunterNoChain = true

  const bothRoom = await prepareRoom(`f-both-${runId}`)
  evidence.rooms += 1
  const bothHunter = roleClient(bothRoom, 'hunter')
  const bothLover = roleClient(bothRoom, 'villager', 0)
  const bothProtector = roleClient(bothRoom, 'protector')
  await pairAndPrepare(bothRoom, [bothHunter, bothLover], {
    wolfTargetId: bothHunter.playerId,
    protectorTargetId: bothProtector.playerId,
    hunterTargetId: bothLover.playerId,
  })
  await witchDecision(bothRoom, null)
  await finalize(bothRoom)
  const bothFinal = await moderatorProjection(bothRoom)
  invariant(!bothFinal.nightResolution.effects.some((effect) => effect.sourceType === 'LOVER_HEARTBREAK'), 'Hai Lover independently dead vẫn tạo duplicate heartbreak.')
  evidence.bothIndependentDeaths = true

  const deadCupidRoom = await prepareRoom(`f-deadcupid-${runId}`)
  evidence.rooms += 1
  const deadCupid = roleClient(deadCupidRoom, 'cupid')
  localSql(`update public.room_players set alive = false where room_id = '${deadCupidRoom.id}'::uuid and id = '${deadCupid.playerId}'::uuid;`)
  await openCupid(deadCupidRoom)
  const deadCupidProjection = await moderatorProjection(deadCupidRoom)
  invariant(!deadCupidProjection.night.actionsByRole.cupid, 'Dead-before-Night1 Cupid nhận action.')
  invariant(deadCupidProjection.cupidLovers.objective.status === 'FALLBACK_VILLAGE', 'Dead Cupid không fallback Village.')
  await rpc(moderator, 'ms1b1_complete_empty_night_role_call', { p_room_id: deadCupidRoom.id, p_role_id: 'cupid' })
  evidence.deadCupidFallback = true

  async function reachDayForVote(room, pairActors, hunterTargetId = null) {
    const voteProtector = roleClient(room, 'protector')
    await pairAndPrepare(room, pairActors, {
      // RANDOM_ON_TIE intentionally randomizes an all-abstain Wolf call, so a
      // null vote is not a no-attack fixture. Use a deterministic blocked
      // attack to reach Day without accidentally killing either Lover.
      wolfTargetId: voteProtector.playerId,
      protectorTargetId: voteProtector.playerId,
      hunterTargetId,
    })
    await witchDecision(room, null)
    await finalize(room)
    await rpc(moderator, 'ms1d1_start_morning', { p_room_id: room.id })
  }

  async function hangOne(room, voter, target) {
    const opened = await rpc(moderator, 'ms1d2_start_day_vote', { p_room_id: room.id })
    await rpc(voter.client, 'ms1d2_cast_day_vote', {
      p_room_id: room.id,
      p_target_player_id: target.playerId,
    })
    localSql(`update private.day_vote_rounds set opened_at = statement_timestamp() - interval '31 seconds', deadline_at = statement_timestamp() - interval '1 second' where room_id = '${room.id}'::uuid and day_number = 1;`)
    if (mode === 'REMOTE') await waitUntil(Date.parse(opened.dayVote.deadlineAt))
    return rpc(moderator, 'ms1f_resolve_day_vote', { p_room_id: room.id })
  }

  const hangRoom = await prepareRoom(`f-hang-${runId}`)
  evidence.rooms += 1
  const hangLover = roleClient(hangRoom, 'villager', 0)
  const hangHunterPartner = roleClient(hangRoom, 'hunter')
  const hangVoter = roleClient(hangRoom, 'werewolf')
  await reachDayForVote(hangRoom, [hangLover, hangHunterPartner], null)
  const hangResult = await hangOne(hangRoom, hangVoter, hangLover)
  invariant(!hangResult.alivePlayerIds.includes(hangLover.playerId) && !hangResult.alivePlayerIds.includes(hangHunterPartner.playerId), 'Day hanging không tạo heartbreak.')
  invariant(!hangResult.dayVote.hunterRevenge, 'Hunter chết vì Day heartbreak được revenge sai luật.')
  await rpc(moderator, 'ms1f_start_next_night', { p_room_id: hangRoom.id })
  evidence.dayHangingHeartbreak = true

  const revengeRoom = await prepareRoom(`f-revenge-${runId}`)
  evidence.rooms += 1
  const revengeHunter = roleClient(revengeRoom, 'hunter')
  const revengeLovers = [roleClient(revengeRoom, 'villager', 0), roleClient(revengeRoom, 'villager', 1)]
  const revengeVoter = roleClient(revengeRoom, 'werewolf')
  await reachDayForVote(revengeRoom, revengeLovers, null)
  await hangOne(revengeRoom, revengeVoter, revengeHunter)
  await rpcFailure(moderator, 'ms1f_start_next_night', { p_room_id: revengeRoom.id }, 'DAY_CONSEQUENCE_NOT_READY')
  await rpc(revengeHunter.client, 'ms1f_submit_hunter_revenge', {
    p_room_id: revengeRoom.id,
    p_target_player_id: revengeLovers[0].playerId,
  })
  const revengeFinal = await moderatorProjection(revengeRoom)
  invariant(!revengeFinal.alivePlayerIds.includes(revengeLovers[0].playerId) && !revengeFinal.alivePlayerIds.includes(revengeLovers[1].playerId), 'Hunter revenge→Lover không ổn định heartbreak.')
  await rpc(moderator, 'ms1f_start_next_night', { p_room_id: revengeRoom.id })
  evidence.dayRevengeHeartbreak = true
}

await Promise.all(clients.map((client) => client.realtime.disconnect()))
console.log(JSON.stringify(evidence, null, 2))
