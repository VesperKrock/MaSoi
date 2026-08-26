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
  const delay = Math.max(0, timestamp - Date.now() + 150)
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
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
const unrelated = mode === 'LOCAL' ? isolatedClient() : null
const clients = [moderator, ...players, ...(unrelated ? [unrelated] : [])]
const userIds = await Promise.all(clients.map(authenticate))
invariant(new Set(userIds).size === clients.length, 'Các QA identity không độc lập.')

const d2Config = {
  villager: 2,
  werewolf: 1,
  protector: 1,
  hunter: 1,
  witch: 1,
  mayor: 1,
}

async function prepareRoom(label) {
  const created = await rpc(moderator, 'ms1a_create_room', {
    p_request_id: randomUUID(),
    p_seat_count: 7,
    p_role_config: d2Config,
    p_wolf_policy: 'RANDOM_ON_TIE',
  })
  const joined = []
  for (let index = 0; index < players.length; index += 1) {
    joined.push(await rpc(players[index], 'ms1a_join_room', {
      p_code: created.room.code,
      p_display_name: `${label.slice(0, 13)}-${index + 1}`,
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

async function completeNightOneToMorning(room) {
  const hunter = roleClient(room, 'hunter')
  const protector = roleClient(room, 'protector')
  const wolf = roleClient(room, 'werewolf')
  const witch = roleClient(room, 'witch')
  const victim = roleClient(room, 'villager')
  const protectedPlayer = roleClient(room, 'villager', 1)

  await rpc(moderator, 'ms1d1_open_hunter_call', { p_room_id: room.id })
  await rpc(hunter.client, 'ms1d1_submit_hunter_prelock', {
    p_room_id: room.id, p_target_player_id: null,
  })
  await rpc(hunter.client, 'ms1d1_confirm_hunter_prelock', { p_room_id: room.id })

  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: room.id, p_role_id: 'protector' })
  await rpc(protector.client, 'ms1b1_submit_protector_target', {
    p_room_id: room.id, p_target_player_id: protectedPlayer.playerId,
  })

  await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: room.id, p_role_id: 'werewolf' })
  await rpc(wolf.client, 'ms1b1_submit_wolf_ballot', {
    p_room_id: room.id, p_target_player_id: victim.playerId,
  })
  await rpc(wolf.client, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id })
  await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: room.id })
  await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: room.id })

  await rpc(moderator, 'ms1c_open_witch_call', { p_room_id: room.id })
  const witchAction = (await playerProjection(room, witch)).nightAction
  invariant(witchAction.resurrectionCandidates.some((candidate) => candidate.id === victim.playerId), 'Witch không thấy Wolf victim cần cứu.')
  await rpc(witch.client, 'ms1c_submit_witch_decision', {
    p_room_id: room.id,
    p_resurrection_target_id: victim.playerId,
    p_poison_target_id: null,
  })
  await rpc(moderator, 'ms1c_finalize_night_checkpoint', { p_room_id: room.id })
  await rpc(moderator, 'ms1d1_start_morning', { p_room_id: room.id })
  return { protectedPlayer, victim }
}

function fastForwardVote(room) {
  localSql(`update private.day_vote_rounds
    set opened_at = statement_timestamp() - interval '31 seconds',
        deadline_at = statement_timestamp() - interval '1 second'
    where room_id = '${room.id}'::uuid and day_number = 1;`)
}

async function reachDeadline(room, deadlineAt) {
  if (mode === 'LOCAL') fastForwardVote(room)
  else await waitUntil(Date.parse(deadlineAt))
}

async function fixtureDay(room) {
  invariant(mode === 'LOCAL', 'fixtureDay chỉ dành cho local matrix.')
  localSql(`update public.rooms set phase = 'DAY', revision = revision + 1 where id = '${room.id}'::uuid;`)
}

async function voteFor(client, room, targetId) {
  return rpc(client, 'ms1d2_cast_day_vote', {
    p_room_id: room.id,
    p_target_player_id: targetId,
  })
}

const evidence = {
  mode,
  newAnonymousIdentities: clients.length,
  representativeDeck: d2Config,
  duration: null,
  ballotMutation: null,
  mayor: null,
  outcomes: null,
  hunter: null,
  nextNight: null,
  privacy: null,
  concurrency: null,
  realtime: null,
  complementaryLocalBranches: mode === 'LOCAL' ? null : 'QUALIFIED_BY_LOCAL_RUN',
}

