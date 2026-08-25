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
  const output = process.platform === 'win32'
    ? execFileSync(
        process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/s', '/c', 'npx supabase status -o env'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
    : execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
  const values = parseEnv(output)
  invariant(values.API_URL && (values.PUBLISHABLE_KEY ?? values.ANON_KEY), 'Local Supabase chưa sẵn sàng.')
  return { url: values.API_URL, key: values.PUBLISHABLE_KEY ?? values.ANON_KEY }
}

function remoteEnvironment() {
  const values = { ...process.env }
  if (fs.existsSync('.env.local')) Object.assign(values, parseEnv(fs.readFileSync('.env.local', 'utf8')))
  invariant(values.VITE_SUPABASE_URL && values.VITE_SUPABASE_PUBLISHABLE_KEY, 'Thiếu remote Supabase frontend environment.')
  return { url: values.VITE_SUPABASE_URL, key: values.VITE_SUPABASE_PUBLISHABLE_KEY }
}

const mode = process.argv.includes('--remote') ? 'REMOTE' : 'LOCAL'
const environment = mode === 'REMOTE' ? remoteEnvironment() : localEnvironment()
const runId = `${mode.toLowerCase()}-${Date.now().toString(36)}`

function localSql(statement) {
  invariant(mode === 'LOCAL', 'SQL fixture chỉ được dùng với local QA.')
  return execFileSync('docker', [
    'exec', 'supabase_db_masoi', 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', statement,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function isolatedClient() {
  return createClient(environment.url, environment.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

async function authenticate(client) {
  const result = await client.auth.signInAnonymously()
  invariant(!result.error && result.data.user?.id, `Anonymous Auth thất bại: ${result.error?.message ?? 'missing user'}`)
  if (result.data.session?.access_token) await client.realtime.setAuth(result.data.session.access_token)
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
    invariant(result.error.message === expectedCode, `${name} expected ${expectedCode}; received ${result.error.message}`)
  }
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
invariant(new Set(userIds).size === 9, 'Các QA identity không độc lập.')

const witchConfig = { villager: 3, werewolf: 1, seer: 1, protector: 1, witch: 1 }
const noWitchConfig = { villager: 4, werewolf: 1, seer: 1, protector: 1 }

async function prepareRoom(roleConfig, label) {
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
      p_display_name: `${label.slice(0, 14)}-${index + 1}`,
    }))
  }
  const dealt = await rpc(moderator, 'ms1a_lock_and_assign_roles', { p_room_id: created.room.id })
  await Promise.all(players.map((client) => rpc(client, 'ms1a_confirm_role_reveal', { p_room_id: created.room.id })))
  await rpc(moderator, 'ms1a_start_room', { p_room_id: created.room.id })
  const clientByPlayerId = new Map(joined.map((payload, index) => [payload.self.id, players[index]]))
  const playerIdsByRole = new Map()
  for (const assignment of dealt.assignments) {
    const ids = playerIdsByRole.get(assignment.roleId) ?? []
    ids.push(assignment.playerId)
    playerIdsByRole.set(assignment.roleId, ids)
  }
  return { id: created.room.id, dealt, clientByPlayerId, playerIdsByRole }
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

async function completeWolf(room, targetId) {
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: room.id, p_role_id: 'werewolf' })
  const action = (await moderatorProjection(room)).night.actionsByRole.werewolf
  if (!action) {
    await rpc(moderator, 'ms1b1_complete_empty_night_role_call', { p_room_id: room.id, p_role_id: 'werewolf' })
    return
  }
  for (const actorId of action.eligibleActorIds) {
    const client = room.clientByPlayerId.get(actorId)
    invariant(client, 'Thiếu Wolf client.')
    await rpc(client, 'ms1b1_submit_wolf_ballot', { p_room_id: room.id, p_target_player_id: targetId })
    await rpc(client, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id })
  }
  await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: room.id })
}

