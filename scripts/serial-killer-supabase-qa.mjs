import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

invariant(
  process.argv.includes('--local') && !process.argv.includes('--remote'),
  'MS-1G1 QA is intentionally local-only.',
)

function parseEnv(text) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

const command = process.platform === 'win32'
  ? [process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', 'npx supabase status -o env']]
  : ['npx', ['supabase', 'status', '-o', 'env']]
const local = parseEnv(execFileSync(command[0], command[1], {
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
  invariant(result.error.message === expected, `${name}: expected ${expected}, got ${result.error.message}`)
}

async function subscribeGenericRoomChange(roomId) {
  const payloads = []
  const channel = moderator
    .channel(`room:${roomId}`, { config: { private: true } })
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
  await new Promise((resolve) => setTimeout(resolve, 300))
  return { payloads, channel }
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Realtime room_changed instrumentation timeout.')
}

const moderator = isolatedClient()
const players = Array.from({ length: 7 }, () => isolatedClient())
const outsider = isolatedClient()
const clients = [moderator, ...players, outsider]
const identities = await Promise.all(clients.map(authenticate))
invariant(new Set(identities).size === 9, 'Local identities are not isolated.')

async function prepareRoom(roleConfig, label, beforeStart = undefined) {
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
      p_display_name: `${label}-${index + 1}`,
    }))
  }
  const dealt = await rpc(moderator, 'ms1a_lock_and_assign_roles', {
    p_room_id: created.room.id,
  })
  const clientByPlayerId = new Map(joined.map((payload, index) => [payload.self.id, players[index]]))
  const playerIdsByRole = new Map()
  for (const assignment of dealt.assignments) {
    const list = playerIdsByRole.get(assignment.roleId) ?? []
    list.push(assignment.playerId)
    playerIdsByRole.set(assignment.roleId, list)
  }
  const result = { id: created.room.id, dealt, clientByPlayerId, playerIdsByRole }
  if (beforeStart) await beforeStart(result)
  await Promise.all(players.map((client) => rpc(client, 'ms1a_confirm_role_reveal', {
    p_room_id: created.room.id,
  })))
  await rpc(moderator, 'ms1a_start_room', { p_room_id: created.room.id })
  return result
}

function role(room, roleId, offset = 0) {
  const playerId = (room.playerIdsByRole.get(roleId) ?? [])[offset]
  const client = room.clientByPlayerId.get(playerId)
  invariant(playerId && client, `Missing ${roleId} in focused room.`)
  return { playerId, client }
}

function anyOther(room, excludedIds) {
  const playerId = room.dealt.players.find((player) => !excludedIds.includes(player.id))?.id
  invariant(playerId, 'No eligible other player.')
  return { playerId, client: room.clientByPlayerId.get(playerId) }
}

async function moderatorProjection(room) {
  return rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: room.id })
}

async function playerProjection(room, actor) {
  return rpc(actor.client, 'ms1a_get_player_room', { p_room_id: room.id })
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
    await rpc(client, 'ms1b1_submit_wolf_ballot', {
      p_room_id: room.id,
      p_target_player_id: targetId,
    })
    await rpc(client, 'ms1b1_confirm_wolf_ballot', { p_room_id: room.id })
  }
  await rpc(moderator, 'ms1b1_finalize_wolf_round', { p_room_id: room.id })
}

async function completeSerialKiller(room, targetId, concurrentConfirm = false) {
  await rpc(moderator, 'ms1g1_open_serial_killer_call', { p_room_id: room.id })
  const killer = role(room, 'serial-killer')
  await rpc(killer.client, 'ms1g1_submit_serial_killer_intent', {
    p_room_id: room.id,
    p_target_player_id: targetId,
  })
  if (concurrentConfirm) {
    await Promise.all([
      rpc(killer.client, 'ms1g1_confirm_serial_killer_intent', { p_room_id: room.id }),
      rpc(killer.client, 'ms1g1_confirm_serial_killer_intent', { p_room_id: room.id }),
    ])
  } else {
    await rpc(killer.client, 'ms1g1_confirm_serial_killer_intent', { p_room_id: room.id })
  }
}

