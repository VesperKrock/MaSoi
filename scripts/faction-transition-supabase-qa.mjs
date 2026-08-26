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
  if (fs.existsSync('.env.local')) Object.assign(values, parseEnv(fs.readFileSync('.env.local', 'utf8')))
  invariant(values.VITE_SUPABASE_URL && values.VITE_SUPABASE_PUBLISHABLE_KEY, 'Thiếu remote Supabase frontend environment.')
  return { url: values.VITE_SUPABASE_URL, key: values.VITE_SUPABASE_PUBLISHABLE_KEY }
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

async function waitUntil(timestamp) {
  const delay = Math.max(0, timestamp - Date.now() + 180)
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
}

const moderator = isolatedClient()
const players = Array.from({ length: 7 }, () => isolatedClient())
const clients = [moderator, ...players]
const userIds = await Promise.all(clients.map(authenticate))
invariant(new Set(userIds).size === 8, 'MS-1E cần đúng 8 isolated identities.')

const config = {
  villager: 2,
  werewolf: 1,
  traitor: 1,
  'half-wolf': 1,
  seer: 1,
  protector: 1,
}

async function prepareRoom(label, roleConfig = config) {
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
  return { id: created.room.id, code: created.room.code, dealt, clientByPlayerId, playerIdsByRole }
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

async function finishWolfCall(room, target, actors) {
  for (const actor of actors) {
    await rpc(actor.client, 'ms1b1_submit_wolf_ballot', {
      p_room_id: room.id, p_target_player_id: target.playerId,
    })
    await rpc(actor.client, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id })
  }
  return rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: room.id })
}

async function runNightOneBite(room, protectorBlocks) {
  const wolf = roleClient(room, 'werewolf')
  const traitor = roleClient(room, 'traitor')
  const halfWolf = roleClient(room, 'half-wolf')
  const seer = roleClient(room, 'seer')
  const protector = roleClient(room, 'protector')
  const safeVillager = roleClient(room, 'villager')

  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: room.id, p_role_id: 'protector' })
  await rpc(protector.client, 'ms1b1_submit_protector_target', {
    p_room_id: room.id,
    p_target_player_id: protectorBlocks ? halfWolf.playerId : safeVillager.playerId,
  })

  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: room.id, p_role_id: 'werewolf' })
  const wolfAction = (await playerProjection(room, wolf)).nightAction
  const traitorAction = (await playerProjection(room, traitor)).nightAction
  const halfWolfBefore = await playerProjection(room, halfWolf)
  invariant(wolfAction?.mode === 'WOLF_BALLOT', 'Werewolf không nhận Wolf action Night 1.')
  invariant(traitorAction?.mode === 'WOLF_BALLOT', 'Traitor không tham gia khi bite-capable Wolf sống.')
  invariant(!halfWolfBefore.nightAction, 'Half-Wolf chưa hóa đã nhận Wolf action.')
  invariant(wolfAction.candidates.some((candidate) => candidate.id === halfWolf.playerId), 'Half-Wolf chưa hóa không targetable.')
  await finishWolfCall(room, halfWolf, [wolf, traitor])

  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: room.id, p_role_id: 'seer' })
  await rpc(seer.client, 'ms1b1_submit_seer_inspection', {
    p_room_id: room.id, p_target_player_id: halfWolf.playerId,
  })
  const seerNightOne = (await playerProjection(room, seer)).nightAction
  invariant(seerNightOne?.seerResult === 'NON_WOLF', 'Seer Night 1 phải thấy Half-Wolf là NON_WOLF.')
  await rpc(seer.client, 'ms1b1_acknowledge_seer_result', { p_room_id: room.id })

  const [resolutionA, resolutionB] = await Promise.all([
    rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: room.id }),
    rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: room.id }),
  ])
  invariant(resolutionA.id === resolutionB.id, 'Concurrent resolve tạo nhiều logical resolutions.')
  return { wolf, traitor, halfWolf, seer, protector, resolution: resolutionA }
}

async function reachDay(room) {
  await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: room.id })
  await rpc(moderator, 'ms1d1_start_morning', { p_room_id: room.id })
}

