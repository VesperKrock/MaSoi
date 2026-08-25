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
  const adminKey = values.SECRET_KEY ?? values.SERVICE_ROLE_KEY
  invariant(url && key && adminKey, 'Local Supabase status thiếu runtime credentials.')
  return { url, key, adminKey }
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

function localSql(statement) {
  invariant(mode === 'LOCAL', 'Local SQL fixture chỉ được phép trong local QA.')
  execFileSync(
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
      '-c',
      statement,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

const mode = process.argv.includes('--remote') ? 'REMOTE' : 'LOCAL'
const environment = mode === 'LOCAL' ? localEnvironment() : remoteEnvironment()
const runId = `${mode.toLowerCase()}-${Date.now().toString(36)}`

function isolatedClient(key = environment.key) {
  return createClient(environment.url, key, {
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

const roleConfig = {
  villager: 3,
  werewolf: 1,
  traitor: 1,
  seer: 1,
  protector: 1,
}

async function prepareRoom(policy, label, onLobbyReady) {
  const created = await rpc(moderator, 'ms1a_create_room', {
    p_request_id: randomUUID(),
    p_seat_count: 7,
    p_role_config: roleConfig,
    p_wolf_policy: policy,
  })
  const joined = []
  for (let index = 0; index < players.length; index += 1) {
    joined.push(await rpc(players[index], 'ms1a_join_room', {
      p_code: created.room.code,
      p_display_name: `${label.slice(0, 16)}-${index + 1}`,
    }))
  }
  if (onLobbyReady) await onLobbyReady({ roomId: created.room.id, joined })
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
  const playerIdByRole = new Map(
    dealt.assignments.map((assignment) => [assignment.roleId, assignment.playerId]),
  )
  return {
    id: created.room.id,
    code: created.room.code,
    joined,
    dealt,
    clientByPlayerId,
    playerIdByRole,
  }
}

function roleClient(room, roleId) {
  const playerId = room.playerIdByRole.get(roleId)
  invariant(playerId, `Room thiếu role ${roleId}.`)
  const client = room.clientByPlayerId.get(playerId)
  invariant(client, `Không tìm thấy client cho role ${roleId}.`)
  return { playerId, client }
}

async function playerProjection(roomId, client) {
  return rpc(client, 'ms1a_get_player_room', { p_room_id: roomId })
}

async function moderatorProjection(roomId) {
  return rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: roomId })
}

async function submitAndConfirmWolf(client, roomId, targetId) {
  await rpc(client, 'ms1b1_submit_wolf_ballot', {
    p_room_id: roomId,
    p_target_player_id: targetId,
  })
  await rpc(client, 'ms1b1_confirm_wolf_ballot', { p_room_id: roomId })
}

const evidence = {
  mode,
  newAnonymousIdentities: 9,
  representativeDeck: roleConfig,
  manualPacing: false,
  realtime: null,
  wolfGroup: null,
  revote: null,
  seer: null,
  protector: null,
  privacy: null,
  noDeath: false,
  activeCallRefresh: false,
  deadRoleRitual: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  protectorConsecutive: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  randomOnTie: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
  revoteDeadline: mode === 'LOCAL' ? null : 'LOCAL_ONLY',
}

const gameplaySignals = new Map()
const gameplayChannels = []
const room = await prepareRoom(
  'REVOTE_10S',
  `B1-${runId}`,
  async ({ roomId }) => {
    for (const client of [moderator, ...players]) {
      const channel = client
        .channel(`room:${roomId}`, { config: { private: true } })
        .on('broadcast', { event: 'room_changed' }, (payload) => {
          gameplaySignals.set(client, payload)
        })
        .subscribe()
      gameplayChannels.push({ client, channel })
    }
    await waitFor(() => gameplayChannels.every(({ channel }) => channel.state === 'joined'))
  },
)
const wolf = roleClient(room, 'werewolf')
const traitor = roleClient(room, 'traitor')
const seer = roleClient(room, 'seer')
const protector = roleClient(room, 'protector')
const villager = roleClient(room, 'villager')

await rpcFailure(villager.client, 'ms1b1_open_night_role_call', {
  p_room_id: room.id,
  p_role_id: 'werewolf',
}, 'NOT_MODERATOR')
await rpcFailure(villager.client, 'ms1b1_submit_wolf_ballot', {
  p_room_id: room.id,
  p_target_player_id: seer.playerId,
}, 'CALL_NOT_ACTIVE')

gameplaySignals.clear()

await rpc(moderator, 'ms1b1_open_night_role_call', {
  p_room_id: room.id,
  p_role_id: 'werewolf',
})
await waitFor(() => gameplaySignals.has(moderator) && gameplaySignals.has(villager.client))
const realtimeText = JSON.stringify([
  gameplaySignals.get(moderator),
  gameplaySignals.get(villager.client),
])
invariant(
  !/(role_id|target_player|ballot|inspection|eligible_actor|seer|protector|traitor)/i.test(realtimeText),
  'Generic Realtime payload leaked gameplay truth.',
)
evidence.realtime = { signal: 'room_changed', secretPayload: false }

const wolfCallProjections = await Promise.all(players.map((client) => playerProjection(room.id, client)))
const activeActionPlayerIds = wolfCallProjections
  .filter((projection) => projection.nightAction)
  .map((projection) => projection.self.id)
  .sort()
invariant(
  JSON.stringify(activeActionPlayerIds) === JSON.stringify([wolf.playerId, traitor.playerId].sort()),
  'Wolf call không wake chính xác Werewolf + Traitor.',
)
const wolfProjection = wolfCallProjections.find((projection) => projection.self.id === wolf.playerId)
invariant(wolfProjection?.nightAction?.mode === 'WOLF_BALLOT', 'Werewolf thiếu ballot projection.')
const [targetA, targetB] = wolfProjection.nightAction.candidates
  .filter((target) => ![wolf.playerId, traitor.playerId].includes(target.id))
  .slice(0, 2)
invariant(targetA && targetB, 'Thiếu hai target cho Wolf tie QA.')
invariant(
  !wolfProjection.nightAction.candidates.some((target) =>
    [wolf.playerId, traitor.playerId].includes(target.id)),
  'Wolf-group member xuất hiện trong target pool.',
)

await rpcFailure(villager.client, 'ms1b1_submit_wolf_ballot', {
  p_room_id: room.id,
  p_target_player_id: targetA.id,
}, 'WRONG_ROLE')
await rpc(wolf.client, 'ms1b1_submit_wolf_ballot', {
  p_room_id: room.id,
  p_target_player_id: targetA.id,
})
await rpc(traitor.client, 'ms1b1_submit_wolf_ballot', {
  p_room_id: room.id,
  p_target_player_id: targetB.id,
})
const privateWolfProjection = await playerProjection(room.id, wolf.client)
invariant(privateWolfProjection.nightAction?.currentTargetId === targetA.id, 'Wolf own ballot sai.')
invariant(!('selections' in privateWolfProjection.nightAction), 'Player projection lộ raw ballots.')
await Promise.all([
  rpc(wolf.client, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id }),
  rpc(traitor.client, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id }),
])
invariant(!(await playerProjection(room.id, wolf.client)).nightAction, 'Confirmed Wolf không trở về neutral.')
await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: room.id })
const revoteModerator = await moderatorProjection(room.id)
const revoteAction = revoteModerator.night.actionsByRole.werewolf
invariant(revoteAction.wolf.round === 'REVOTE', 'Tie không mở REVOTE_10S.')
invariant(
  new Set(revoteAction.eligibleTargetIds).size === 2 &&
    revoteAction.eligibleTargetIds.includes(targetA.id) &&
    revoteAction.eligibleTargetIds.includes(targetB.id),
  'Revote candidate set không đúng initial top tie.',
)
const excludedTarget = wolfProjection.nightAction.candidates.find(
  (candidate) => ![targetA.id, targetB.id].includes(candidate.id),
)
invariant(excludedTarget, 'Thiếu excluded target cho hostile revote QA.')
await rpcFailure(wolf.client, 'ms1b1_submit_wolf_ballot', {
  p_room_id: room.id,
  p_target_player_id: excludedTarget.id,
}, 'INVALID_TARGET')
await rpc(wolf.client, 'ms1b1_submit_wolf_ballot', {
  p_room_id: room.id,
  p_target_player_id: targetA.id,
})
await rpc(wolf.client, 'ms1b1_submit_wolf_ballot', {
  p_room_id: room.id,
  p_target_player_id: targetB.id,
})
await rpc(traitor.client, 'ms1b1_submit_wolf_ballot', {
  p_room_id: room.id,
  p_target_player_id: null,
})
await Promise.all([
  rpc(wolf.client, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id }),
  rpc(traitor.client, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id }),
])
await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: room.id })
const wolfResolved = await moderatorProjection(room.id)
const wolfResult = wolfResolved.night.actionsByRole.werewolf.result
invariant(
  wolfResult.targetId === targetB.id && !wolfResult.random &&
    wolfResult.reason === 'REVOTE_UNIQUE_TOP',
  'Revote unique-top resolution sai.',
)
invariant(
  wolfResolved.alivePlayerIds.length === 7 &&
    wolfResolved.alivePlayerIds.includes(targetB.id),
  'B1 đã giết Wolf target.',
)
evidence.wolfGroup = { voters: 2, roles: ['werewolf', 'traitor'], targetPoolExcludesGroup: true }
evidence.revote = { candidateRestriction: true, voteChange: true, abstainNeutral: true, earlyUniqueTop: true }
evidence.noDeath = true