async function completeProtector(room, targetId) {
  await rpc(moderator, 'ms1b1_open_night_role_call', {
    p_room_id: room.id,
    p_role_id: 'protector',
  })
  await rpc(role(room, 'protector').client, 'ms1b1_submit_protector_target', {
    p_room_id: room.id,
    p_target_player_id: targetId,
  })
}

async function completeHunter(room, targetId) {
  await rpc(moderator, 'ms1d1_open_hunter_call', { p_room_id: room.id })
  const hunter = role(room, 'hunter')
  await rpc(hunter.client, 'ms1d1_submit_hunter_prelock', {
    p_room_id: room.id,
    p_target_player_id: targetId,
  })
  await rpc(hunter.client, 'ms1d1_confirm_hunter_prelock', { p_room_id: room.id })
}

async function completeCupid(room, firstId, secondId) {
  await rpc(moderator, 'ms1f_open_cupid_call', { p_room_id: room.id })
  await rpc(role(room, 'cupid').client, 'ms1f_submit_cupid_pairing', {
    p_room_id: room.id,
    p_first_target_player_id: firstId,
    p_second_target_player_id: secondId,
  })
}

async function completeSeer(room, targetId) {
  await rpc(moderator, 'ms1b1_open_night_role_call', {
    p_room_id: room.id,
    p_role_id: 'seer',
  })
  const seer = role(room, 'seer')
  const inspected = await rpc(seer.client, 'ms1b1_submit_seer_inspection', {
    p_room_id: room.id,
    p_target_player_id: targetId,
  })
  invariant(inspected.seerResult === 'NON_WOLF', 'Seer must read Serial Killer as NON_WOLF.')
  await rpc(seer.client, 'ms1b1_acknowledge_seer_result', { p_room_id: room.id })
}

async function finalizeWithoutWitch(room) {
  return rpc(moderator, 'ms1f_finalize_night_checkpoint', { p_room_id: room.id })
}

// Core authority, privacy, multi-source persistence, and Witch rescue.
const core = await prepareRoom({
  werewolf: 1,
  'serial-killer': 1,
  protector: 1,
  witch: 1,
  hunter: 1,
  cupid: 1,
  villager: 1,
}, 'g1core')
const coreSk = role(core, 'serial-killer')
const coreCupid = role(core, 'cupid')
const coreHunter = role(core, 'hunter')
const coreVictim = anyOther(core, [
  coreSk.playerId,
  coreCupid.playerId,
  coreHunter.playerId,
  role(core, 'witch').playerId,
  role(core, 'protector').playerId,
  role(core, 'werewolf').playerId,
])
const coreShield = coreCupid.playerId

await rpc(moderator, 'ms1g1_open_serial_killer_call', { p_room_id: core.id })
await rpcFailure(
  anyOther(core, [coreSk.playerId]).client,
  'ms1g1_submit_serial_killer_intent',
  { p_room_id: core.id, p_target_player_id: coreVictim.playerId },
  'WRONG_ROLE',
)
await rpcFailure(
  coreSk.client,
  'ms1g1_submit_serial_killer_intent',
  { p_room_id: core.id, p_target_player_id: coreSk.playerId },
  'INVALID_TARGET',
)
let privateSk = await playerProjection(core, coreSk)
invariant(privateSk.nightAction?.mode === 'SERIAL_KILLER_ATTACK', 'SK private action missing.')
const ordinaryProjection = await playerProjection(core, coreVictim)
invariant(!ordinaryProjection.nightAction, 'Ordinary Player received SK action.')
invariant(!/SERIAL_KILLER|serial-killer|immunity/i.test(JSON.stringify(ordinaryProjection)), 'Ordinary projection leaked SK authority.')
const directRead = await coreSk.client.schema('private').from('serial_killer_intents').select('*')
invariant(Boolean(directRead.error), 'Direct private SK intent read unexpectedly succeeded.')
const directWrite = await coreSk.client.schema('private').from('serial_killer_intents').insert({
  room_id: core.id,
  night_number: 1,
})
invariant(Boolean(directWrite.error), 'Direct private SK intent write unexpectedly succeeded.')
await rpcFailure(coreSk.client, 'ms1b2_resolve_night_effects', { p_room_id: core.id }, 'NOT_MODERATOR')
await rpcFailure(outsider, 'ms1g1_open_serial_killer_call', { p_room_id: core.id }, 'NOT_MODERATOR')