async function hang(room, voter, target, dayNumber = 1) {
  const vote = await rpc(moderator, 'ms1d2_start_day_vote', { p_room_id: room.id })
  await rpc(voter.client, 'ms1d2_cast_day_vote', {
    p_room_id: room.id, p_target_player_id: target.playerId,
  })
  if (mode === 'LOCAL') {
    localSql(`update private.day_vote_rounds
      set opened_at = statement_timestamp() - interval '31 seconds',
          deadline_at = statement_timestamp() - interval '1 second'
      where room_id = '${room.id}'::uuid and day_number = ${dayNumber};`)
  } else {
    await waitUntil(Date.parse(vote.dayVote.deadlineAt))
  }
  return rpc(moderator, 'ms1d2_resolve_day_vote', { p_room_id: room.id })
}

async function assertPrivateTablesDenied(actor, room) {
  for (const table of ['half_wolf_transitions', 'traitor_faction_transitions']) {
    const read = await actor.client.schema('private').from(table).select('*').eq('room_id', room.id)
    invariant(Boolean(read.error), `Player đọc được private.${table}.`)
    const write = await actor.client.schema('private').from(table).delete().eq('room_id', room.id)
    invariant(Boolean(write.error), `Player ghi được private.${table}.`)
  }
}

const evidence = {
  mode,
  anonymousIdentities: 8,
  rooms: 0,
  naturalNightTwo: false,
  protectorBlocked: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  traitorPermanentConversion: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  hunterRevengeReconciliation: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  nightFinalizationReconciliation: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  transformedHalfWolfKeepsPack: mode === 'REMOTE' ? 'PROVEN_WITH_LIVING_WOLF' : false,
  convertedTraitorSeerTruth: mode === 'REMOTE' ? 'LOCAL_ONLY' : false,
  privateTablesDenied: false,
}

const primary = await prepareRoom(`e-main-${runId}`)
evidence.rooms += 1
const primaryRoles = await runNightOneBite(primary, false)
invariant(primaryRoles.resolution.outcome === 'BITE_SCHEDULED', 'Successful Half-Wolf bite không có BITE_SCHEDULED outcome.')
invariant(primaryRoles.resolution.effects[0].lethal === false, 'Half-Wolf bite bị lưu như lethal effect.')
invariant(primaryRoles.resolution.effects[0].outcome === 'HALF_WOLF_BITE_SCHEDULED', 'Thiếu explicit Half-Wolf bite outcome.')
invariant(primaryRoles.resolution.provisionalDeathCandidateIds.length === 0, 'Half-Wolf bite tạo provisional death candidate.')

const pendingProjection = await moderatorProjection(primary)
invariant(pendingProjection.factionTransitions.halfWolves[primaryRoles.halfWolf.playerId].status === 'PENDING_TRANSFORMATION', 'Moderator không thấy trạng thái chờ hóa.')
const privateHalfProjection = await playerProjection(primary, primaryRoles.halfWolf)
invariant(!('factionTransitions' in privateHalfProjection), 'Player projection lộ transition table.')
invariant(!JSON.stringify(privateHalfProjection).includes('PENDING_TRANSFORMATION'), 'Half-Wolf được báo bí mật bị cắn.')
await rpcFailure(primaryRoles.halfWolf.client, 'ms1b2_resolve_night_effects', { p_room_id: primary.id }, 'NOT_MODERATOR')
await assertPrivateTablesDenied(primaryRoles.halfWolf, primary)
evidence.privateTablesDenied = true

await reachDay(primary)
const dayProjection = await moderatorProjection(primary)
invariant(dayProjection.factionTransitions.halfWolves[primaryRoles.halfWolf.playerId].status === 'PENDING_TRANSFORMATION', 'Half-Wolf không giữ Village/pending qua Day 1.')
const dayTarget = roleClient(primary, 'villager', 1)
await hang(primary, primaryRoles.seer, dayTarget)
await rpc(moderator, 'ms1d2_start_next_night', { p_room_id: primary.id })
const nightTwo = await moderatorProjection(primary)
invariant(nightTwo.room.phase === 'NIGHT' && nightTwo.room.dayNumber === 2, 'Không đạt Night 2 tự nhiên.')
invariant(nightTwo.night.activeRoleId === null, 'Transition tự gọi role Night 2.')
invariant(nightTwo.factionTransitions.halfWolves[primaryRoles.halfWolf.playerId].status === 'TRANSFORMED', 'Half-Wolf không hóa trước role call Night 2.')