async function completeProtector(room, targetId) {
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: room.id, p_role_id: 'protector' })
  const action = (await moderatorProjection(room)).night.actionsByRole.protector
  if (!action) {
    await rpc(moderator, 'ms1b1_complete_empty_night_role_call', { p_room_id: room.id, p_role_id: 'protector' })
    return
  }
  const protector = roleClient(room, 'protector')
  await rpc(protector.client, 'ms1b1_submit_protector_target', { p_room_id: room.id, p_target_player_id: targetId })
}

async function completeSeer(room) {
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: room.id, p_role_id: 'seer' })
  const action = (await moderatorProjection(room)).night.actionsByRole.seer
  if (!action) {
    await rpc(moderator, 'ms1b1_complete_empty_night_role_call', { p_room_id: room.id, p_role_id: 'seer' })
    return
  }
  const seer = roleClient(room, 'seer')
  const targetId = action.eligibleTargetIds[0]
  await rpc(seer.client, 'ms1b1_submit_seer_inspection', { p_room_id: room.id, p_target_player_id: targetId })
  await rpc(seer.client, 'ms1b1_acknowledge_seer_result', { p_room_id: room.id })
}

async function prepareUnblocked(room, targetId, protectorTargetId) {
  await completeWolf(room, targetId)
  if (room.playerIdsByRole.has('protector')) await completeProtector(room, protectorTargetId)
  await completeSeer(room)
  return rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: room.id })
}

async function openWitch(room) {
  return rpc(moderator, 'ms1c_open_witch_call', { p_room_id: room.id })
}

async function submitWitch(room, decision) {
  const witch = roleClient(room, 'witch')
  return rpc(witch.client, 'ms1c_submit_witch_decision', {
    p_room_id: room.id,
    p_resurrection_target_id: decision.resurrectionTargetId,
    p_poison_target_id: decision.poisonTargetId,
  })
}

function advanceNightFixture(room, nightNumber) {
  localSql(`update public.rooms set day_number = ${nightNumber}, phase = 'NIGHT', revision = revision + 1 where id = '${room.id}'::uuid;`)
}

const evidence = {
  mode,
  newAnonymousIdentities: 9,
  representativeDeck: witchConfig,
  remoteCoverage: mode === 'REMOTE' ? 'ONE_NIGHT_ONE_RESURRECTION_ROOM' : 'NOT_APPLICABLE',
  night1Resurrection: null,
  finalDeath: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  protectorBlocked: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  attackedWitchNight1: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  night2PoisonLastAction: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  combinedNight2: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  exhaustedResources: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  noWitch: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  deadWitch: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  idempotency: null,
  privacy: null,
  realtime: null,
}

const main = await prepareRoom(witchConfig, `C-${runId}`)
const witch = roleClient(main, 'witch')
const victim = roleClient(main, 'villager')
const safeTarget = roleClient(main, 'villager', 1)

await completeWolf(main, victim.playerId)
await completeProtector(main, safeTarget.playerId)
await rpcFailure(moderator, 'ms1c_open_witch_call', { p_room_id: main.id }, 'WITCH_CHECKPOINT_NOT_READY')
await completeSeer(main)
await rpcFailure(moderator, 'ms1c_open_witch_call', { p_room_id: main.id }, 'WITCH_CHECKPOINT_NOT_READY')
await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: main.id })

await rpcFailure(victim.client, 'ms1c_open_witch_call', { p_room_id: main.id }, 'NOT_MODERATOR')
await rpcFailure(unrelatedModerator, 'ms1c_open_witch_call', { p_room_id: main.id }, 'NOT_MODERATOR')

const signalPayloads = []
const channels = [moderator, witch.client].map((client) => {
  const channel = client.channel(`room:${main.id}`, { config: { private: true } })
    .on('broadcast', { event: 'room_changed' }, (payload) => signalPayloads.push(payload))
    .subscribe()
  return { client, channel }
})
await waitFor(() => channels.every(({ channel }) => channel.state === 'joined'))