const realtime = await subscribeGenericRoomChange(core.id)
await Promise.all([
  rpc(coreSk.client, 'ms1g1_submit_serial_killer_intent', {
    p_room_id: core.id,
    p_target_player_id: coreShield,
  }),
  rpc(coreSk.client, 'ms1g1_submit_serial_killer_intent', {
    p_room_id: core.id,
    p_target_player_id: coreVictim.playerId,
  }),
])
await rpc(coreSk.client, 'ms1g1_submit_serial_killer_intent', {
  p_room_id: core.id,
  p_target_player_id: coreVictim.playerId,
})
privateSk = await playerProjection(core, coreSk)
invariant(privateSk.nightAction?.currentTargetId === coreVictim.playerId, 'SK target change was not truthful.')
await Promise.all([
  rpc(coreSk.client, 'ms1g1_confirm_serial_killer_intent', { p_room_id: core.id }),
  rpc(coreSk.client, 'ms1g1_confirm_serial_killer_intent', { p_room_id: core.id }),
])
invariant(
  localSql(`select count(*) from private.serial_killer_intents where room_id='${core.id}' and night_number=1`) === '1',
  'Concurrent SK submission created duplicate intent rows.',
)
await waitFor(() => realtime.payloads.length > 0)
await moderator.removeChannel(realtime.channel)
const realtimeText = JSON.stringify(realtime.payloads)
invariant(
  !/(serial|killer|target|source|effect|immune|provisional|death)/i.test(realtimeText),
  'Generic Realtime payload leaked G1 secret truth.',
)
invariant(
  !realtimeText.includes(coreSk.playerId) &&
    !realtimeText.includes(coreVictim.playerId),
  'Generic Realtime payload leaked SK/target identifiers.',
)
await completeCupid(core, coreVictim.playerId, coreHunter.playerId)
await completeWolf(core, coreVictim.playerId)
await completeProtector(core, coreShield)
await completeHunter(core, null)
const [coreResolutionA, coreResolutionB] = await Promise.all([
  rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: core.id }),
  rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: core.id }),
])
invariant(coreResolutionA.id === coreResolutionB.id, 'Concurrent resolution created duplicate logical results.')
const coreSources = coreResolutionA.effects.filter((effect) => effect.targetPlayerId === coreVictim.playerId)
invariant(coreSources.length === 2, 'Wolf + SK did not preserve two source effects.')
invariant(coreResolutionA.provisionalDeathCandidateIds.filter((id) => id === coreVictim.playerId).length === 1, 'Multi-source victim was duplicated.')
await rpc(moderator, 'ms1f_open_witch_call', { p_room_id: core.id })
const witch = role(core, 'witch')
const witchView = await playerProjection(core, witch)
invariant(witchView.nightAction?.resurrectionCandidates?.some((player) => player.id === coreVictim.playerId), 'Witch did not see SK victim by name.')
invariant(!/SERIAL_KILLER_ATTACK|WOLF_ATTACK|sourceType|killer/i.test(JSON.stringify(witchView.nightAction)), 'Witch projection leaked source/killer.')
await rpc(witch.client, 'ms1c_submit_witch_decision', {
  p_room_id: core.id,
  p_resurrection_target_id: coreVictim.playerId,
  p_poison_target_id: null,
})
await rpc(moderator, 'ms1f_finalize_night_checkpoint', { p_room_id: core.id })
const coreFinal = await moderatorProjection(core)
invariant(coreFinal.alivePlayerIds.includes(coreVictim.playerId), 'Witch rescue did not preserve victim alive.')