await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: primary.id, p_role_id: 'werewolf' })
const activeNightTwo = await moderatorProjection(primary)
const actorIds = activeNightTwo.night.actionsByRole.werewolf.eligibleActorIds
invariant(actorIds.includes(primaryRoles.wolf.playerId), 'Werewolf mất Wolf action Night 2.')
invariant(actorIds.includes(primaryRoles.traitor.playerId), 'Traitor không còn eligible khi bite-capable Wolf sống.')
invariant(actorIds.includes(primaryRoles.halfWolf.playerId), 'Transformed Half-Wolf không nhận Wolf action.')
for (const actor of [primaryRoles.wolf, primaryRoles.traitor, primaryRoles.halfWolf]) {
  const action = (await playerProjection(primary, actor)).nightAction
  invariant(action?.mode === 'WOLF_BALLOT', `Wolf-group actor ${actor.playerId} thiếu private action.`)
  invariant(!action.candidates.some((candidate) => actorIds.includes(candidate.id)), 'Wolf target list chứa Wolf-aligned actor.')
}
const nightTwoVictim = roleClient(primary, 'villager')
await finishWolfCall(primary, nightTwoVictim, [primaryRoles.wolf, primaryRoles.traitor, primaryRoles.halfWolf])
await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: primary.id, p_role_id: 'seer' })
await rpc(primaryRoles.seer.client, 'ms1b1_submit_seer_inspection', {
  p_room_id: primary.id, p_target_player_id: primaryRoles.halfWolf.playerId,
})
const seerNightTwo = (await playerProjection(primary, primaryRoles.seer)).nightAction
invariant(seerNightTwo?.seerResult === 'WOLF', 'Seer Night 2 không thấy transformed Half-Wolf là WOLF.')
evidence.naturalNightTwo = true