await rpc(moderator, 'ms1b1_open_night_role_call', {
  p_room_id: room.id,
  p_role_id: 'seer',
})
const seerProjection = await playerProjection(room.id, seer.client)
invariant(seerProjection.nightAction?.mode === 'SEER_SELECT', 'Seer không nhận private action.')
const seerSession = (await seer.client.auth.getSession()).data.session
invariant(seerSession?.access_token && seerSession.refresh_token, 'Thiếu Seer session cho refresh proof.')
const refreshedSeerClient = isolatedClient()
const restored = await refreshedSeerClient.auth.setSession({
  access_token: seerSession.access_token,
  refresh_token: seerSession.refresh_token,
})
invariant(!restored.error && restored.data.user?.id === userIds[1 + players.indexOf(seer.client)], 'Seer refresh đổi identity.')
const refreshedProjection = await playerProjection(room.id, refreshedSeerClient)
invariant(refreshedProjection.nightAction?.mode === 'SEER_SELECT', 'Refresh mất active Seer action.')
evidence.activeCallRefresh = true
await rpcFailure(traitor.client, 'ms1b1_submit_seer_inspection', {
  p_room_id: room.id,
  p_target_player_id: wolf.playerId,
}, 'WRONG_ROLE')
await rpc(seer.client, 'ms1b1_submit_seer_inspection', {
  p_room_id: room.id,
  p_target_player_id: traitor.playerId,
})
const seerResult = await playerProjection(room.id, seer.client)
invariant(
  seerResult.nightAction?.mode === 'SEER_RESULT' &&
    seerResult.nightAction.seerResult === 'NON_WOLF',
  'Seer không thấy Traitor là NON_WOLF.',
)
const wolfDuringSeer = await playerProjection(room.id, wolf.client)
invariant(!wolfDuringSeer.nightAction, 'Wolf đọc được Seer action/result.')
await rpcFailure(wolf.client, 'ms1b1_acknowledge_seer_result', {
  p_room_id: room.id,
}, 'WRONG_ROLE')
await rpc(seer.client, 'ms1b1_acknowledge_seer_result', { p_room_id: room.id })
invariant(!(await playerProjection(room.id, seer.client)).nightAction, 'Seer không trở về neutral sau acknowledge.')
evidence.seer = { private: true, traitor: 'NON_WOLF', refreshRestored: true }