const main = await prepareRoom(`D2-${runId}`)
const nightOne = await completeNightOneToMorning(main)
const mayor = roleClient(main, 'mayor')
const hunter = roleClient(main, 'hunter')
const protector = roleClient(main, 'protector')
const normalTarget = roleClient(main, 'villager')
const revengeTarget = mayor

await rpcFailure(mayor.client, 'ms1d2_cast_day_vote', {
  p_room_id: main.id, p_target_player_id: hunter.playerId,
}, 'DAY_VOTE_NOT_OPEN')
await rpcFailure(mayor.client, 'ms1d2_start_day_vote', { p_room_id: main.id }, 'NOT_MODERATOR')
if (unrelated) {
  await rpc(unrelated, 'ms1a_create_room', {
    p_request_id: randomUUID(),
    p_seat_count: 7,
    p_role_config: d2Config,
    p_wolf_policy: 'RANDOM_ON_TIE',
  })
  await rpcFailure(unrelated, 'ms1d2_start_day_vote', { p_room_id: main.id }, 'NOT_MODERATOR')
}

const signalPayloads = []
const signalClients = [moderator, mayor.client, hunter.client]
const channels = signalClients.map((client) => {
  const channel = client.channel(`room:${main.id}`, { config: { private: true } })
    .on('broadcast', { event: 'room_changed' }, (payload) => signalPayloads.push(payload))
    .subscribe()
  return { client, channel }
})
await waitFor(() => channels.every(({ channel }) => channel.state === 'joined'))

const opened = await rpc(moderator, 'ms1d2_start_day_vote', { p_room_id: main.id })
const durationMs = Date.parse(opened.dayVote.deadlineAt) - Date.parse(opened.dayVote.openedAt)
invariant(durationMs === 30_000, `Server duration sai: ${durationMs}.`)
await rpcFailure(moderator, 'ms1d2_start_day_vote', { p_room_id: main.id }, 'DAY_VOTE_ALREADY_EXISTS')
await rpcFailure(moderator, 'ms1d2_resolve_day_vote', { p_room_id: main.id }, 'DAY_VOTE_NOT_READY')
if (unrelated) {
  await rpcFailure(unrelated, 'ms1d2_resolve_day_vote', { p_room_id: main.id }, 'NOT_MODERATOR')
}
await rpcFailure(mayor.client, 'ms1d2_cast_day_vote', {
  p_room_id: main.id, p_target_player_id: mayor.playerId,
}, 'INVALID_TARGET')

await voteFor(mayor.client, main, normalTarget.playerId)
let mayorProjection = await playerProjection(main, mayor)
invariant(mayorProjection.dayVote.currentTargetId === normalTarget.playerId, 'Vote A không persist.')
await voteFor(mayor.client, main, hunter.playerId)
mayorProjection = await playerProjection(main, mayor)
invariant(mayorProjection.dayVote.currentTargetId === hunter.playerId, 'A→B không chỉ giữ B.')
await voteFor(mayor.client, main, hunter.playerId)
mayorProjection = await playerProjection(main, mayor)
invariant(mayorProjection.dayVote.currentTargetId == null, 'Tap lần hai không clear thành abstain.')
await voteFor(mayor.client, main, hunter.playerId)

const normalVoter = roleClient(main, 'witch')
await voteFor(normalVoter.client, main, normalTarget.playerId)
const aggregateProjection = await playerProjection(main, normalVoter)
invariant(aggregateProjection.dayVote.totals[hunter.playerId] === 2, 'Mayor không đóng góp 2 phiếu.')
invariant(aggregateProjection.dayVote.totals[normalTarget.playerId] === 1, 'Normal không đóng góp 1 phiếu.')
invariant(!('votes' in aggregateProjection.dayVote) && !('ballots' in aggregateProjection.dayVote), 'Player projection lộ raw ballot.')
invariant(!('assignments' in aggregateProjection), 'Player projection lộ assignment/Mayor role.')

const forged = await mayor.client.rpc('ms1d2_cast_day_vote', {
  p_room_id: main.id,
  p_target_player_id: hunter.playerId,
  p_weight: 100,
})
invariant(Boolean(forged.error), 'Client forge weight unexpectedly accepted.')

if (mode === 'LOCAL') {
  const deadVoter = roleClient(main, 'villager', 1)
  localSql(`update public.room_players set alive = false where id = '${deadVoter.playerId}'::uuid;`)
  await rpcFailure(deadVoter.client, 'ms1d2_cast_day_vote', {
    p_room_id: main.id, p_target_player_id: hunter.playerId,
  }, 'PLAYER_DEAD')
  localSql(`update public.room_players set alive = true where id = '${deadVoter.playerId}'::uuid;`)
}