if (mode === 'LOCAL') {
  const blocked = await prepareRoom(`e-block-${runId}`)
  evidence.rooms += 1
  const blockedRoles = await runNightOneBite(blocked, true)
  invariant(blockedRoles.resolution.outcome === 'BLOCKED', 'Protector không chặn Half-Wolf bite.')
  const blockedProjection = await moderatorProjection(blocked)
  invariant(blockedProjection.factionTransitions.halfWolves[blockedRoles.halfWolf.playerId].status === 'VILLAGE', 'Blocked bite vẫn tạo pending transform.')
  evidence.protectorBlocked = true

  const permanent = await prepareRoom(`e-perm-${runId}`)
  evidence.rooms += 1
  const permanentRoles = await runNightOneBite(permanent, false)
  await reachDay(permanent)
  await hang(permanent, permanentRoles.seer, permanentRoles.wolf)
  const convertedDay = await moderatorProjection(permanent)
  invariant(convertedDay.factionTransitions.traitors[permanentRoles.traitor.playerId].status === 'CONVERTED_VILLAGE', 'Traitor không chuyển Village ngay khi Wolf cuối bị treo.')
  invariant(convertedDay.factionTransitions.halfWolves[permanentRoles.halfWolf.playerId].status === 'PENDING_TRANSFORMATION', 'Half-Wolf hóa quá sớm trong Day.')
  localSql(`select private.ms1e_reconcile_faction_transitions('${permanent.id}'::uuid, 'AFTER_DEATH', 1); select private.ms1e_reconcile_faction_transitions('${permanent.id}'::uuid, 'AFTER_DEATH', 1);`)
  const conversionRows = Number(localSql(`select count(*) from private.traitor_faction_transitions where room_id = '${permanent.id}'::uuid;`))
  const conversionEvents = Number(localSql(`select count(*) from private.gameplay_events where room_id = '${permanent.id}'::uuid and event_type = 'TRAITOR_CONVERTED_TO_VILLAGE';`))
  invariant(conversionRows === 1 && conversionEvents === 1, 'Transition reconciliation không idempotent.')
  await rpc(moderator, 'ms1d2_start_next_night', { p_room_id: permanent.id })
  const permanentNightTwo = await moderatorProjection(permanent)
  invariant(permanentNightTwo.factionTransitions.halfWolves[permanentRoles.halfWolf.playerId].status === 'TRANSFORMED', 'Pending Half-Wolf không hóa Night 2.')
  invariant(permanentNightTwo.factionTransitions.traitors[permanentRoles.traitor.playerId].status === 'CONVERTED_VILLAGE', 'Converted Traitor dao động trở lại phe Sói.')
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: permanent.id, p_role_id: 'werewolf' })
  const permanentWolfAction = (await playerProjection(permanent, permanentRoles.halfWolf)).nightAction
  invariant(permanentWolfAction?.mode === 'WOLF_BALLOT', 'Transformed Half-Wolf không giữ pack sống.')
  invariant(permanentWolfAction.candidates.some((candidate) => candidate.id === permanentRoles.traitor.playerId), 'Converted Traitor không trở thành Wolf target.')
  invariant(!(await playerProjection(permanent, permanentRoles.traitor)).nightAction, 'Converted Traitor quay lại Wolf action.')
  await finishWolfCall(permanent, permanentRoles.traitor, [permanentRoles.halfWolf])
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: permanent.id, p_role_id: 'seer' })
  await rpc(permanentRoles.seer.client, 'ms1b1_submit_seer_inspection', {
    p_room_id: permanent.id, p_target_player_id: permanentRoles.traitor.playerId,
  })
  invariant((await playerProjection(permanent, permanentRoles.seer)).nightAction?.seerResult === 'NON_WOLF', 'Converted Traitor không còn NON_WOLF với Seer.')
  evidence.traitorPermanentConversion = true
  evidence.convertedTraitorSeerTruth = true

  localSql(`update public.room_players set alive = false
    where room_id = '${primary.id}'::uuid and id = '${primaryRoles.wolf.playerId}'::uuid;`)
  const transformedKeepsPack = await moderatorProjection(primary)
  invariant(transformedKeepsPack.factionTransitions.traitors[primaryRoles.traitor.playerId].status === 'WOLF_ALIGNED', 'Transformed Half-Wolf không giữ Traitor ở phe Sói khi normal Wolf chết.')
  evidence.transformedHalfWolfKeepsPack = true

  const hunterConfig = {
    villager: 2,
    werewolf: 1,
    traitor: 1,
    'half-wolf': 1,
    hunter: 1,
    protector: 1,
  }
  const revengeRoom = await prepareRoom(`e-revenge-${runId}`, hunterConfig)
  evidence.rooms += 1
  const revengeWolf = roleClient(revengeRoom, 'werewolf')
  const revengeTraitor = roleClient(revengeRoom, 'traitor')
  const revengeHunter = roleClient(revengeRoom, 'hunter')
  const revengeProtector = roleClient(revengeRoom, 'protector')
  const revengeVillager = roleClient(revengeRoom, 'villager')
  const revengeVoter = roleClient(revengeRoom, 'half-wolf')
  await rpc(moderator, 'ms1d1_open_hunter_call', { p_room_id: revengeRoom.id })
  await rpc(revengeHunter.client, 'ms1d1_submit_hunter_prelock', {
    p_room_id: revengeRoom.id, p_target_player_id: null,
  })
  await rpc(revengeHunter.client, 'ms1d1_confirm_hunter_prelock', { p_room_id: revengeRoom.id })
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: revengeRoom.id, p_role_id: 'protector' })
  await rpc(revengeProtector.client, 'ms1b1_submit_protector_target', {
    p_room_id: revengeRoom.id, p_target_player_id: revengeVillager.playerId,
  })
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: revengeRoom.id, p_role_id: 'werewolf' })
  await finishWolfCall(revengeRoom, revengeVillager, [revengeWolf, revengeTraitor])
  const revengeResolution = await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: revengeRoom.id })
  invariant(revengeResolution.outcome === 'BLOCKED', 'Hunter-revenge fixture Night không ổn định.')
  await reachDay(revengeRoom)
  await hang(revengeRoom, revengeVoter, revengeHunter)
  await rpc(revengeHunter.client, 'ms1d2_submit_hunter_revenge', {
    p_room_id: revengeRoom.id, p_target_player_id: revengeWolf.playerId,
  })
  const revengeProjection = await moderatorProjection(revengeRoom)
  invariant(revengeProjection.factionTransitions.traitors[revengeTraitor.playerId].status === 'CONVERTED_VILLAGE', 'Hunter revenge giết Wolf cuối nhưng Traitor chưa chuyển ngay.')
  evidence.hunterRevengeReconciliation = true

  const witchConfig = {
    villager: 2,
    werewolf: 1,
    traitor: 1,
    'half-wolf': 1,
    witch: 1,
    protector: 1,
  }
  const finalRoom = await prepareRoom(`e-final-${runId}`, witchConfig)
  evidence.rooms += 1
  const finalWolf = roleClient(finalRoom, 'werewolf')
  const finalTraitor = roleClient(finalRoom, 'traitor')
  const finalWitch = roleClient(finalRoom, 'witch')
  const finalProtector = roleClient(finalRoom, 'protector')
  const finalHalf = roleClient(finalRoom, 'half-wolf')
  const finalVillagerA = roleClient(finalRoom, 'villager')
  const finalVillagerB = roleClient(finalRoom, 'villager', 1)
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: finalRoom.id, p_role_id: 'protector' })
  await rpc(finalProtector.client, 'ms1b1_submit_protector_target', {
    p_room_id: finalRoom.id, p_target_player_id: finalVillagerA.playerId,
  })
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: finalRoom.id, p_role_id: 'werewolf' })
  await finishWolfCall(finalRoom, finalVillagerA, [finalWolf, finalTraitor])
  await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: finalRoom.id })
  await rpc(moderator, 'ms1c_open_witch_call', { p_room_id: finalRoom.id })
  await rpc(finalWitch.client, 'ms1c_submit_witch_decision', {
    p_room_id: finalRoom.id,
    p_resurrection_target_id: null,
    p_poison_target_id: null,
  })
  await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: finalRoom.id })
  await rpc(moderator, 'ms1d1_start_morning', { p_room_id: finalRoom.id })
  await hang(finalRoom, finalHalf, finalVillagerB)
  await rpc(moderator, 'ms1d2_start_next_night', { p_room_id: finalRoom.id })
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: finalRoom.id, p_role_id: 'protector' })
  await rpc(finalProtector.client, 'ms1b1_submit_protector_target', {
    p_room_id: finalRoom.id, p_target_player_id: finalWitch.playerId,
  })
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: finalRoom.id, p_role_id: 'werewolf' })
  await finishWolfCall(finalRoom, finalVillagerA, [finalWolf, finalTraitor])
  await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: finalRoom.id })
  await rpc(moderator, 'ms1c_open_witch_call', { p_room_id: finalRoom.id })
  await rpc(finalWitch.client, 'ms1c_submit_witch_decision', {
    p_room_id: finalRoom.id,
    p_resurrection_target_id: finalVillagerA.playerId,
    p_poison_target_id: finalWolf.playerId,
  })
  await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: finalRoom.id })
  const finalProjection = await moderatorProjection(finalRoom)
  invariant(finalProjection.factionTransitions.traitors[finalTraitor.playerId].status === 'CONVERTED_VILLAGE', 'Night finalization giết Wolf cuối nhưng Traitor chưa chuyển ngay.')
  invariant(!finalProjection.alivePlayerIds.includes(finalWolf.playerId), 'Witch poison fixture không giết Wolf cuối.')
  evidence.nightFinalizationReconciliation = true
}

console.log(JSON.stringify(evidence, null, 2))