await rpc(moderator, 'ms1b1_open_night_role_call', {
  p_room_id: room.id,
  p_role_id: 'protector',
})
const protectorProjection = await playerProjection(room.id, protector.client)
invariant(protectorProjection.nightAction?.mode === 'PROTECTOR_SELECT', 'Protector thiếu action.')
invariant(
  protectorProjection.nightAction.candidates.some((candidate) => candidate.id === protector.playerId),
  'Protector self-target bị loại.',
)
await rpc(protector.client, 'ms1b1_submit_protector_target', {
  p_room_id: room.id,
  p_target_player_id: protector.playerId,
})
invariant(!(await playerProjection(room.id, protector.client)).nightAction, 'Protector không trở về neutral.')
const afterProtector = await moderatorProjection(room.id)
const protectorAction = afterProtector.night.actionsByRole.protector
invariant(
  protectorAction.selections[protector.playerId] === protector.playerId,
  'Moderator không nhận Protector intent.',
)
invariant(afterProtector.alivePlayerIds.length === 7, 'Protector intent đã resolve effect ngoài scope.')
evidence.protector = { private: true, selfTarget: true, effectResolved: false }

const directDmlAttempts = [
  await villager.client.from('room_players').update({ alive: false }).eq('id', villager.playerId),
  await villager.client.schema('private').from('wolf_ballots').select('*'),
  await wolf.client.schema('private').from('seer_inspections').select('*'),
  await seer.client.schema('private').from('protector_intents').select('*'),
]
invariant(directDmlAttempts.every((attempt) => Boolean(attempt.error)), 'Direct gameplay DML/read không bị deny.')
await rpcFailure(unrelatedModerator, 'ms1a_get_player_room', { p_room_id: room.id }, 'UNAUTHORIZED')
await rpc(unrelatedModerator, 'ms1a_create_room', {
  p_request_id: randomUUID(),
  p_seat_count: 7,
  p_role_config: roleConfig,
  p_wolf_policy: 'RANDOM_ON_TIE',
})
await rpcFailure(unrelatedModerator, 'ms1b1_open_night_role_call', {
  p_room_id: room.id,
  p_role_id: 'werewolf',
}, 'NOT_MODERATOR')
const unrelatedRoomRows = await unrelatedModerator.from('rooms').select('id').eq('id', room.id)
invariant(!unrelatedRoomRows.error && unrelatedRoomRows.data.length === 0, 'Unrelated moderator đọc room khác.')
evidence.privacy = {
  directPrivateAccessDenied: true,
  otherWolfBallotAbsentFromPlayerProjection: true,
  crossRoleSecretsAbsent: true,
  unrelatedRoomRows: 0,
  moderatorOwnership: true,
}

