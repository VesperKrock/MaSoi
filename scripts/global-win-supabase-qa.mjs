import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

invariant(
  process.argv.includes('--local') && !process.argv.includes('--remote'),
  'MS-1G2 QA is intentionally local-only.',
)

function parseEnv(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

const statusCommand = process.platform === 'win32'
  ? [process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', 'npx supabase status -o env']]
  : ['npx', ['supabase', 'status', '-o', 'env']]
const local = parseEnv(execFileSync(statusCommand[0], statusCommand[1], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}))
const url = local.API_URL
const key = local.PUBLISHABLE_KEY ?? local.ANON_KEY
invariant(url && key, 'Local Supabase is not ready.')

function localSql(statement) {
  return execFileSync('docker', [
    'exec', 'supabase_db_masoi', 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', statement,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function sqlUuid(value) {
  invariant(/^[0-9a-f-]{36}$/i.test(value), `Unsafe UUID fixture: ${value}`)
  return `'${value}'::uuid`
}

function isolatedClient() {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

async function authenticate(client) {
  const result = await client.auth.signInAnonymously()
  invariant(!result.error && result.data.user?.id, `Anonymous Auth failed: ${result.error?.message}`)
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
  if (expected) invariant(result.error.message === expected, `${name}: expected ${expected}, got ${result.error.message}`)
  return result.error
}

const moderator = isolatedClient()
const playerClients = Array.from({ length: 7 }, () => isolatedClient())
const outsider = isolatedClient()
const clients = [moderator, ...playerClients, outsider]
const identities = await Promise.all(clients.map(authenticate))
invariant(new Set(identities).size === 9, 'Local identities are not isolated.')

const standardConfig = {
  werewolf: 1,
  'serial-killer': 1,
  fool: 1,
  cupid: 1,
  traitor: 1,
  villager: 2,
}
let roomSequence = 0

async function createStartedRoom(roleConfig = standardConfig) {
  roomSequence += 1
  const created = await rpc(moderator, 'ms1a_create_room', {
    p_request_id: randomUUID(), p_seat_count: 7,
    p_role_config: roleConfig, p_wolf_policy: 'RANDOM_ON_TIE',
  })
  const joined = []
  for (let index = 0; index < playerClients.length; index += 1) {
    joined.push(await rpc(playerClients[index], 'ms1a_join_room', {
      p_code: created.room.code,
      p_display_name: `G2-${roomSequence}-${index + 1}`,
    }))
  }
  await rpc(moderator, 'ms1a_lock_and_assign_roles', { p_room_id: created.room.id })
  await Promise.all(playerClients.map((client) =>
    rpc(client, 'ms1a_confirm_role_reveal', { p_room_id: created.room.id })))
  await rpc(moderator, 'ms1g2_start_room', { p_room_id: created.room.id })
  const snapshot = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: created.room.id })
  invariant(snapshot.room.status === 'IN_GAME', 'Base fixture unexpectedly finished at Night start.')
  return {
    id: created.room.id,
    snapshot,
    actors: Object.fromEntries(snapshot.assignments.map((assignment) => {
      const playerIndex = snapshot.players.findIndex((player) => player.id === assignment.playerId)
      return [assignment.roleId, {
        id: assignment.playerId,
        client: playerClients[playerIndex],
      }]
    })),
    clientByPlayerId: Object.fromEntries(snapshot.players.map((player, index) => [player.id, playerClients[index]])),
  }
}

function fixtureDay(roomId) {
  localSql(`update public.rooms set phase = 'DAY', revision = revision + 1 where id = ${sqlUuid(roomId)};`)
}

function keepAlive(roomId, playerIds) {
  const ids = playerIds.map(sqlUuid).join(',')
  localSql(`update public.room_players set alive = (id in (${ids})) where room_id = ${sqlUuid(roomId)};`)
}

async function openExpireResolve(room, ballots = []) {
  await rpc(moderator, 'ms1g2_start_day_vote', { p_room_id: room.id })
  for (const [voterId, targetId] of ballots) {
    await rpc(room.clientByPlayerId[voterId], 'ms1g2_cast_day_vote', {
      p_room_id: room.id, p_target_player_id: targetId,
    })
  }
  localSql(`update private.day_vote_rounds set opened_at = statement_timestamp() - interval '31 seconds', deadline_at = statement_timestamp() - interval '1 second' where room_id = ${sqlUuid(room.id)};`)
  return rpc(moderator, 'ms1g2_resolve_day_vote', { p_room_id: room.id })
}

// Fool: one positive vote hangs the Fool; concurrent finalize persists one result.
const foolRoom = await createStartedRoom()
fixtureDay(foolRoom.id)
await rpc(moderator, 'ms1g2_start_day_vote', { p_room_id: foolRoom.id })
const foolId = foolRoom.actors.fool.id
const foolVoter = foolRoom.snapshot.players.find((player) => player.id !== foolId).id
await rpc(foolRoom.clientByPlayerId[foolVoter], 'ms1g2_cast_day_vote', {
  p_room_id: foolRoom.id, p_target_player_id: foolId,
})
localSql(`update private.day_vote_rounds set opened_at = statement_timestamp() - interval '31 seconds', deadline_at = statement_timestamp() - interval '1 second' where room_id = ${sqlUuid(foolRoom.id)};`)

const realtimePayloads = []
const channel = moderator
  .channel(`room:${foolRoom.id}`, { config: { private: true } })
  .on('broadcast', { event: 'room_changed' }, (payload) => realtimePayloads.push(payload))
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Realtime subscribe timeout.')), 8_000)
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') { clearTimeout(timeout); resolve() }
  })
})
const [foolFirst, foolConcurrent] = await Promise.all([
  rpc(moderator, 'ms1g2_resolve_day_vote', { p_room_id: foolRoom.id }),
  rpc(moderator, 'ms1g2_resolve_day_vote', { p_room_id: foolRoom.id }),
])
invariant(foolFirst.matchResult?.outcome === 'FOOL', 'Fool hanging did not finish FOOL.')
invariant(foolConcurrent.matchResult?.outcome === 'FOOL', 'Concurrent Fool finalize diverged.')
invariant(foolFirst.room.status === 'FINISHED' && foolFirst.room.phase === 'ENDED', 'Fool result is not terminal.')
invariant(localSql(`select count(*) from private.match_results where room_id = ${sqlUuid(foolRoom.id)};`) === '1', 'Fool produced duplicate result rows.')
invariant(localSql(`select count(*) from private.gameplay_events where room_id = ${sqlUuid(foolRoom.id)} and event_type = 'MATCH_FINISHED';`) === '1', 'Fool produced duplicate finish events.')
await rpcFailure(moderator, 'ms1g2_start_day_vote', { p_room_id: foolRoom.id }, 'MATCH_FINISHED')
await rpcFailure(foolRoom.clientByPlayerId[foolVoter], 'ms1g2_cast_day_vote', {
  p_room_id: foolRoom.id, p_target_player_id: foolId,
}, 'MATCH_FINISHED')
await rpcFailure(moderator, 'ms1g2_start_morning', { p_room_id: foolRoom.id }, 'MATCH_FINISHED')
await rpcFailure(moderator, 'ms1g2_open_night_role_call', {
  p_room_id: foolRoom.id, p_role_id: 'werewolf',
}, 'MATCH_FINISHED')
await rpcFailure(moderator, 'ms1f_start_next_night', { p_room_id: foolRoom.id })
await new Promise((resolve) => setTimeout(resolve, 250))
invariant(!JSON.stringify(realtimePayloads).match(/FOOL|fool|role|winner|outcome|subject/i), 'Generic Realtime leaked result or role truth.')
await moderator.removeChannel(channel)

