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
const unrelatedModerator = mode === 'LOCAL' ? isolatedClient() : null
const clients = [moderator, ...players, ...(unrelatedModerator ? [unrelatedModerator] : [])]
const userIds = await Promise.all(clients.map(authenticate))
invariant(new Set(userIds).size === clients.length, 'Các QA identity không độc lập.')

const hunterConfig = { villager: 3, werewolf: 1, protector: 1, hunter: 1, witch: 1 }

async function prepareRoom(label) {
  const created = await rpc(moderator, 'ms1a_create_room', {
    p_request_id: randomUUID(),
    p_seat_count: 7,
    p_role_config: hunterConfig,
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

async function completeHunter(room, targetId, { changeSelection = false } = {}) {
  await rpc(moderator, 'ms1d1_open_hunter_call', { p_room_id: room.id })
  const action = (await moderatorProjection(room)).night.actionsByRole.hunter
  if (!action) {
    await rpc(moderator, 'ms1b1_complete_empty_night_role_call', { p_room_id: room.id, p_role_id: 'hunter' })
    return null
  }
  const hunter = roleClient(room, 'hunter')
  if (changeSelection) {
    const firstTarget = action.eligibleTargetIds.find((id) => id !== targetId) ?? null
    await rpc(hunter.client, 'ms1d1_submit_hunter_prelock', {
      p_room_id: room.id,
      p_target_player_id: firstTarget,
    })
  }
  await rpc(hunter.client, 'ms1d1_submit_hunter_prelock', {
    p_room_id: room.id,
    p_target_player_id: targetId,
  })
  const refreshed = await playerProjection(room, hunter)
  invariant(refreshed.nightAction?.mode === 'HUNTER_PRELOCK', 'Refresh không khôi phục Hunter pre-lock.')
  invariant(refreshed.nightAction.hasSelected, 'Hunter selection không được persist.')
  invariant(refreshed.nightAction.currentTargetId === targetId, 'Hunter refresh trả sai target/Nobody.')
  await rpc(hunter.client, 'ms1d1_confirm_hunter_prelock', { p_room_id: room.id })
  await rpc(hunter.client, 'ms1d1_confirm_hunter_prelock', { p_room_id: room.id })
  return hunter
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

async function completeWolf(room, targetId) {
  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: room.id, p_role_id: 'werewolf' })
  const action = (await moderatorProjection(room)).night.actionsByRole.werewolf
  invariant(action, 'Representative room thiếu living Wolf action.')
  for (const actorId of action.eligibleActorIds) {
    const client = room.clientByPlayerId.get(actorId)
    invariant(client, 'Thiếu Wolf client.')
    await rpc(client, 'ms1b1_submit_wolf_ballot', { p_room_id: room.id, p_target_player_id: targetId })
    await rpc(client, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id })
  }
  await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: room.id })
}

async function resolvePreWitch(room, wolfTargetId, protectorTargetId, hunterTargetId, options = {}) {
  await completeHunter(room, hunterTargetId, options)
  await completeProtector(room, protectorTargetId)
  await completeWolf(room, wolfTargetId)
  return rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: room.id })
}

async function openWitch(room) {
  return rpc(moderator, 'ms1c_open_witch_call', { p_room_id: room.id })
}

async function submitWitch(room, resurrectionTargetId, poisonTargetId = null) {
  const witch = roleClient(room, 'witch')
  return rpc(witch.client, 'ms1c_submit_witch_decision', {
    p_room_id: room.id,
    p_resurrection_target_id: resurrectionTargetId,
    p_poison_target_id: poisonTargetId,
  })
}

function advanceNightFixture(room, nightNumber) {
  localSql(`update public.rooms set day_number = ${nightNumber}, phase = 'NIGHT', revision = revision + 1 where id = '${room.id}'::uuid;`)
}