if (mode === 'LOCAL') {
  const deadRoom = await prepareRoom('RANDOM_ON_TIE', `Dead-${runId}`)
  const deadWolf = roleClient(deadRoom, 'werewolf')
  const deadSeer = roleClient(deadRoom, 'seer')
  const deadProtector = roleClient(deadRoom, 'protector')
  localSql(
    `update public.room_players set alive = false where id in (` +
      [deadWolf.playerId, deadSeer.playerId, deadProtector.playerId]
        .map((playerId) => `'${playerId}'::uuid`)
        .join(', ') +
      ');',
  )
  for (const roleId of ['protector', 'seer', 'werewolf']) {
    const before = await moderatorProjection(deadRoom.id)
    invariant(
      before.night.calls.find((call) => call.roleId === roleId)?.status === 'NOT_CALLED',
      `Dead ${roleId} bị auto-skip.`,
    )
    await rpc(moderator, 'ms1b1_open_night_role_call', {
      p_room_id: deadRoom.id,
      p_role_id: roleId,
    })
    const projections = await Promise.all(players.map((client) => playerProjection(deadRoom.id, client)))
    invariant(projections.every((projection) => !projection.nightAction), `Dead ${roleId} woke a Player.`)
    await rpc(moderator, 'ms1b1_complete_empty_night_role_call', {
      p_room_id: deadRoom.id,
      p_role_id: roleId,
    })
  }
  const deadFinal = await moderatorProjection(deadRoom.id)
  invariant(deadFinal.night.calls.every((call) => call.status === 'COMPLETED'), 'Dead ritual calls chưa complete.')
  invariant(!deadFinal.night.actionsByRole.werewolf, 'Traitor acted without living actual Wolf.')
  evidence.deadRoleRitual = {
    callOrder: ['protector', 'seer', 'werewolf'],
    playerActions: 0,
    traitorWithoutLivingWolf: 'NO_ACTION',
    autoSkip: false,
  }
  evidence.manualPacing = true

  localSql(`update public.rooms set day_number = 2 where id = '${room.id}'::uuid;`)
  await rpc(moderator, 'ms1b1_open_night_role_call', {
    p_room_id: room.id,
    p_role_id: 'protector',
  })
  await rpcFailure(protector.client, 'ms1b1_submit_protector_target', {
    p_room_id: room.id,
    p_target_player_id: protector.playerId,
  }, 'SAME_PROTECTOR_TARGET')
  const nightTwoProjection = await playerProjection(room.id, protector.client)
  const differentTarget = nightTwoProjection.nightAction.candidates.find(
    (candidate) => candidate.id !== protector.playerId,
  )
  invariant(differentTarget, 'Night 2 thiếu target khác cho Protector.')
  await rpc(protector.client, 'ms1b1_submit_protector_target', {
    p_room_id: room.id,
    p_target_player_id: differentTarget.id,
  })
  localSql(`update public.rooms set day_number = 3 where id = '${room.id}'::uuid;`)
  await rpc(moderator, 'ms1b1_open_night_role_call', {
    p_room_id: room.id,
    p_role_id: 'protector',
  })
  const nightThreeProjection = await playerProjection(room.id, protector.client)
  invariant(
    nightThreeProjection.nightAction.candidates.some((candidate) => candidate.id === protector.playerId),
    'Night 3 original Protector target chưa eligible lại.',
  )
  evidence.protectorConsecutive = {
    night2SameTarget: 'BLOCKED',
    night2DifferentTarget: 'ALLOWED',
    night3OriginalTarget: 'ALLOWED',
  }

  const randomRoom = await prepareRoom('RANDOM_ON_TIE', `Random-${runId}`)
  const randomWolf = roleClient(randomRoom, 'werewolf')
  const randomTraitor = roleClient(randomRoom, 'traitor')
  await rpc(moderator, 'ms1b1_open_night_role_call', {
    p_room_id: randomRoom.id,
    p_role_id: 'werewolf',
  })
  const randomWolfProjection = await playerProjection(randomRoom.id, randomWolf.client)
  const [randomTargetA, randomTargetB] = randomWolfProjection.nightAction.candidates.slice(0, 2)
  await Promise.all([
    submitAndConfirmWolf(randomWolf.client, randomRoom.id, randomTargetA.id),
    submitAndConfirmWolf(randomTraitor.client, randomRoom.id, randomTargetB.id),
  ])
  await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: randomRoom.id })
  const randomResult = (await moderatorProjection(randomRoom.id)).night.actionsByRole.werewolf.result
  invariant(
    randomResult.random && randomResult.reason === 'TIED_TOP_RANDOM' &&
      [randomTargetA.id, randomTargetB.id].includes(randomResult.targetId),
    'RANDOM_ON_TIE random pool không đúng tied leaders.',
  )

  const abstainRoom = await prepareRoom('RANDOM_ON_TIE', `Abstain-${runId}`)
  const abstainWolf = roleClient(abstainRoom, 'werewolf')
  const abstainTraitor = roleClient(abstainRoom, 'traitor')
  await rpc(moderator, 'ms1b1_open_night_role_call', {
    p_room_id: abstainRoom.id,
    p_role_id: 'werewolf',
  })
  const abstainProjection = await playerProjection(abstainRoom.id, abstainWolf.client)
  const eligibleIds = abstainProjection.nightAction.candidates.map((candidate) => candidate.id)
  await Promise.all([
    submitAndConfirmWolf(abstainWolf.client, abstainRoom.id, null),
    submitAndConfirmWolf(abstainTraitor.client, abstainRoom.id, null),
  ])
  await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: abstainRoom.id })
  const abstainResult = (await moderatorProjection(abstainRoom.id)).night.actionsByRole.werewolf.result
  invariant(
    abstainResult.random && abstainResult.reason === 'ALL_ABSTAIN_RANDOM' &&
      eligibleIds.includes(abstainResult.targetId),
    'All-abstain không random từ toàn bộ eligible targets.',
  )
  evidence.randomOnTie = {
    positiveTiePoolExact: true,
    allAbstainEligiblePool: true,
  }

  const deadlineRoom = await prepareRoom('REVOTE_10S', `Deadline-${runId}`)
  const deadlineWolf = roleClient(deadlineRoom, 'werewolf')
  const deadlineTraitor = roleClient(deadlineRoom, 'traitor')
  await rpc(moderator, 'ms1b1_open_night_role_call', {
    p_room_id: deadlineRoom.id,
    p_role_id: 'werewolf',
  })
  const deadlineProjection = await playerProjection(deadlineRoom.id, deadlineWolf.client)
  const [deadlineTargetA, deadlineTargetB] = deadlineProjection.nightAction.candidates.slice(0, 2)
  await Promise.all([
    submitAndConfirmWolf(deadlineWolf.client, deadlineRoom.id, deadlineTargetA.id),
    submitAndConfirmWolf(deadlineTraitor.client, deadlineRoom.id, deadlineTargetB.id),
  ])
  await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: deadlineRoom.id })
  await Promise.all([
    submitAndConfirmWolf(deadlineWolf.client, deadlineRoom.id, null),
    submitAndConfirmWolf(deadlineTraitor.client, deadlineRoom.id, null),
  ])
  await rpcFailure(moderator, 'ms1b1_finalize_wolf_round', {
    p_room_id: deadlineRoom.id,
  }, 'REVOTE_NOT_READY')
  await new Promise((resolve) => setTimeout(resolve, 10_100))
  await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: deadlineRoom.id })
  const deadlineResult = (await moderatorProjection(deadlineRoom.id)).night.actionsByRole.werewolf.result
  invariant(
    deadlineResult.random &&
      deadlineResult.reason === 'REVOTE_ALL_ABSTAIN_RANDOM' &&
      [deadlineTargetA.id, deadlineTargetB.id].includes(deadlineResult.targetId),
    'Revote deadline all-abstain không random từ initial tied set.',
  )
  evidence.revoteDeadline = {
    serverEarlyFinalize: 'BLOCKED',
    waitedMilliseconds: 10_100,
    allAbstainPool: 'INITIAL_TIED_TARGETS',
  }
} else {
  evidence.manualPacing = true
}

for (const { client, channel } of gameplayChannels) {
  await client.removeChannel(channel)
}
refreshedSeerClient.realtime.disconnect()
for (const client of clients) client.realtime.disconnect()

console.log(`MS-1B1 ${mode} SUPABASE QA PASS`)
console.log(JSON.stringify(evidence, null, 2))