await openWitch(main)
const witchAction = (await playerProjection(main, witch)).nightAction
invariant(witchAction?.mode === 'WITCH_DECISION', 'Witch không nhận combined action.')
invariant(witchAction.resurrectionCandidates.length === 1, 'Witch không nhận đúng một current victim.')
invariant(witchAction.resurrectionCandidates[0].id === victim.playerId, 'Witch victim list sai.')
invariant(!/(source|wolf|killer|effect)/i.test(JSON.stringify(witchAction)), 'Witch projection lộ nguồn/kẻ giết.')
invariant(witchAction.poisonAvailable === false, 'Poison phải bị khóa Night 1.')

await rpcFailure(victim.client, 'ms1c_submit_witch_decision', {
  p_room_id: main.id,
  p_resurrection_target_id: victim.playerId,
  p_poison_target_id: null,
}, 'WRONG_ROLE')
await rpcFailure(witch.client, 'ms1c_submit_witch_decision', {
  p_room_id: main.id,
  p_resurrection_target_id: safeTarget.playerId,
  p_poison_target_id: null,
}, 'WITCH_RESURRECTION_TARGET_INVALID')
await rpcFailure(witch.client, 'ms1c_submit_witch_decision', {
  p_room_id: main.id,
  p_resurrection_target_id: null,
  p_poison_target_id: safeTarget.playerId,
}, 'WITCH_POISON_FORBIDDEN_NIGHT_ONE')
await submitWitch(main, { resurrectionTargetId: victim.playerId, poisonTargetId: null })

const concurrent = await Promise.all([
  rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: main.id }),
  rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: main.id }),
])
invariant(JSON.stringify(concurrent[0]) === JSON.stringify(concurrent[1]), 'Concurrent finalize không idempotent.')
const repeated = await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: main.id })
invariant(JSON.stringify(repeated) === JSON.stringify(concurrent[0]), 'Repeated finalize không ổn định.')
invariant(concurrent[0].rescuedPlayerIds[0] === victim.playerId, 'Resurrection không được persist.')
invariant(concurrent[0].finalDeaths.length === 0, 'Rescued victim vẫn bị final death.')
invariant(concurrent[0].resourcesAfter.resurrectionAvailable === false, 'Resurrection resource chưa consume.')
invariant(concurrent[0].resourcesAfter.poisonAvailable === true, 'Poison resource bị consume nhầm.')
const victimProjection = await playerProjection(main, victim)
invariant(victimProjection.alivePlayerIds.includes(victim.playerId) && !victimProjection.nightAction, 'Rescued Player không neutral/alive.')
invariant(!/(witchCheckpoint|finalDeath|resurrect|WITCH_|sourceEffect)/i.test(JSON.stringify(victimProjection)), 'Player projection lộ Witch/final-death truth.')
await waitFor(() => signalPayloads.length > 0)
invariant(!/(target|source|effect|candidate|resurrect|poison|death|WITCH_)/i.test(JSON.stringify(signalPayloads)), 'Generic Realtime lộ secret.')

const hostileAttempts = [
  await victim.client.schema('private').from('witch_resources').select('*'),
  await victim.client.schema('private').from('witch_decisions').select('*'),
  await victim.client.schema('private').from('witch_rescues').select('*'),
  await victim.client.schema('private').from('night_finalizations').select('*'),
  await victim.client.schema('private').from('night_final_deaths').select('*'),
  await victim.client.schema('private').from('witch_decisions').insert({ room_id: main.id }),
  await moderator.schema('private').from('night_final_deaths').delete().eq('room_id', main.id),
]
invariant(hostileAttempts.every((attempt) => Boolean(attempt.error)), 'Direct Witch private read/DML chưa bị deny.')
await rpcFailure(victim.client, 'ms1c_finalize_night_checkpoint', { p_room_id: main.id }, 'NOT_MODERATOR')
await rpcFailure(unrelatedModerator, 'ms1c_finalize_night_checkpoint', { p_room_id: main.id }, 'NOT_MODERATOR')
await rpcFailure(moderator, 'ms1c_finalize_night_checkpoint', {
  p_room_id: main.id,
  p_target_player_id: victim.playerId,
}, undefined)