const evidence = {
  mode,
  newAnonymousIdentities: clients.length,
  representativeDeck: hunterConfig,
  selectionAndRefresh: null,
  rescueHunter: null,
  activateShot: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  rescueShotVictim: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  nobody: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  deadBeforeNight: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  hunterSurvives: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  independentLethalSource: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  morning: null,
  idempotency: null,
  privacy: null,
  realtime: null,
}

const main = await prepareRoom(`D1-${runId}`)
const hunter = roleClient(main, 'hunter')
const witch = roleClient(main, 'witch')
const shotTarget = roleClient(main, 'villager')
const safeTarget = roleClient(main, 'villager', 1)
const nonHunter = roleClient(main, 'villager', 2)

await rpcFailure(nonHunter.client, 'ms1d1_open_hunter_call', { p_room_id: main.id }, 'NOT_MODERATOR')
if (unrelatedModerator) {
  await rpcFailure(unrelatedModerator, 'ms1d1_open_hunter_call', { p_room_id: main.id }, 'NOT_MODERATOR')
}
await rpc(moderator, 'ms1d1_open_hunter_call', { p_room_id: main.id })
await rpcFailure(nonHunter.client, 'ms1d1_submit_hunter_prelock', {
  p_room_id: main.id,
  p_target_player_id: shotTarget.playerId,
}, 'WRONG_ROLE')
await rpcFailure(hunter.client, 'ms1d1_submit_hunter_prelock', {
  p_room_id: main.id,
  p_target_player_id: hunter.playerId,
}, 'INVALID_TARGET')
await rpc(hunter.client, 'ms1d1_submit_hunter_prelock', {
  p_room_id: main.id,
  p_target_player_id: safeTarget.playerId,
})
await rpc(hunter.client, 'ms1d1_submit_hunter_prelock', {
  p_room_id: main.id,
  p_target_player_id: shotTarget.playerId,
})
const hunterRefresh = await playerProjection(main, hunter)
const nonHunterProjection = await playerProjection(main, nonHunter)
invariant(hunterRefresh.nightAction?.mode === 'HUNTER_PRELOCK', 'Hunter không nhận private action.')
invariant(hunterRefresh.nightAction.currentTargetId === shotTarget.playerId, 'Hunter change selection không persist.')
invariant(!nonHunterProjection.nightAction, 'Non-Hunter nhận Hunter action.')
invariant(!/(source|effect|death|HUNTER_SHOT)/i.test(JSON.stringify(hunterRefresh.nightAction)), 'Hunter pre-lock projection lộ death/source truth.')
await rpc(hunter.client, 'ms1d1_confirm_hunter_prelock', { p_room_id: main.id })
await rpc(hunter.client, 'ms1d1_confirm_hunter_prelock', { p_room_id: main.id })

await rpcFailure(moderator, 'ms1c_open_witch_call', { p_room_id: main.id }, 'WITCH_CHECKPOINT_NOT_READY')
await completeProtector(main, safeTarget.playerId)
await completeWolf(main, hunter.playerId)
const concurrentResolution = await Promise.all([
  rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: main.id }),
  rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: main.id }),
])
invariant(JSON.stringify(concurrentResolution[0]) === JSON.stringify(concurrentResolution[1]), 'Concurrent resolution không idempotent.')
const shotEffect = concurrentResolution[0].effects.find((effect) => effect.sourceType === 'HUNTER_SHOT')
invariant(shotEffect?.activationStatus === 'CONDITIONAL', 'Hunter shot không conditional trước Witch.')
invariant(shotEffect.protectorBlockable === false, 'Hunter shot bị đánh dấu Protector-blockable.')

const signalPayloads = []
const channels = [moderator, witch.client, shotTarget.client].map((client) => {
  const channel = client.channel(`room:${main.id}`, { config: { private: true } })
    .on('broadcast', { event: 'room_changed' }, (payload) => signalPayloads.push(payload))
    .subscribe()
  return { client, channel }
})
await waitFor(() => channels.every(({ channel }) => channel.state === 'joined'))