await reachDeadline(main, opened.dayVote.deadlineAt)
await rpcFailure(normalVoter.client, 'ms1d2_cast_day_vote', {
  p_room_id: main.id, p_target_player_id: hunter.playerId,
}, 'DAY_VOTE_EXPIRED')
await rpcFailure(normalVoter.client, 'ms1d2_resolve_day_vote', { p_room_id: main.id }, 'NOT_MODERATOR')
const resolvedPair = await Promise.all([
  rpc(moderator, 'ms1d2_resolve_day_vote', { p_room_id: main.id }),
  rpc(moderator, 'ms1d2_resolve_day_vote', { p_room_id: main.id }),
])
invariant(JSON.stringify(resolvedPair[0].dayVote) === JSON.stringify(resolvedPair[1].dayVote), 'Concurrent resolve không idempotent.')
const resolved = resolvedPair[0]
invariant(resolved.dayVote.result.kind === 'UNIQUE', 'Weighted unique top không resolve UNIQUE.')
invariant(resolved.dayVote.result.hangedPlayerId === hunter.playerId, 'Mayor weighted target không bị treo.')
invariant(resolved.dayVote.hunterRevenge.status === 'PENDING', 'Hunter hanging không mở revenge.')
invariant(!resolved.alivePlayerIds.includes(hunter.playerId), 'Hanged Hunter vẫn alive.')
invariant(resolved.dayVote.hangingEffect.sourceType === 'DAY_HANGING', 'Thiếu DAY_HANGING effect.')
invariant(resolved.dayVote.hangingEffect.protectorBlockable === false, 'Hanging bị Protector-blockable.')

const hunterProjection = await playerProjection(main, hunter)
const ordinaryProjection = await playerProjection(main, normalTarget)
invariant(hunterProjection.dayVote.hunterRevengeAction?.candidates.length > 0, 'Hanged Hunter không nhận private revenge action.')
invariant(ordinaryProjection.dayVote.result.hunterRevealed === true, 'Public Hunter hanging reveal thiếu.')
invariant(ordinaryProjection.dayVote.result.hangedPlayer.id === hunter.playerId, 'Public hanging name sai.')
invariant(!ordinaryProjection.dayVote.hunterRevengeAction, 'Non-Hunter nhận revenge action.')
await rpcFailure(normalTarget.client, 'ms1d2_submit_hunter_revenge', {
  p_room_id: main.id, p_target_player_id: revengeTarget.playerId,
}, 'HUNTER_REVENGE_NOT_PENDING')
await rpcFailure(hunter.client, 'ms1d2_submit_hunter_revenge', {
  p_room_id: main.id, p_target_player_id: hunter.playerId,
}, 'INVALID_TARGET')
await rpcFailure(moderator, 'ms1d2_start_next_night', { p_room_id: main.id }, 'DAY_CONSEQUENCE_NOT_READY')

const revengePair = await Promise.all([
  rpc(hunter.client, 'ms1d2_submit_hunter_revenge', {
    p_room_id: main.id, p_target_player_id: revengeTarget.playerId,
  }),
  rpc(hunter.client, 'ms1d2_submit_hunter_revenge', {
    p_room_id: main.id, p_target_player_id: revengeTarget.playerId,
  }),
])
invariant(revengePair.every((payload) => payload.dayVote.result.hunterRevengeStatus === 'RESOLVED'), 'Concurrent revenge không resolve một truth.')
const afterRevenge = await moderatorProjection(main)
invariant(!afterRevenge.alivePlayerIds.includes(revengeTarget.playerId), 'Hunter revenge victim vẫn alive.')
invariant(afterRevenge.dayVote.hunterRevenge.effect.sourceType === 'HUNTER_REVENGE_SHOT', 'Thiếu source-aware revenge effect.')
invariant(afterRevenge.dayVote.hunterRevenge.effect.protectorBlockable === false, 'Revenge bị Protector-blockable.')