// One shield blocks both villain attacks.
const protectedRoom = await prepareRoom({
  werewolf: 1,
  'serial-killer': 1,
  protector: 1,
  villager: 4,
}, 'g1block')
const protectedSk = role(protectedRoom, 'serial-killer')
const protectedTarget = anyOther(protectedRoom, [
  protectedSk.playerId,
  role(protectedRoom, 'werewolf').playerId,
  role(protectedRoom, 'protector').playerId,
])
await completeWolf(protectedRoom, protectedTarget.playerId)
await completeSerialKiller(protectedRoom, protectedTarget.playerId, true)
await completeProtector(protectedRoom, protectedTarget.playerId)
const protectedResult = await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: protectedRoom.id })
invariant(protectedResult.effects.length === 2, 'Protected dual attack lost a source effect.')
invariant(protectedResult.effects.every((effect) => effect.outcome === 'BLOCKED_BY_PROTECTOR'), 'Protector did not block every villain attack.')
invariant(protectedResult.provisionalDeathCandidateIds.length === 0, 'Protected target became provisional.')
await finalizeWithoutWitch(protectedRoom)

// Wolf immunity and Seer NON_WOLF.
const immunityRoom = await prepareRoom({
  werewolf: 1,
  'serial-killer': 1,
  seer: 1,
  villager: 4,
}, 'g1immune')
const immuneSk = role(immunityRoom, 'serial-killer')
await completeWolf(immunityRoom, immuneSk.playerId)
await completeSerialKiller(immunityRoom, null)
await completeSeer(immunityRoom, immuneSk.playerId)
const immunityResult = await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: immunityRoom.id })
invariant(immunityResult.outcome === 'IMMUNE', 'Wolf->SK did not resolve IMMUNE.')
invariant(immunityResult.effects[0].outcome === 'IMMUNE_TO_WOLF_ATTACK', 'Explicit Wolf immunity effect missing.')
invariant(immunityResult.provisionalDeathCandidateIds.length === 0, 'Immune SK became provisional.')
await finalizeWithoutWitch(immunityRoom)
invariant((await moderatorProjection(immunityRoom)).alivePlayerIds.includes(immuneSk.playerId), 'Wolf attack killed SK.')

// Protector resolves before Wolf immunity when the protected target is SK.
const protectedImmunityRoom = await prepareRoom({
  werewolf: 1,
  'serial-killer': 1,
  protector: 1,
  villager: 4,
}, 'g1imblock')
const protectedImmuneSk = role(protectedImmunityRoom, 'serial-killer')
await completeWolf(protectedImmunityRoom, protectedImmuneSk.playerId)
await completeSerialKiller(protectedImmunityRoom, null)
await completeProtector(protectedImmunityRoom, protectedImmuneSk.playerId)
const protectedImmunity = await rpc(moderator, 'ms1b2_resolve_night_effects', {
  p_room_id: protectedImmunityRoom.id,
})
invariant(
  protectedImmunity.effects[0].outcome === 'BLOCKED_BY_PROTECTOR',
  'Protector did not resolve before Wolf immunity.',
)
invariant(
  !protectedImmunity.effects[0].immunity,
  'Protected Wolf attack incorrectly applied immunity outcome too.',
)
await finalizeWithoutWitch(protectedImmunityRoom)
invariant(
  (await moderatorProjection(protectedImmunityRoom)).alivePlayerIds.includes(protectedImmuneSk.playerId),
  'Protected SK did not survive Wolf attack.',
)