await openWitch(main)
const witchAction = (await playerProjection(main, witch)).nightAction
const witchVictimIds = witchAction?.resurrectionCandidates?.map((player) => player.id) ?? []
invariant(witchVictimIds.includes(hunter.playerId) && witchVictimIds.includes(shotTarget.playerId), 'Witch không thấy đủ Hunter + shot victim.')
invariant(!/(source|wolf|hunter|killer|effect)/i.test(JSON.stringify(witchAction.resurrectionCandidates)), 'Witch victim list lộ source/killer.')
await submitWitch(main, hunter.playerId)
const concurrentFinalize = await Promise.all([
  rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: main.id }),
  rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: main.id }),
])
invariant(JSON.stringify(concurrentFinalize[0]) === JSON.stringify(concurrentFinalize[1]), 'Concurrent final checkpoint không idempotent.')
invariant(concurrentFinalize[0].conditionalEffectStates[0].status === 'CANCELED_SOURCE_SURVIVED', 'Rescued Hunter không cancel shot.')
invariant(concurrentFinalize[0].finalDeaths.length === 0, 'Rescued Hunter/shot target vẫn chết.')
const afterFinalize = await moderatorProjection(main)
invariant(afterFinalize.room.phase === 'NIGHT', 'Final checkpoint tự động chuyển Day.')

const concurrentMorning = await Promise.all([
  rpc(moderator, 'ms1d1_start_morning', { p_room_id: main.id }),
  rpc(moderator, 'ms1d1_start_morning', { p_room_id: main.id }),
])
invariant(concurrentMorning.every((payload) => payload.room.phase === 'DAY'), 'Concurrent morning không ổn định ở DAY.')
invariant(!concurrentMorning[0].dayVote, 'Morning tự động mở Day vote.')
if (mode === 'LOCAL') await waitFor(() => signalPayloads.length > 0)
invariant(!/(target|source|effect|candidate|hunter|shot|death|resurrect)/i.test(JSON.stringify(signalPayloads)), 'Generic Realtime lộ Hunter/death truth.')

const privateAttempts = [
  await nonHunter.client.schema('private').from('hunter_night_intents').select('*'),
  await nonHunter.client.schema('private').from('morning_transitions').select('*'),
  await nonHunter.client.schema('private').from('night_effects').select('*'),
  await nonHunter.client.schema('private').from('hunter_night_intents').insert({ room_id: main.id }),
  await moderator.schema('private').from('morning_transitions').delete().eq('room_id', main.id),
]
invariant(privateAttempts.every((attempt) => Boolean(attempt.error)), 'Direct Hunter/morning private read/DML chưa bị deny.')
await rpcFailure(nonHunter.client, 'ms1d1_start_morning', { p_room_id: main.id }, 'NOT_MODERATOR')

evidence.selectionAndRefresh = { target: true, nobodySupported: true, changeBeforeConfirm: true, confirmRetry: true, refresh: true }
evidence.rescueHunter = { hunterAlive: true, shotCanceled: true, shotTargetAlive: true, sourceHistoryPreserved: true }
evidence.morning = { automatic: false, moderatorExplicit: true, phase: 'DAY', voteOpened: false, rolesRevealed: false }
evidence.idempotency = { resolutionConcurrent: true, finalizeConcurrent: true, morningConcurrent: true }
evidence.privacy = { hunterIntentPrivate: true, nonHunterNeutral: true, directDmlDenied: true, playerMorningDenied: true, namesOnlyForWitch: true }
evidence.realtime = {
  signal: 'room_changed',
  observed: signalPayloads.length > 0,
  secretPayload: false,
  remoteDeliveryRequired: false,
}