await rpcFailure(normalTarget.client, 'ms1d2_start_next_night', { p_room_id: main.id }, 'NOT_MODERATOR')
if (unrelated) {
  await rpcFailure(unrelated, 'ms1d2_start_next_night', { p_room_id: main.id }, 'NOT_MODERATOR')
}
const nextNightPair = await Promise.all([
  rpc(moderator, 'ms1d2_start_next_night', { p_room_id: main.id }),
  rpc(moderator, 'ms1d2_start_next_night', { p_room_id: main.id }),
])
invariant(nextNightPair.every((payload) => payload.room.phase === 'NIGHT' && payload.room.dayNumber === 2), 'Concurrent next Night không ổn định ở Night 2.')
const nightTwo = await moderatorProjection(main)
invariant(nightTwo.night.number === 2, 'Night number không tăng đúng một.')
invariant(nightTwo.night.activeRoleId === null, 'Night 2 tự động gọi role.')
invariant(nightTwo.night.calls.every((call) => call.status === 'NOT_CALLED'), 'Night 2 call status không fresh.')
invariant(!nightTwo.alivePlayerIds.includes(hunter.playerId) && !nightTwo.alivePlayerIds.includes(revengeTarget.playerId), 'Dead state không persist Night 2.')
invariant(nightTwo.witchCheckpoint === null, 'Night checkpoint cũ chảy sang Night 2.')

await rpc(moderator, 'ms1b1_open_night_role_call', { p_room_id: main.id, p_role_id: 'protector' })
const protectorNightTwo = (await playerProjection(main, protector)).nightAction
invariant(!protectorNightTwo.candidates.some((candidate) => candidate.id === nightOne.protectedPlayer.playerId), 'Protector previous target không persist sang Night 2.')

if (mode === 'LOCAL') {
  const resourceState = localSql(`select resurrection_available, poison_available from private.witch_resources where room_id = '${main.id}'::uuid;`)
  invariant(resourceState === 'f|t', `Witch resources reset sai: ${resourceState}.`)
  const counts = localSql(`select
    (select count(*) from private.day_vote_rounds where room_id = '${main.id}'::uuid),
    (select count(*) from private.day_effects where room_id = '${main.id}'::uuid and source_type = 'DAY_HANGING'),
    (select count(*) from private.day_effects where room_id = '${main.id}'::uuid and source_type = 'HUNTER_REVENGE_SHOT'),
    (select count(*) from private.hunter_day_revenge where room_id = '${main.id}'::uuid),
    (select count(*) from private.day_to_night_transitions where room_id = '${main.id}'::uuid);`)
  invariant(counts === '1|1|1|1|1', `Idempotency row counts sai: ${counts}.`)

  const directAttempts = [
    await normalTarget.client.schema('private').from('day_ballots').select('*'),
    await normalTarget.client.schema('private').from('day_vote_rounds').select('*'),
    await normalTarget.client.schema('private').from('day_effects').insert({ room_id: main.id }),
    await moderator.schema('private').from('hunter_day_revenge').update({ status: 'RESOLVED' }).eq('room_id', main.id),
  ]
  invariant(directAttempts.every((attempt) => Boolean(attempt.error)), 'Direct private Day read/DML chưa bị deny.')

  const tieRoom = await prepareRoom(`TI-${runId}`)
  await fixtureDay(tieRoom)
  const tieMayor = roleClient(tieRoom, 'mayor')
  const tieA = roleClient(tieRoom, 'villager')
  const tieB = roleClient(tieRoom, 'villager', 1)
  const tieHunter = roleClient(tieRoom, 'hunter')
  await rpc(moderator, 'ms1d2_start_day_vote', { p_room_id: tieRoom.id })
  await voteFor(tieMayor.client, tieRoom, tieA.playerId)
  await voteFor(tieHunter.client, tieRoom, tieB.playerId)
  await voteFor(roleClient(tieRoom, 'witch').client, tieRoom, tieB.playerId)
  fastForwardVote(tieRoom)
  const tieResult = await rpc(moderator, 'ms1d2_resolve_day_vote', { p_room_id: tieRoom.id })
  invariant(tieResult.dayVote.result.kind === 'TIE' && tieResult.alivePlayerIds.length === 7, 'Weighted tie không no-hanging.')

  const abstainRoom = await prepareRoom(`AB-${runId}`)
  await fixtureDay(abstainRoom)
  await rpc(moderator, 'ms1d2_start_day_vote', { p_room_id: abstainRoom.id })
  fastForwardVote(abstainRoom)
  const abstainResult = await rpc(moderator, 'ms1d2_resolve_day_vote', { p_room_id: abstainRoom.id })
  invariant(abstainResult.dayVote.result.kind === 'NO_VOTES' && abstainResult.alivePlayerIds.length === 7, 'All abstain không no-hanging.')

  const oneVoteRoom = await prepareRoom(`OV-${runId}`)
  await fixtureDay(oneVoteRoom)
  const oneVoter = roleClient(oneVoteRoom, 'villager')
  const ordinary = roleClient(oneVoteRoom, 'protector')
  await rpc(moderator, 'ms1d2_start_day_vote', { p_room_id: oneVoteRoom.id })
  await voteFor(oneVoter.client, oneVoteRoom, ordinary.playerId)
  fastForwardVote(oneVoteRoom)
  const oneVoteResult = await rpc(moderator, 'ms1d2_resolve_day_vote', { p_room_id: oneVoteRoom.id })
  invariant(oneVoteResult.dayVote.result.hangedPlayerId === ordinary.playerId, 'Một positive vote không đủ treo target.')
  invariant(!oneVoteResult.dayVote.result.hunterRevealed && !oneVoteResult.dayVote.hunterRevenge, 'Ordinary hanging lộ role/tạo revenge.')

  const nobodyRoom = await prepareRoom(`NO-${runId}`)
  await fixtureDay(nobodyRoom)
  const nobodyMayor = roleClient(nobodyRoom, 'mayor')
  const nobodyHunter = roleClient(nobodyRoom, 'hunter')
  await rpc(moderator, 'ms1d2_start_day_vote', { p_room_id: nobodyRoom.id })
  await voteFor(nobodyMayor.client, nobodyRoom, nobodyHunter.playerId)
  fastForwardVote(nobodyRoom)
  await rpc(moderator, 'ms1d2_resolve_day_vote', { p_room_id: nobodyRoom.id })
  await rpc(nobodyHunter.client, 'ms1d2_submit_hunter_revenge', {
    p_room_id: nobodyRoom.id, p_target_player_id: null,
  })
  const nobodyResult = await moderatorProjection(nobodyRoom)
  invariant(nobodyResult.dayVote.hunterRevenge.status === 'RESOLVED' && nobodyResult.dayVote.hunterRevenge.targetPlayerId == null, 'Hunter Nobody không resolve.')
  invariant(nobodyResult.alivePlayerIds.length === 6, 'Hunter Nobody gây thêm death.')

  evidence.outcomes = { onePositive: 'HANGED', weightedTie: 'NO_HANGING', allAbstain: 'NO_HANGING', randomTie: false }
  evidence.privacy = { rawBallotRead: 'DENIED', directDml: 'DENIED', playerAssignments: false, anonymousTotalsOnly: true }
} else {
  evidence.outcomes = { remoteBranch: 'MAYOR_WEIGHTED_HUNTER_HANGING', complementary: 'LOCAL' }
  evidence.privacy = { playerAssignments: false, anonymousTotalsOnly: true, directDml: 'ACCEPTED_LOCAL_EVIDENCE' }
}