// Existing attacked-Witch restrictions apply to an SK provisional attack.
const witchAttackedRoom = await prepareRoom({
  werewolf: 1,
  'serial-killer': 1,
  witch: 1,
  villager: 4,
}, 'g1witch')
const attackedWitch = role(witchAttackedRoom, 'witch')
await completeWolf(witchAttackedRoom, null)
await completeSerialKiller(witchAttackedRoom, attackedWitch.playerId)
await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: witchAttackedRoom.id })
await rpc(moderator, 'ms1f_open_witch_call', { p_room_id: witchAttackedRoom.id })
const attackedWitchView = await playerProjection(witchAttackedRoom, attackedWitch)
invariant(attackedWitchView.nightAction?.witchAttackedThisNight === true, 'SK-attacked Witch was not recognized as attacked.')
invariant(attackedWitchView.nightAction?.resurrectionAvailable === false, 'SK-attacked Witch could resurrect.')
invariant(attackedWitchView.nightAction?.poisonAvailable === false, 'Night-1 poison unexpectedly became available.')
await rpc(attackedWitch.client, 'ms1c_submit_witch_decision', {
  p_room_id: witchAttackedRoom.id,
  p_resurrection_target_id: null,
  p_poison_target_id: null,
})
await rpc(moderator, 'ms1f_finalize_night_checkpoint', { p_room_id: witchAttackedRoom.id })
invariant(
  !(await moderatorProjection(witchAttackedRoom)).alivePlayerIds.includes(attackedWitch.playerId),
  'SK-attacked Witch did not finalize dead after declining action.',
)

// SK kills Hunter; existing Hunter and Lovers fixpoint remains authoritative.
const chainRoom = await prepareRoom({
  werewolf: 1,
  'serial-killer': 1,
  hunter: 1,
  cupid: 1,
  villager: 3,
}, 'g1chain')
const chainSk = role(chainRoom, 'serial-killer')
const chainHunter = role(chainRoom, 'hunter')
const chainCupid = role(chainRoom, 'cupid')
const chainVillagers = (chainRoom.playerIdsByRole.get('villager') ?? []).map((playerId) => ({
  playerId,
  client: chainRoom.clientByPlayerId.get(playerId),
}))
await completeCupid(chainRoom, chainHunter.playerId, chainVillagers[0].playerId)
await completeWolf(chainRoom, chainVillagers[2].playerId)
await completeSerialKiller(chainRoom, chainHunter.playerId)
await completeHunter(chainRoom, chainVillagers[1].playerId)
await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: chainRoom.id })
await finalizeWithoutWitch(chainRoom)
const chainFinal = await moderatorProjection(chainRoom)
for (const playerId of [chainHunter.playerId, ...chainVillagers.map((entry) => entry.playerId)]) {
  invariant(!chainFinal.alivePlayerIds.includes(playerId), `Expected stabilized death missing for ${playerId}.`)
}
invariant(chainFinal.nightResolution.effects.some((effect) => effect.sourceType === 'HUNTER_SHOT'), 'SK-killed Hunter did not trigger shot.')
invariant(chainFinal.nightResolution.effects.some((effect) => effect.sourceType === 'LOVER_HEARTBREAK'), 'SK-killed Lover chain did not create heartbreak.')
invariant(chainFinal.alivePlayerIds.includes(chainSk.playerId), 'Unrelated SK died in chain scenario.')
invariant(chainFinal.alivePlayerIds.includes(chainCupid.playerId), 'Unrelated Cupid died in chain scenario.')

// Killing the last bite-capable Wolf reconciles Traitor immediately.
const traitorRoom = await prepareRoom({
  werewolf: 1,
  'serial-killer': 1,
  traitor: 1,
  villager: 4,
}, 'g1traitor')
const traitorWolf = role(traitorRoom, 'werewolf')
await completeWolf(traitorRoom, null)
await completeSerialKiller(traitorRoom, traitorWolf.playerId)
await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: traitorRoom.id })
await finalizeWithoutWitch(traitorRoom)
const traitorFinal = await moderatorProjection(traitorRoom)
invariant(!traitorFinal.alivePlayerIds.includes(traitorWolf.playerId), 'SK did not kill last bite-capable Wolf.')
invariant(Object.values(traitorFinal.factionTransitions.traitors).some((transition) => transition.status === 'CONVERTED_VILLAGE'), 'Traitor did not convert after SK killed last bite-capable Wolf.')