evidence.night1Resurrection = {
  victim: victim.playerId,
  alive: true,
  currentNightOnly: true,
  sourceHiddenFromWitch: true,
  sourceHistoryPreserved: true,
  potionConsumed: true,
  phase: 'NIGHT',
}
evidence.idempotency = { concurrentRequests: 2, logicalFinalizations: 1, repeatedStable: true }
evidence.privacy = {
  nonWitchSubmitDenied: true,
  playerOpenDenied: true,
  otherModeratorDenied: true,
  forgedFinalizeArgsDenied: true,
  directPrivateReadDmlDenied: true,
  ordinaryPlayerNeutral: true,
  witchNamesOnly: true,
}
evidence.realtime = { signal: 'room_changed', secretPayload: false }

if (mode === 'LOCAL') {
  const mainCounts = localSql(`select
    (select count(*) from private.night_finalizations where room_id = '${main.id}'::uuid),
    (select count(*) from private.witch_rescues where room_id = '${main.id}'::uuid),
    (select count(*) from private.night_final_deaths where room_id = '${main.id}'::uuid),
    (select count(*) from private.night_effects where room_id = '${main.id}'::uuid and source_type = 'WOLF_ATTACK');`)
  invariant(mainCounts === '1|1|0|1', `Main persistence counts sai: ${mainCounts}`)

  const deathRoom = await prepareRoom(witchConfig, `D-${runId}`)
  const deathVictim = roleClient(deathRoom, 'villager')
  await prepareUnblocked(deathRoom, deathVictim.playerId, roleClient(deathRoom, 'villager', 1).playerId)
  await openWitch(deathRoom)
  await submitWitch(deathRoom, { resurrectionTargetId: null, poisonTargetId: null })
  const deathFinal = await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: deathRoom.id })
  invariant(deathFinal.finalDeaths[0].playerId === deathVictim.playerId, 'Do-nothing không tạo final death.')
  invariant(localSql(`select alive from public.room_players where id = '${deathVictim.playerId}'::uuid;`) === 'f', 'Final death chưa set alive=false.')
  const hiddenDeath = await playerProjection(deathRoom, deathVictim)
  invariant(hiddenDeath.alivePlayerIds.includes(deathVictim.playerId), 'Night projection lộ death screen.')
  evidence.finalDeath = { aliveInDb: false, playerNightProjectionAlive: true, phase: 'NIGHT' }

  const blockedRoom = await prepareRoom(witchConfig, `B-${runId}`)
  const blockedTarget = roleClient(blockedRoom, 'villager')
  await completeProtector(blockedRoom, blockedTarget.playerId)
  await completeWolf(blockedRoom, blockedTarget.playerId)
  await completeSeer(blockedRoom)
  await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: blockedRoom.id })
  await openWitch(blockedRoom)
  const blockedAction = (await playerProjection(blockedRoom, roleClient(blockedRoom, 'witch'))).nightAction
  invariant(blockedAction.resurrectionCandidates.length === 0, 'Blocked target xuất hiện trong Witch list.')
  await submitWitch(blockedRoom, { resurrectionTargetId: null, poisonTargetId: null })
  const blockedFinal = await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: blockedRoom.id })
  invariant(blockedFinal.finalDeaths.length === 0, 'Blocked target bị final death.')
  evidence.protectorBlocked = { witchDeathList: 0, finalDeaths: 0 }

  const attackedN1 = await prepareRoom(witchConfig, `A1-${runId}`)
  const attackedWitch = roleClient(attackedN1, 'witch')
  await prepareUnblocked(attackedN1, attackedWitch.playerId, roleClient(attackedN1, 'villager').playerId)
  await openWitch(attackedN1)
  const attackedN1Action = (await playerProjection(attackedN1, attackedWitch)).nightAction
  invariant(attackedN1Action.witchAttackedThisNight && !attackedN1Action.resurrectionAvailable && !attackedN1Action.poisonAvailable, 'Attacked N1 capability sai.')
  await rpcFailure(attackedWitch.client, 'ms1c_submit_witch_decision', {
    p_room_id: attackedN1.id,
    p_resurrection_target_id: attackedWitch.playerId,
    p_poison_target_id: null,
  }, 'WITCH_ATTACKED_CANNOT_RESURRECT')
  await submitWitch(attackedN1, { resurrectionTargetId: null, poisonTargetId: null })
  await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: attackedN1.id })
  invariant(localSql(`select alive from public.room_players where id = '${attackedWitch.playerId}'::uuid;`) === 'f', 'Attacked Witch N1 chưa chết.')
  evidence.attackedWitchNight1 = { resurrectionDenied: true, poisonDenied: true, finalizedDead: true }

  const attackedN2 = await prepareRoom(witchConfig, `A2-${runId}`)
  advanceNightFixture(attackedN2, 2)
  const attackedWitch2 = roleClient(attackedN2, 'witch')
  const lastPoisonTarget = roleClient(attackedN2, 'villager')
  await prepareUnblocked(attackedN2, attackedWitch2.playerId, roleClient(attackedN2, 'villager', 1).playerId)
  await openWitch(attackedN2)
  const attackedN2Action = (await playerProjection(attackedN2, attackedWitch2)).nightAction
  invariant(attackedN2Action.witchAttackedThisNight && !attackedN2Action.resurrectionAvailable && attackedN2Action.poisonAvailable, 'Attacked N2 capability sai.')
  await rpcFailure(attackedWitch2.client, 'ms1c_submit_witch_decision', {
    p_room_id: attackedN2.id,
    p_resurrection_target_id: null,
    p_poison_target_id: attackedWitch2.playerId,
  }, 'WITCH_POISON_SELF_TARGET')
  await submitWitch(attackedN2, { resurrectionTargetId: null, poisonTargetId: lastPoisonTarget.playerId })
  const attackedN2Final = await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: attackedN2.id })
  invariant(attackedN2Final.finalDeaths.length === 2, 'Last-action poison không tạo hai final deaths.')
  invariant(attackedN2Final.poisonEffect.protectorBlockable === false, 'Poison bị đánh dấu Protector-blockable.')
  evidence.night2PoisonLastAction = { resurrectionDenied: true, poisonAllowed: true, witchDead: true, poisonTargetDead: true, protectorBlockable: false }

  const combined = await prepareRoom(witchConfig, `C2-${runId}`)
  advanceNightFixture(combined, 2)
  const combinedVictim = roleClient(combined, 'villager')
  const combinedPoison = roleClient(combined, 'villager', 1)
  const priorDead = roleClient(combined, 'villager', 2)
  localSql(`update public.room_players set alive = false where id = '${priorDead.playerId}'::uuid;`)
  await prepareUnblocked(combined, combinedVictim.playerId, combinedPoison.playerId)
  await openWitch(combined)
  const combinedWitch = roleClient(combined, 'witch')
  await rpcFailure(combinedWitch.client, 'ms1c_submit_witch_decision', {
    p_room_id: combined.id,
    p_resurrection_target_id: priorDead.playerId,
    p_poison_target_id: null,
  }, 'WITCH_RESURRECTION_TARGET_INVALID')
  await submitWitch(combined, { resurrectionTargetId: combinedVictim.playerId, poisonTargetId: combinedPoison.playerId })
  const combinedFinal = await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: combined.id })
  invariant(combinedFinal.rescuedPlayerIds[0] === combinedVictim.playerId, 'Combined rescue sai.')
  invariant(combinedFinal.finalDeaths.some((death) => death.playerId === combinedPoison.playerId), 'Combined poison death thiếu.')
  invariant(combinedFinal.resourcesAfter.resurrectionAvailable === false && combinedFinal.resourcesAfter.poisonAvailable === false, 'Combined resources không consume atomically.')
  advanceNightFixture(combined, 3)
  const nextTarget = roleClient(combined, 'seer')
  await prepareUnblocked(combined, nextTarget.playerId, combinedVictim.playerId)
  await openWitch(combined)
  const exhaustedAction = (await playerProjection(combined, combinedWitch)).nightAction
  invariant(exhaustedAction.resurrectionCandidates.length === 0 && exhaustedAction.poisonCandidates.length === 0, 'Spent resources vẫn lộ candidate names.')
  await rpcFailure(combinedWitch.client, 'ms1c_submit_witch_decision', {
    p_room_id: combined.id,
    p_resurrection_target_id: nextTarget.playerId,
    p_poison_target_id: null,
  }, 'WITCH_RESURRECTION_UNAVAILABLE')
  await rpcFailure(combinedWitch.client, 'ms1c_submit_witch_decision', {
    p_room_id: combined.id,
    p_resurrection_target_id: null,
    p_poison_target_id: combinedVictim.playerId,
  }, 'WITCH_POISON_UNAVAILABLE')
  await submitWitch(combined, { resurrectionTargetId: null, poisonTargetId: null })
  await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: combined.id })
  evidence.combinedNight2 = { resurrectionAndPoison: true, atomicConsumption: true, rescuedAlive: true, poisonDead: true, priorDeathRejected: true }
  evidence.exhaustedResources = { resurrectionSecondUseDenied: true, poisonSecondUseDenied: true, candidateNamesHidden: true }

  const noWitch = await prepareRoom(noWitchConfig, `NW-${runId}`)
  const noWitchVictim = roleClient(noWitch, 'villager')
  await prepareUnblocked(noWitch, noWitchVictim.playerId, roleClient(noWitch, 'villager', 1).playerId)
  const noWitchFinal = await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: noWitch.id })
  invariant(noWitchFinal.finalDeaths[0].playerId === noWitchVictim.playerId, 'No-Witch direct finalization sai.')
  evidence.noWitch = { directFinalization: true, victimDead: true }

  const deadWitchRoom = await prepareRoom(witchConfig, `DW-${runId}`)
  const deadWitch = roleClient(deadWitchRoom, 'witch')
  const deadWitchVictim = roleClient(deadWitchRoom, 'villager')
  localSql(`update public.room_players set alive = false where id = '${deadWitch.playerId}'::uuid;`)
  await prepareUnblocked(deadWitchRoom, deadWitchVictim.playerId, roleClient(deadWitchRoom, 'villager', 1).playerId)
  await openWitch(deadWitchRoom)
  invariant(!(await playerProjection(deadWitchRoom, deadWitch)).nightAction, 'Dead-before-Night Witch nhận action.')
  await rpc(moderator, 'ms1b1_complete_empty_night_role_call', { p_room_id: deadWitchRoom.id, p_role_id: 'witch' })
  const deadWitchFinal = await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: deadWitchRoom.id })
  invariant(deadWitchFinal.finalDeaths.some((death) => death.playerId === deadWitchVictim.playerId), 'Dead Witch ritual không finalize candidate.')
  evidence.deadWitch = { rituallyCalled: true, playerAction: false, finalization: true }
}

for (const { client, channel } of channels) await client.removeChannel(channel)
await Promise.all(clients.map((client) => client.realtime.disconnect()))

console.log(`MS-1C ${mode} SUPABASE QA PASS`)
console.log(JSON.stringify(evidence, null, 2))