const foolPlayerProjection = await rpc(foolRoom.clientByPlayerId[foolVoter], 'ms1a_get_player_room', { p_room_id: foolRoom.id })
invariant(foolPlayerProjection.matchResult?.outcome === 'FOOL', 'Authorized Player lacks minimal terminal outcome.')
invariant(!('roleConfig' in foolPlayerProjection) && !('assignments' in foolPlayerProjection), 'Player terminal projection leaked Moderator truth.')
await rpcFailure(outsider, 'ms1a_get_player_room', { p_room_id: foolRoom.id }, 'UNAUTHORIZED')
const directRead = await playerClients[0].schema('private').from('match_results').select('*')
invariant(Boolean(directRead.error), 'Player directly read private match results.')
const directWrite = await playerClients[0].from('rooms').update({ status: 'FINISHED' }).eq('id', foolRoom.id)
invariant(Boolean(directWrite.error), 'Player directly mutated terminal room truth.')

// Normal precedence: Wolf parity, SK sole survivor, Draw, and Village.
const wolfRoom = await createStartedRoom()
fixtureDay(wolfRoom.id)
keepAlive(wolfRoom.id, [wolfRoom.actors.werewolf.id, wolfRoom.actors.traitor.id, wolfRoom.actors.villager.id])
const wolfFinished = await openExpireResolve(wolfRoom)
invariant(wolfFinished.matchResult?.outcome === 'WOLF', 'Wolf parity did not win.')