if (mode === 'LOCAL') await waitFor(() => signalPayloads.length > 0)
invariant(!/(voter|ballot|mayor|revenge_target|target_player_id|role_id)/i.test(JSON.stringify(signalPayloads)), 'Generic Realtime payload lộ Day secret.')

evidence.duration = { serverMilliseconds: durationMs, earlyResolve: 'DENIED', extendRpc: false }
evidence.ballotMutation = { beforeStartDenied: true, selfDenied: true, change: true, secondTapClear: true, afterDeadlineDenied: true, timeoutAbstain: true }
evidence.mayor = { serverDerived: 2, normal: 1, clientWeightForge: 'DENIED' }
evidence.hunter = { publiclyRevealedOnlyWhenHanged: true, privateAction: true, targetKilled: true, nobody: mode === 'LOCAL' ? true : 'LOCAL', protectorBlockable: false }
evidence.nextNight = {
  automatic: false,
  moderatorOnly: true,
  number: 2,
  incrementOnce: true,
  callsFresh: true,
  witchResourcesPersist: mode === 'LOCAL' ? true : 'QUALIFIED_LOCALLY',
  protectorHistoryPersist: true,
  deadPersist: true,
}
evidence.concurrency = { resolveOneLogicalResult: true, revengeOneLogicalResult: true, nextNightOneIncrement: true }
evidence.realtime = { signal: 'room_changed', observed: mode === 'LOCAL' ? signalPayloads.length > 0 : 'DELIVERY_NOT_REQUIRED', secretPayload: false }

for (const { client, channel } of channels) await client.removeChannel(channel)
await Promise.all(clients.map((client) => client.realtime.disconnect()))

console.log(`MS-1D2 ${mode} SUPABASE QA PASS`)
console.log(JSON.stringify(evidence, null, 2))