// SK attack on untransformed Half-Wolf is lethal and schedules no bite transition.
const halfRoom = await prepareRoom({
  werewolf: 1,
  'serial-killer': 1,
  'half-wolf': 1,
  villager: 4,
}, 'g1half')
const half = role(halfRoom, 'half-wolf')
const halfWolfTarget = anyOther(halfRoom, [
  half.playerId,
  role(halfRoom, 'serial-killer').playerId,
  role(halfRoom, 'werewolf').playerId,
])
await completeWolf(halfRoom, halfWolfTarget.playerId)
await completeSerialKiller(halfRoom, half.playerId)
const halfResolution = await rpc(moderator, 'ms1b2_resolve_night_effects', { p_room_id: halfRoom.id })
invariant(halfResolution.effects.find((effect) => effect.targetPlayerId === half.playerId)?.sourceType === 'SERIAL_KILLER_ATTACK', 'Half-Wolf did not receive ordinary SK source.')
invariant(!halfResolution.effects.some((effect) => effect.targetPlayerId === half.playerId && effect.outcome === 'HALF_WOLF_BITE_SCHEDULED'), 'SK incorrectly scheduled Half-Wolf transformation.')
await finalizeWithoutWitch(halfRoom)
const halfFinal = await moderatorProjection(halfRoom)
invariant(!halfFinal.alivePlayerIds.includes(half.playerId), 'SK attack did not kill Half-Wolf.')
invariant(halfFinal.factionTransitions.halfWolves[half.playerId].status !== 'PENDING_TRANSFORMATION', 'SK attack created a pending Half-Wolf transition.')

// Dead-before-Night holder remains in the configured ritual without a private action.
const deadRoom = await prepareRoom({
  werewolf: 1,
  'serial-killer': 1,
  villager: 5,
}, 'g1dead', (room) => {
  const deadSkId = (room.playerIdsByRole.get('serial-killer') ?? [])[0]
  invariant(deadSkId, 'Missing dead-before-Night SK fixture holder.')
  localSql(`update public.room_players set alive=false where room_id='${room.id}' and id='${deadSkId}'`)
})
await rpc(moderator, 'ms1g1_open_serial_killer_call', { p_room_id: deadRoom.id })
const deadProjection = await moderatorProjection(deadRoom)
invariant(
  deadProjection.night.calls.some((call) => call.roleId === 'serial-killer' && call.status === 'CALLED'),
  'Dead SK ritual call was not visible to Moderator.',
)
invariant(!deadProjection.night.actionsByRole['serial-killer'], 'Dead SK unexpectedly received action authority.')
await rpc(moderator, 'ms1b1_complete_empty_night_role_call', {
  p_room_id: deadRoom.id,
  p_role_id: 'serial-killer',
})

await Promise.all(clients.map((client) => client.removeAllChannels()))

console.log(JSON.stringify({
  gate: 'MS-1G1',
  mode: 'LOCAL',
  rooms: 8,
  isolatedIdentities: identities.length,
  core: 'MULTI_SOURCE_WITCH_RESCUE_PRIVATE',
  protector: 'BOTH_VILLAIN_EFFECTS_BLOCKED',
  wolfToSerialKiller: 'IMMUNE_NONLETHAL',
  protectorBeforeImmunity: 'BLOCKED',
  attackedWitch: 'NO_RESURRECTION_NIGHT1_FINAL_DEATH',
  seer: 'NON_WOLF',
  deathFixpoint: 'HUNTER_AND_LOVER',
  traitor: 'RECONCILED_AFTER_LAST_WOLF_DEATH',
  halfWolf: 'LETHAL_WITHOUT_TRANSFORMATION',
  deadBeforeNight: 'RITUAL_WITHOUT_ACTION',
  directDml: 'DENIED',
  genericRealtime: 'ROOM_CHANGED_WITHOUT_SECRET_PAYLOAD',
  remote: 'NOT_USED',
}, null, 2))