const wolfSkRoom = await createStartedRoom()
fixtureDay(wolfSkRoom.id)
keepAlive(wolfSkRoom.id, [wolfSkRoom.actors.werewolf.id, wolfSkRoom.actors['serial-killer'].id])
const wolfSkContinues = await openExpireResolve(wolfSkRoom)
invariant(wolfSkContinues.matchResult === null, 'Living Serial Killer failed to block Wolf parity or won before sole survivor.')

const skRoom = await createStartedRoom()
fixtureDay(skRoom.id)
keepAlive(skRoom.id, [skRoom.actors['serial-killer'].id])
const skFinished = await openExpireResolve(skRoom)
invariant(skFinished.matchResult?.outcome === 'SERIAL_KILLER', 'SK sole survivor did not win.')

const drawRoom = await createStartedRoom()
fixtureDay(drawRoom.id)
localSql(`update public.room_players set alive = false where room_id = ${sqlUuid(drawRoom.id)};`)
const drawFinished = await openExpireResolve(drawRoom)
invariant(drawFinished.matchResult?.outcome === 'DRAW', 'Total elimination did not Draw.')
invariant(localSql(`select metadata->>'message' from private.gameplay_events where room_id = ${sqlUuid(drawRoom.id)} and event_type = 'MATCH_FINISHED';`) === 'Cả làng bị xóa sổ.', 'Draw canonical semantic was not persisted.')

const villageRoom = await createStartedRoom()
fixtureDay(villageRoom.id)
keepAlive(villageRoom.id, [villageRoom.actors.traitor.id, villageRoom.actors.villager.id])
const villageFinished = await openExpireResolve(villageRoom)
invariant(villageFinished.matchResult?.outcome === 'VILLAGE', 'Converted Traitor + Villager did not resolve Village.')
invariant(localSql(`select count(*) from private.traitor_faction_transitions where room_id = ${sqlUuid(villageRoom.id)} and player_id = ${sqlUuid(villageRoom.actors.traitor.id)};`) === '1', 'Traitor was not reconciled before Village.')

// Couple wins as the exact active trio; a separate pure-domain case proves Wolf precedence.
const coupleRoom = await createStartedRoom()
const cupid = coupleRoom.actors.cupid
const skLover = coupleRoom.actors['serial-killer']
const villageLover = coupleRoom.actors.villager
await rpc(moderator, 'ms1g2_open_cupid_call', { p_room_id: coupleRoom.id })
await rpc(cupid.client, 'ms1g2_submit_cupid_pairing', {
  p_room_id: coupleRoom.id,
  p_first_target_player_id: skLover.id,
  p_second_target_player_id: villageLover.id,
})
fixtureDay(coupleRoom.id)
keepAlive(coupleRoom.id, [cupid.id, skLover.id, villageLover.id])
const coupleFinished = await openExpireResolve(coupleRoom)
invariant(coupleFinished.matchResult?.outcome === 'COUPLE', 'Exact Cupid/Lovers trio did not win Couple.')
invariant(localSql(`select cardinality(subject_player_ids) from private.match_results where room_id = ${sqlUuid(coupleRoom.id)};`) === '3', 'Couple result subjects were not persisted.')

const wolfCoupleRoom = await createStartedRoom()
const wolfCoupleCupid = wolfCoupleRoom.actors.cupid
await rpc(moderator, 'ms1g2_open_cupid_call', { p_room_id: wolfCoupleRoom.id })
await rpc(wolfCoupleCupid.client, 'ms1g2_submit_cupid_pairing', {
  p_room_id: wolfCoupleRoom.id,
  p_first_target_player_id: wolfCoupleRoom.actors.werewolf.id,
  p_second_target_player_id: wolfCoupleRoom.actors.traitor.id,
})
fixtureDay(wolfCoupleRoom.id)
keepAlive(wolfCoupleRoom.id, [
  wolfCoupleCupid.id,
  wolfCoupleRoom.actors.werewolf.id,
  wolfCoupleRoom.actors.traitor.id,
])
const wolfOverCouple = await openExpireResolve(wolfCoupleRoom)
invariant(wolfOverCouple.matchResult?.outcome === 'WOLF', 'Wolf precedence did not beat an otherwise-valid Couple trio.')