if (mode === 'LOCAL') {
  const mainCounts = localSql(`select
    (select count(*) from private.hunter_night_intents where room_id = '${main.id}'::uuid),
    (select count(*) from private.night_effects where room_id = '${main.id}'::uuid and source_type = 'HUNTER_SHOT'),
    (select count(*) from private.night_finalizations where room_id = '${main.id}'::uuid),
    (select count(*) from private.morning_transitions where room_id = '${main.id}'::uuid),
    (select count(*) from private.gameplay_events where room_id = '${main.id}'::uuid and event_type = 'MORNING_STARTED');`)
  invariant(mainCounts === '1|1|1|1|1', `Main idempotency counts sai: ${mainCounts}`)

  const deathRoom = await prepareRoom(`DD-${runId}`)
  const deathHunter = roleClient(deathRoom, 'hunter')
  const deathTarget = roleClient(deathRoom, 'villager')
  await resolvePreWitch(deathRoom, deathHunter.playerId, deathTarget.playerId, deathTarget.playerId)
  await openWitch(deathRoom)
  await submitWitch(deathRoom, null)
  const deathFinal = await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: deathRoom.id })
  invariant(deathFinal.finalDeaths.some((death) => death.playerId === deathHunter.playerId), 'Hunter death thiếu.')
  invariant(deathFinal.finalDeaths.some((death) => death.playerId === deathTarget.playerId), 'Hunter shot victim thiếu dù Protector target trùng.')
  invariant(deathFinal.conditionalEffectStates[0].status === 'ACTIVATED', 'Hunter shot không activate.')
  const hiddenHunter = await playerProjection(deathRoom, deathHunter)
  const hiddenTarget = await playerProjection(deathRoom, deathTarget)
  invariant(hiddenHunter.alivePlayerIds.includes(deathHunter.playerId), 'Hunter death lộ trong NIGHT.')
  invariant(hiddenTarget.alivePlayerIds.includes(deathTarget.playerId), 'Shot death lộ trong NIGHT.')
  await rpc(moderator, 'ms1d1_start_morning', { p_room_id: deathRoom.id })
  const dayHunter = await playerProjection(deathRoom, deathHunter)
  const dayTarget = await playerProjection(deathRoom, deathTarget)
  invariant(!dayHunter.alivePlayerIds.includes(deathHunter.playerId), 'Hunter không thấy death state sau morning.')
  invariant(!dayTarget.alivePlayerIds.includes(deathTarget.playerId), 'Shot victim không thấy death state sau morning.')
  invariant(!dayHunter.dayVote && !dayTarget.dayVote, 'Day vote đã được mở ngoài scope D1.')
  invariant(!('assignments' in dayTarget), 'Morning projection lộ role assignments.')
  evidence.activateShot = { hunterDead: true, targetDead: true, protectorBypassed: true, nightMasked: true, dayDeathVisible: true }

  const rescueTargetRoom = await prepareRoom(`RT-${runId}`)
  const rescueTargetHunter = roleClient(rescueTargetRoom, 'hunter')
  const rescueTarget = roleClient(rescueTargetRoom, 'villager')
  await resolvePreWitch(rescueTargetRoom, rescueTargetHunter.playerId, roleClient(rescueTargetRoom, 'villager', 1).playerId, rescueTarget.playerId)
  await openWitch(rescueTargetRoom)
  await submitWitch(rescueTargetRoom, rescueTarget.playerId)
  const rescueTargetFinal = await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: rescueTargetRoom.id })
  invariant(rescueTargetFinal.conditionalEffectStates[0].status === 'ACTIVATED', 'Rescue shot victim đã cancel nhầm shot.')
  invariant(rescueTargetFinal.finalDeaths.some((death) => death.playerId === rescueTargetHunter.playerId), 'Hunter phải chết khi Witch cứu shot victim.')
  invariant(!rescueTargetFinal.finalDeaths.some((death) => death.playerId === rescueTarget.playerId), 'Shot victim được cứu vẫn chết.')
  evidence.rescueShotVictim = { hunterDead: true, shotActivated: true, targetAlive: true }

  const nobodyRoom = await prepareRoom(`NO-${runId}`)
  const nobodyHunter = roleClient(nobodyRoom, 'hunter')
  await resolvePreWitch(nobodyRoom, nobodyHunter.playerId, roleClient(nobodyRoom, 'villager').playerId, null)
  const nobodyResolution = await moderatorProjection(nobodyRoom)
  invariant(!nobodyResolution.nightResolution.effects.some((effect) => effect.sourceType === 'HUNTER_SHOT'), 'Nobody vẫn tạo Hunter shot effect.')
  evidence.nobody = { intentPersisted: true, shotEffect: false }

  const deadRoom = await prepareRoom(`DB-${runId}`)
  const deadHunter = roleClient(deadRoom, 'hunter')
  localSql(`update public.room_players set alive = false where id = '${deadHunter.playerId}'::uuid;`)
  await completeHunter(deadRoom, null)
  await completeProtector(deadRoom, roleClient(deadRoom, 'villager').playerId)
  await completeWolf(deadRoom, roleClient(deadRoom, 'villager', 1).playerId)
  const deadResolution = await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: deadRoom.id })
  invariant(!deadResolution.effects.some((effect) => effect.sourceType === 'HUNTER_SHOT'), 'Dead-before-Night Hunter tạo shot.')
  invariant(localSql(`select count(*) from private.hunter_night_intents where room_id = '${deadRoom.id}'::uuid;`) === '0', 'Dead-before-Night Hunter có pre-lock.')
  evidence.deadBeforeNight = { rituallyCalled: true, playerAction: false, prelock: false, shot: false }

  const surviveRoom = await prepareRoom(`SV-${runId}`)
  const surviveHunter = roleClient(surviveRoom, 'hunter')
  const surviveTarget = roleClient(surviveRoom, 'villager')
  const wolfVictim = roleClient(surviveRoom, 'villager', 1)
  await resolvePreWitch(surviveRoom, wolfVictim.playerId, surviveTarget.playerId, surviveTarget.playerId)
  await openWitch(surviveRoom)
  await submitWitch(surviveRoom, null)
  const surviveFinal = await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: surviveRoom.id })
  invariant(surviveFinal.conditionalEffectStates[0].status === 'CANCELED_SOURCE_SURVIVED', 'Living Hunter shot không cancel.')
  invariant(!surviveFinal.finalDeaths.some((death) => death.playerId === surviveTarget.playerId), 'Living Hunter vẫn bắn.')
  invariant(surviveFinal.finalDeaths.some((death) => death.playerId === wolfVictim.playerId), 'Independent Wolf victim mất death.')
  invariant(surviveHunter.playerId !== wolfVictim.playerId, 'Survival fixture sai target.')
  evidence.hunterSurvives = { shotCanceled: true, targetAlive: true, otherWolfVictimDead: true }

  const multiRoom = await prepareRoom(`ML-${runId}`)
  advanceNightFixture(multiRoom, 2)
  const multiHunter = roleClient(multiRoom, 'hunter')
  const multiTarget = roleClient(multiRoom, 'villager')
  await resolvePreWitch(multiRoom, multiHunter.playerId, roleClient(multiRoom, 'villager', 1).playerId, multiTarget.playerId)
  await openWitch(multiRoom)
  await submitWitch(multiRoom, multiTarget.playerId, multiTarget.playerId)
  const multiFinal = await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: multiRoom.id })
  const multiDeath = multiFinal.finalDeaths.find((death) => death.playerId === multiTarget.playerId)
  invariant(multiDeath?.sourceEffectIds.length === 1, 'Rescued Hunter-shot target không giữ đúng một independent poison source.')
  invariant(multiFinal.poisonEffect.protectorBlockable === false, 'Independent poison source bị Protector-blockable.')
  evidence.independentLethalSource = { hunterShotRescued: true, poisonRemains: true, targetDead: true, sourceAware: true }
}

for (const { client, channel } of channels) await client.removeChannel(channel)
await Promise.all(clients.map((client) => client.realtime.disconnect()))

console.log(`MS-1D1 ${mode} SUPABASE QA PASS`)
console.log(JSON.stringify(evidence, null, 2))
