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
  const url = values.API_URL
  const key = values.PUBLISHABLE_KEY ?? values.ANON_KEY
  invariant(url && key, 'Local Supabase is not ready.')
  return { url, key }
}

function remoteEnvironment() {
  const values = { ...process.env }
  if (fs.existsSync('.env.local')) {
    Object.assign(values, parseEnv(fs.readFileSync('.env.local', 'utf8')))
  }
  const url = values.VITE_SUPABASE_URL
  const key = values.VITE_SUPABASE_PUBLISHABLE_KEY
  invariant(url && key, 'Missing remote Supabase frontend environment.')
  return { url, key }
}

const mode = process.argv.includes('--remote') ? 'REMOTE' : 'LOCAL'
const environment = mode === 'REMOTE' ? remoteEnvironment() : localEnvironment()
const runId = `${mode.toLowerCase()}-${Date.now().toString(36)}`

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
  invariant(!result.error && result.data.user?.id, `Anonymous Auth failed: ${result.error?.message}`)
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
  invariant(
    result.error.message === expected,
    `${name}: expected ${expected}, got ${result.error.message}`,
  )
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for authoritative room refetch.')
}

const moderator = isolatedClient()
const players = Array.from({ length: 7 }, () => isolatedClient())
const clients = [moderator, ...players]
const identityIds = await Promise.all(clients.map(authenticate))
invariant(new Set(identityIds).size === 8, 'Expected eight isolated identities.')

const roleConfig = {
  werewolf: 2,
  protector: 1,
  seer: 1,
  villager: 3,
}

async function prepareRoom(policy, label) {
  const created = await rpc(moderator, 'ms1a_create_room', {
    p_request_id: randomUUID(),
    p_seat_count: 7,
    p_role_config: roleConfig,
    p_wolf_policy: policy,
  })

  await rpcFailure(players[6], 'ms1a_get_player_room', {
    p_room_id: created.room.id,
  }, 'UNAUTHORIZED')

  const joined = []
  for (let index = 0; index < players.length; index += 1) {
    joined.push(await rpc(players[index], 'ms1a_join_room', {
      p_code: created.room.code,
      p_display_name: `${index + 1}-${label}`.slice(0, 20),
    }))
  }
  const dealt = await rpc(moderator, 'ms1a_lock_and_assign_roles', {
    p_room_id: created.room.id,
  })
  await Promise.all(players.map((client) => rpc(client, 'ms1a_confirm_role_reveal', {
    p_room_id: created.room.id,
  })))
  await rpc(moderator, 'ms1g2_start_room', { p_room_id: created.room.id })

  const clientByPlayerId = new Map(
    joined.map((payload, index) => [payload.self.id, players[index]]),
  )
  const wolfIds = dealt.assignments
    .filter((assignment) => assignment.roleId === 'werewolf')
    .map((assignment) => assignment.playerId)
  invariant(wolfIds.length === 2, 'Expected exactly two Werewolves.')
  return {
    id: created.room.id,
    code: created.room.code,
    dealt,
    clientByPlayerId,
    wolfIds,
  }
}

async function playerProjection(room, playerId) {
  return rpc(room.clientByPlayerId.get(playerId), 'ms1a_get_player_room', {
    p_room_id: room.id,
  })
}

async function subscribePeer(room, playerId) {
  const client = room.clientByPlayerId.get(playerId)
  const payloads = []
  let projection = await playerProjection(room, playerId)
  let refreshError
  const channel = client
    .channel(`room:${room.id}`, { config: { private: true } })
    .on('broadcast', { event: 'room_changed' }, (message) => {
      payloads.push(message)
      void playerProjection(room, playerId)
        .then((value) => { projection = value })
        .catch((error) => { refreshError = error })
    })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Realtime subscribe timeout.')), 10_000)
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timeout)
        resolve()
      }
    })
  })
  return {
    payloads,
    get projection() { return projection },
    get refreshError() { return refreshError },
    channel,
  }
}