// Natural E/D2 lifecycle: bite N1 -> pending through Day -> transform at N2 -> Wolf before calls.
const pendingRoom = await createStartedRoom({
  werewolf: 1, 'half-wolf': 1, traitor: 1, seer: 1,
  protector: 1, fool: 1, villager: 1,
})
const wolf = pendingRoom.actors.werewolf
const traitor = pendingRoom.actors.traitor
const half = pendingRoom.actors['half-wolf']
const protector = pendingRoom.actors.protector
const seer = pendingRoom.actors.seer
const ordinaryTarget = pendingRoom.actors.villager
await rpc(moderator, 'ms1g2_open_night_role_call', { p_room_id: pendingRoom.id, p_role_id: 'werewolf' })
for (const actor of [wolf, traitor]) {
  await rpc(actor.client, 'ms1g2_submit_wolf_ballot', { p_room_id: pendingRoom.id, p_target_player_id: half.id })
  await rpc(actor.client, 'ms1g2_confirm_wolf_ballot', { p_room_id: pendingRoom.id })
}
await rpc(moderator, 'ms1g2_finalize_wolf_round', { p_room_id: pendingRoom.id })
await rpc(moderator, 'ms1g2_open_night_role_call', { p_room_id: pendingRoom.id, p_role_id: 'protector' })
await rpc(protector.client, 'ms1g2_submit_protector_target', { p_room_id: pendingRoom.id, p_target_player_id: ordinaryTarget.id })
await rpc(moderator, 'ms1g2_open_night_role_call', { p_room_id: pendingRoom.id, p_role_id: 'seer' })
await rpc(seer.client, 'ms1g2_submit_seer_inspection', { p_room_id: pendingRoom.id, p_target_player_id: half.id })
const inspected = await rpc(seer.client, 'ms1a_get_player_room', { p_room_id: pendingRoom.id })
invariant(inspected.nightAction?.seerResult === 'NON_WOLF', 'Pending Half-Wolf was not NON_WOLF on Night 1.')
await rpc(seer.client, 'ms1g2_acknowledge_seer_result', { p_room_id: pendingRoom.id })
await rpc(moderator, 'ms1g2_resolve_night_effects', { p_room_id: pendingRoom.id })
await rpc(moderator, 'ms1g2_finalize_night_checkpoint', { p_room_id: pendingRoom.id })
const pendingNight = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: pendingRoom.id })
invariant(pendingNight.matchResult === null, 'Pending Half-Wolf allowed premature Night result.')
invariant(pendingNight.factionTransitions.halfWolves[half.id].status === 'PENDING_TRANSFORMATION', 'Half-Wolf bite did not schedule transformation.')
await rpc(moderator, 'ms1g2_start_morning', { p_room_id: pendingRoom.id })
keepAlive(pendingRoom.id, [half.id, traitor.id])
await rpc(moderator, 'ms1g2_start_day_vote', { p_room_id: pendingRoom.id })
localSql(`update private.day_vote_rounds set opened_at = statement_timestamp() - interval '31 seconds', deadline_at = statement_timestamp() - interval '1 second' where room_id = ${sqlUuid(pendingRoom.id)};`)
const pendingDay = await rpc(moderator, 'ms1g2_resolve_day_vote', { p_room_id: pendingRoom.id })
invariant(pendingDay.matchResult === null, 'Living pending Half-Wolf allowed premature Village win.')
invariant(localSql(`select count(*) from private.traitor_faction_transitions where room_id = ${sqlUuid(pendingRoom.id)} and player_id = ${sqlUuid(traitor.id)};`) === '1', 'Traitor did not permanently convert after last current bite-capable Wolf died.')
const transformedWin = await rpc(moderator, 'ms1g2_start_next_night', { p_room_id: pendingRoom.id })
invariant(transformedWin.matchResult?.outcome === 'WOLF', 'Night-2 Half-Wolf parity did not finish Wolf.')
invariant(transformedWin.room.dayNumber === 2 && transformedWin.room.phase === 'ENDED', 'Start-Night result timing is wrong.')
invariant(transformedWin.night === null, 'A Night role call surface opened after terminal start-Night resolution.')
invariant(localSql(`select status from private.half_wolf_transitions where room_id = ${sqlUuid(pendingRoom.id)} and player_id = ${sqlUuid(half.id)};`) === 'TRANSFORMED', 'Half-Wolf did not transform before winner resolution.')
invariant(localSql(`select count(*) from private.traitor_faction_transitions where room_id = ${sqlUuid(pendingRoom.id)} and player_id = ${sqlUuid(traitor.id)};`) === '1', 'Converted Traitor rejoined after Half-Wolf transformation.')

for (const client of clients) {
  await client.removeAllChannels()
  await client.auth.signOut()
}

console.log(JSON.stringify({
  result: 'PASS',
  scope: 'MS-1G2 LOCAL Supabase',
  rooms: 9,
  fool: 'FOOL + concurrent/idempotent + terminal denial',
  normal: ['WOLF', 'COUPLE', 'SERIAL_KILLER', 'DRAW', 'VILLAGE'],
  pendingHalfWolf: 'Night 1 bite -> Day pending -> Night 2 transform -> WOLF before role call',
  privacy: 'private DML/read denied; unrelated denied; generic signal contains no outcome/role',
}, null, 2))
process.exit(0)