async function exerciseMandatoryAndLiveRoom(policy, label, finishInitial = true) {
  const room = await prepareRoom(policy, label)
  await rpc(moderator, 'ms1g2_open_night_role_call', {
    p_room_id: room.id,
    p_role_id: 'werewolf',
  })
  const [wolfAId, wolfBId] = room.wolfIds
  const wolfA = room.clientByPlayerId.get(wolfAId)
  const wolfB = room.clientByPlayerId.get(wolfBId)
  const target = room.dealt.players.find((player) => !room.wolfIds.includes(player.id))
  invariant(wolfA && wolfB && target, 'Missing focused Wolf actors/target.')

  const peer = await subscribePeer(room, wolfBId)
  await new Promise((resolve) => setTimeout(resolve, 250))

  await rpcFailure(wolfA, 'ms1g2_submit_wolf_ballot', {
    p_room_id: room.id,
    p_target_player_id: null,
  }, 'WOLF_TARGET_REQUIRED')
  await rpcFailure(wolfA, 'ms1g2_confirm_wolf_ballot', {
    p_room_id: room.id,
  }, 'WOLF_TARGET_REQUIRED')
  await rpcFailure(moderator, 'ms1g2_finalize_wolf_round', {
    p_room_id: room.id,
  }, 'WOLF_TARGET_REQUIRED')

  await rpc(wolfA, 'ms1g2_submit_wolf_ballot', {
    p_room_id: room.id,
    p_target_player_id: target.id,
  })
  await waitFor(() => peer.payloads.length > 0)
  invariant(
    (peer.projection.nightAction?.wolfTeammateBallots ?? []).length === 0,
    'An unconfirmed local selection leaked to a teammate.',
  )

  const payloadCountBeforeConfirm = peer.payloads.length
  await rpc(wolfA, 'ms1g2_confirm_wolf_ballot', { p_room_id: room.id })
  await waitFor(() => {
    const ballots = peer.projection.nightAction?.wolfTeammateBallots ?? []
    return peer.payloads.length > payloadCountBeforeConfirm &&
      ballots.some((ballot) => ballot.voter.id === wolfAId && ballot.targetId === target.id)
  })
  invariant(!peer.refreshError, `Realtime refetch failed: ${peer.refreshError?.message}`)

  const ordinaryId = room.dealt.assignments.find(
    (assignment) => assignment.roleId === 'villager',
  )?.playerId
  const ordinary = await playerProjection(room, ordinaryId)
  invariant(!ordinary.nightAction, 'Ordinary Player received Wolf action/peer data.')
  invariant(!JSON.stringify(ordinary).includes('wolfTeammateBallots'), 'Ordinary projection leaked peer ballot field.')

  const privateRead = await wolfB.schema('private').from('wolf_ballots').select('*')
  invariant(Boolean(privateRead.error), 'Player directly read private Wolf ballots.')
  await rpcFailure(wolfB, 'ms1b1_submit_wolf_ballot', {
    p_room_id: room.id,
    p_target_player_id: target.id,
  }, 'permission denied for function ms1b1_submit_wolf_ballot')

  if (finishInitial) {
    await rpc(moderator, 'ms1g2_finalize_wolf_round', {
      p_room_id: room.id,
    })
    const resolved = await rpc(moderator, 'ms1a_get_moderator_room', {
      p_room_id: room.id,
    })
    invariant(
      resolved.night.actionsByRole.werewolf.result.targetId === target.id,
      'One confirmed valid ballot did not resolve the authoritative target.',
    )
    invariant(
      resolved.night.actionsByRole.werewolf.result.random === false,
      'One confirmed valid ballot must be a unique non-random top.',
    )
  }

  const secrets = [wolfAId, target.id, 'wolfTeammateBallots', 'targetId', 'voter']
  const genericPayload = JSON.stringify(peer.payloads)
  for (const secret of secrets) {
    invariant(!genericPayload.includes(secret), `Generic Realtime leaked ${secret}.`)
  }
  await peer.channel.unsubscribe()
  return { room, target, wolfAId, wolfBId }
}

const primary = await exerciseMandatoryAndLiveRoom(
  'RANDOM_ON_TIE',
  `hf1-${runId}`,
  true,
)

let revote = 'REMOTE_NOT_REPEATED'
if (mode === 'LOCAL') {
  const room = await prepareRoom('REVOTE_10S', `hf1r-${runId}`)
  await rpc(moderator, 'ms1g2_open_night_role_call', {
    p_room_id: room.id,
    p_role_id: 'werewolf',
  })
  const [wolfAId, wolfBId] = room.wolfIds
  const wolfA = room.clientByPlayerId.get(wolfAId)
  const wolfB = room.clientByPlayerId.get(wolfBId)
  const targets = room.dealt.players.filter((player) => !room.wolfIds.includes(player.id)).slice(0, 2)
  for (const [client, target] of [[wolfA, targets[0]], [wolfB, targets[1]]]) {
    await rpc(client, 'ms1g2_submit_wolf_ballot', {
      p_room_id: room.id,
      p_target_player_id: target.id,
    })
    await rpc(client, 'ms1g2_confirm_wolf_ballot', { p_room_id: room.id })
  }
  await rpc(moderator, 'ms1g2_finalize_wolf_round', { p_room_id: room.id })
  const initial = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: room.id })
  invariant(initial.night.actionsByRole.werewolf.wolf.round === 'REVOTE', 'Tie did not open REVOTE_10S.')
  const fresh = await playerProjection(room, wolfBId)
  invariant((fresh.nightAction?.wolfTeammateBallots ?? []).length === 0, 'Initial-round marker survived into revote.')
  await rpc(wolfA, 'ms1g2_submit_wolf_ballot', {
    p_room_id: room.id,
    p_target_player_id: targets[0].id,
  })
  let beforeConfirm = await playerProjection(room, wolfBId)
  invariant((beforeConfirm.nightAction?.wolfTeammateBallots ?? []).length === 0, 'Unconfirmed revote marker leaked.')
  await rpc(wolfA, 'ms1g2_confirm_wolf_ballot', { p_room_id: room.id })
  const afterConfirm = await playerProjection(room, wolfBId)
  invariant(afterConfirm.nightAction.wolfTeammateBallots[0].targetId === targets[0].id, 'Confirmed revote marker missing.')
  await rpc(moderator, 'ms1g2_finalize_wolf_round', { p_room_id: room.id })
  const resolved = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: room.id })
  invariant(resolved.night.actionsByRole.werewolf.result.reason === 'REVOTE_UNIQUE_TOP', 'Partial revote unique top did not resolve early.')
  revote = 'PASS'
}

console.log(JSON.stringify({
  gate: 'MS-HF1',
  mode,
  roomsUsed: mode === 'REMOTE' ? 1 : 2,
  newAnonymousIdentities: 8,
  mandatoryTarget: 'PASS',
  oneValidMissingTeammate: 'PASS',
  confirmedOnlyLivePeerProjection: 'PASS',
  ordinaryPlayerDenied: 'PASS',
  unrelatedIdentityDeniedBeforeJoin: 'PASS',
  privateTableReadDenied: 'PASS',
  legacyBypassRpcDenied: 'PASS',
  genericRealtimeSecretFree: 'PASS',
  revoteRoundScoping: revote,
  roomCode: primary.room.code,
}, null, 2))

await Promise.all(clients.map((client) => client.removeAllChannels()))
