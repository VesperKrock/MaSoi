import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function localEnvironment() {
  const values = { ...process.env }
  if (fs.existsSync('.env.local')) {
    for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!match || values[match[1]]) continue
      values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  const url = values.VITE_SUPABASE_URL
  const key = values.VITE_SUPABASE_PUBLISHABLE_KEY
  invariant(url && key, 'Thiếu VITE_SUPABASE_URL hoặc VITE_SUPABASE_PUBLISHABLE_KEY.')
  return { url, key }
}

const environment = localEnvironment()
const testRun = Date.now().toString(36)
const roleConfig = (seatCount) => {
  const werewolves = seatCount >= 13 ? 3 : 2
  return { villager: seatCount - werewolves - 1, werewolf: werewolves, seer: 1 }
}

function isolatedClient() {
  return createClient(environment.url, environment.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

async function authenticate(client) {
  const { data, error } = await client.auth.signInAnonymously()
  invariant(!error && data.user?.id, `Anonymous Auth thất bại: ${error?.message ?? 'missing user'}`)
  if (data.session?.access_token) {
    await client.realtime.setAuth(data.session.access_token)
  }
  return data.user.id
}

async function rpc(client, name, args = undefined) {
  const result = await client.rpc(name, args)
  if (result.error) throw new Error(`${name}:${result.error.message}`)
  return result.data
}

async function rpcFailure(client, name, args, expectedCode) {
  const result = await client.rpc(name, args)
  invariant(result.error?.message === expectedCode, `${name} expected ${expectedCode}; received ${result.error?.message ?? 'success'}`)
  return result.error
}

async function rpcDenied(client, name, args) {
  const result = await client.rpc(name, args)
  invariant(Boolean(result.error), `${name} unexpectedly succeeded.`)
  return result.error
}

async function createRoom(moderator, seatCount, requestId = randomUUID()) {
  return rpc(moderator, 'ms1a_create_room', {
    p_request_id: requestId,
    p_seat_count: seatCount,
    p_role_config: roleConfig(seatCount),
    p_wolf_policy: 'RANDOM_ON_TIE',
  })
}

async function join(client, code, name) {
  return rpc(client, 'ms1a_join_room', { p_code: code, p_display_name: name })
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Realtime timeout.')
}

const moderator = isolatedClient()
const players = Array.from({ length: 17 }, () => isolatedClient())
const unrelated = isolatedClient()
const authenticatedUserIds = await Promise.all([
  authenticate(moderator),
  ...players.map(authenticate),
  authenticate(unrelated),
])
invariant(new Set(authenticatedUserIds).size === authenticatedUserIds.length, 'Anonymous sessions are not isolated.')

const evidence = {
  anonymousIdentities: 19,
  roleConfigValidation: false,
  createIdempotency: false,
  realtimeLobby: false,
  flows: {},
  finalSeat: null,
  duplicateName: null,
  privacy: null,
  directDmlDenied: false,
  revealBoundary: false,
  lifecycleAuthority: false,
  unauthenticatedRpcDenied: false,
  assignmentImmutability: false,
  rlsMatrix: null,
  classicCatalog: null,
  resumeCurrentRoom: false,
  realtimeRolePrivacy: null,
}

const unauthenticated = isolatedClient()
await rpcDenied(unauthenticated, 'ms1a_lookup_room', { p_code: '000000' })
evidence.unauthenticatedRpcDenied = true

const expectedClassicRoleIds = [
  'cupid', 'fool', 'half-wolf', 'hunter', 'mayor', 'protector',
  'seer', 'serial-killer', 'traitor', 'villager', 'werewolf', 'witch',
]
const catalogResult = await moderator.from('classic_roles').select('id, quantity_mode').order('id')
invariant(!catalogResult.error, 'Authenticated user cannot read the Classic catalog.')
invariant(JSON.stringify(catalogResult.data.map((role) => role.id)) === JSON.stringify(expectedClassicRoleIds), 'Remote Classic catalog is not the exact 12-role scope.')
invariant(catalogResult.data.filter((role) => role.quantity_mode === 'MULTIPLE').map((role) => role.id).join(',') === 'villager,werewolf', 'Remote quantity policy is incorrect.')
evidence.classicCatalog = { roles: catalogResult.data.length, multiple: ['villager', 'werewolf'], singleton: 10 }

await rpcFailure(moderator, 'ms1a_create_room', {
  p_request_id: randomUUID(), p_seat_count: 6, p_role_config: roleConfig(7), p_wolf_policy: 'RANDOM_ON_TIE',
}, 'INVALID_ROOM_CONFIG')
await rpcFailure(moderator, 'ms1a_create_room', {
  p_request_id: randomUUID(), p_seat_count: 7, p_role_config: { villager: 4, werewolf: 1, seer: 2 }, p_wolf_policy: 'RANDOM_ON_TIE',
}, 'INVALID_ROOM_CONFIG')
await rpcFailure(moderator, 'ms1a_create_room', {
  p_request_id: randomUUID(), p_seat_count: 7, p_role_config: { villager: 5, werewolf: 1, invented: 1 }, p_wolf_policy: 'RANDOM_ON_TIE',
}, 'INVALID_ROOM_CONFIG')
evidence.roleConfigValidation = true

for (const seatCount of [7, 12, 16]) {
  const requestId = randomUUID()
  const created = await createRoom(moderator, seatCount, requestId)
  invariant(/^\d{6}$/.test(created.room.code), 'Server room code không đúng sáu chữ số.')
  const repeatedCreate = await createRoom(moderator, seatCount, requestId)
  invariant(repeatedCreate.room.id === created.room.id, 'Create idempotency trả room khác.')
  evidence.createIdempotency = true

  const lookup = await rpc(players[0], 'ms1a_lookup_room', { p_code: created.room.code })
  invariant(lookup.joinable === true, 'Room lookup không joinable.')
  invariant(!('roleConfig' in lookup) && !('assignments' in lookup), 'Lookup làm lộ config/assignment.')

  let joinResults
  if (seatCount === 7) {
    await rpcFailure(moderator, 'ms1a_lock_and_assign_roles', { p_room_id: created.room.id }, 'ROOM_NOT_READY')
    let realtimeInsert = false
    let realtimePayload = null
    const channel = moderator
      .channel(`room:${created.room.id}`, { config: { private: true } })
      .on('broadcast', {
        event: 'room_changed',
      }, (payload) => {
        realtimeInsert = true
        realtimePayload = payload
      })
      .subscribe()
    await waitFor(() => channel.state === 'joined')
    joinResults = [await join(players[0], created.room.code, `QA-${testRun}-7-1`)]
    try {
      await waitFor(() => realtimeInsert)
    } catch {
      joinResults.push(await join(players[1], created.room.code, `QA-${testRun}-7-2`))
      await waitFor(() => realtimeInsert)
    }
    const realtimeText = JSON.stringify(realtimePayload)
    invariant(!/assignment|roleConfig|role_id/i.test(realtimeText), 'Realtime lobby payload leaked private role truth.')
    evidence.realtimeLobby = true
    await moderator.removeChannel(channel)
    for (let index = joinResults.length; index < seatCount; index += 1) {
      joinResults.push(await join(players[index], created.room.code, `QA-${testRun}-7-${index + 1}`))
    }
  } else {
    joinResults = await Promise.all(
      players.slice(0, seatCount).map((client, index) =>
        join(client, created.room.code, `QA-${testRun}-${seatCount}-${index + 1}`),
      ),
    )
  }

  const repeatedJoin = await join(players[0], created.room.code, `ignored-${testRun}`)
  const beforeDeal = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: created.room.id })
  const moderatorResume = await rpc(moderator, 'ms1a_resume_current_room')
  const playerResume = await rpc(players[0], 'ms1a_resume_current_room')
  invariant(moderatorResume.kind === 'MODERATOR' && moderatorResume.roomId === created.room.id, 'Moderator resume did not return the current room.')
  invariant(playerResume.kind === 'PLAYER' && playerResume.roomId === created.room.id && playerResume.playerId === joinResults[0].self.id, 'Player resume changed room or stable seat.')
  evidence.resumeCurrentRoom = true
  invariant(repeatedJoin.self.id === joinResults[0].self.id, 'Repeat join đổi membership.')
  invariant(repeatedJoin.self.seat === joinResults[0].self.seat, 'Repeat join đổi seat.')
  invariant(beforeDeal.players.length === seatCount, 'Capacity không khớp.')
  invariant(new Set(beforeDeal.players.map((player) => player.seat)).size === seatCount, 'Seat bị trùng.')
  await rpcFailure(players[seatCount], 'ms1a_join_room', {
    p_code: created.room.code,
    p_display_name: `Full-${testRun}-${seatCount}`,
  }, 'ROOM_FULL')
  await rpcFailure(players[0], 'ms1a_lock_and_assign_roles', { p_room_id: created.room.id }, 'NOT_MODERATOR')
  await rpcFailure(unrelated, 'ms1a_lock_and_assign_roles', { p_room_id: created.room.id }, 'NOT_MODERATOR')
  const observedRealtimeAssignments = []
  const assignmentProbe = seatCount === 7
    ? players[0]
      .channel(`assignment-probe-${randomUUID()}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'room_role_assignments',
        filter: `room_id=eq.${created.room.id}`,
      }, (payload) => observedRealtimeAssignments.push(payload.new))
      .subscribe()
    : null
  if (assignmentProbe) {
    await waitFor(() => ['joined', 'errored', 'closed'].includes(assignmentProbe.state))
  }
  const dealt = await rpc(moderator, 'ms1a_lock_and_assign_roles', { p_room_id: created.room.id })
  invariant(dealt.assignments.length === seatCount, 'Assignment count không khớp.')
  invariant(new Set(dealt.assignments.map((assignment) => assignment.playerId)).size === seatCount, 'Player assignment bị trùng.')
  const configured = Object.entries(dealt.roleConfig).sort()
  const assigned = Object.entries(dealt.assignments.reduce((counts, assignment) => {
    counts[assignment.roleId] = (counts[assignment.roleId] ?? 0) + 1
    return counts
  }, {})).sort()
  invariant(JSON.stringify(configured) === JSON.stringify(assigned), 'Assignment multiset sai.')
  if (assignmentProbe) {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    invariant(
      observedRealtimeAssignments.length <= 1
        && observedRealtimeAssignments.every((assignment) => assignment.player_id === joinResults[0].self.id),
      'Player Realtime subscription received another Player role assignment.',
    )
    evidence.realtimeRolePrivacy = {
      otherRoleEvents: 0,
      ownRoleEvents: observedRealtimeAssignments.length,
    }
    await players[0].removeChannel(assignmentProbe)
  }
  const assignmentSignature = JSON.stringify(
    dealt.assignments
      .map(({ playerId, roleId }) => ({ playerId, roleId }))
      .sort((left, right) => left.playerId.localeCompare(right.playerId)),
  )
  await rpcFailure(moderator, 'ms1a_lock_and_assign_roles', { p_room_id: created.room.id }, 'ALREADY_DEALT')
  const afterDoubleDeal = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: created.room.id })
  const afterDoubleDealSignature = JSON.stringify(
    afterDoubleDeal.assignments
      .map(({ playerId, roleId }) => ({ playerId, roleId }))
      .sort((left, right) => left.playerId.localeCompare(right.playerId)),
  )
  invariant(afterDoubleDealSignature === assignmentSignature, 'Double deal changed private assignments.')
  evidence.assignmentImmutability = true
  await rpcFailure(unrelated, 'ms1a_join_room', { p_code: created.room.code, p_display_name: `Late-${testRun}` }, 'ROOM_LOCKED')
  await rpcFailure(players[0], 'ms1a_start_room', { p_room_id: created.room.id }, 'NOT_MODERATOR')
  await rpcFailure(unrelated, 'ms1a_start_room', { p_room_id: created.room.id }, 'NOT_MODERATOR')
  await rpcFailure(moderator, 'ms1a_start_room', { p_room_id: created.room.id }, 'ROOM_NOT_READY')
  const firstConfirm = await rpc(players[0], 'ms1a_confirm_role_reveal', { p_room_id: created.room.id })
  const repeatedConfirm = await rpc(players[0], 'ms1a_confirm_role_reveal', { p_room_id: created.room.id })
  invariant(firstConfirm.self.id === repeatedConfirm.self.id, 'Repeated reveal confirmation changed membership.')
  invariant(firstConfirm.self.revealConfirmed === true && repeatedConfirm.self.revealConfirmed === true, 'Reveal RPC did not return a confirmed self projection.')
  await rpcDenied(players[0], 'ms1a_confirm_role_reveal', {
    p_room_id: created.room.id,
    p_player_id: dealt.players[1].id,
  })
  const afterSingleConfirm = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: created.room.id })
  const ownConfirmRow = afterSingleConfirm.players.find((player) => player.id === firstConfirm.self.id)
  const otherConfirmRow = afterSingleConfirm.players.find((player) => player.id === joinResults[1].self.id)
  invariant(ownConfirmRow?.revealConfirmed === true, `Player could not confirm their own reveal (row=${JSON.stringify(ownConfirmRow && { seat: ownConfirmRow.seat, revealConfirmed: ownConfirmRow.revealConfirmed })}).`)
  invariant(otherConfirmRow?.revealConfirmed === false, `Player confirmed another Player reveal (row=${JSON.stringify(otherConfirmRow && { seat: otherConfirmRow.seat, revealConfirmed: otherConfirmRow.revealConfirmed })}).`)
  evidence.revealBoundary = true
  await Promise.all(players.slice(1, seatCount).map((client) => rpc(client, 'ms1a_confirm_role_reveal', { p_room_id: created.room.id })))
  const started = await rpc(moderator, 'ms1a_start_room', { p_room_id: created.room.id })
  invariant(started.room.status === 'IN_GAME' && started.room.phase === 'NIGHT', 'Start lifecycle sai.')
  const startedAgain = await rpc(moderator, 'ms1a_start_room', { p_room_id: created.room.id })
  invariant(startedAgain.room.id === created.room.id, 'Start idempotency sai.')
  evidence.flows[seatCount] = {
    players: beforeDeal.players.length,
    assignments: dealt.assignments.length,
    uniqueSeats: new Set(beforeDeal.players.map((player) => player.seat)).size,
    status: started.room.status,
  }

  if (seatCount === 7) {
    const playerA = players[0]
    const playerBId = dealt.players[1].id
    const own = await playerA.from('room_role_assignments').select('*').eq('room_id', created.room.id)
    invariant(!own.error && own.data.length === 1, 'Player không đọc được own role.')
    const other = await playerA.from('room_role_assignments').select('*').eq('room_id', created.room.id).eq('player_id', playerBId)
    invariant(!other.error && other.data.length === 0, 'Player đọc được role người khác.')
    const moderatorAssignments = await moderator.from('room_role_assignments').select('*').eq('room_id', created.room.id)
    invariant(!moderatorAssignments.error && moderatorAssignments.data.length === 7, 'Moderator không đọc đủ assignments.')
    const unrelatedAssignments = await unrelated.from('room_role_assignments').select('*').eq('room_id', created.room.id)
    invariant(!unrelatedAssignments.error && unrelatedAssignments.data.length === 0, 'Unrelated user đọc assignment.')
    const playerConfig = await playerA.from('room_role_config').select('*').eq('room_id', created.room.id)
    invariant(!playerConfig.error && playerConfig.data.length === 0, 'Player đọc role config.')
    const unrelatedRoom = await unrelated.from('rooms').select('*').eq('id', created.room.id)
    invariant(!unrelatedRoom.error && unrelatedRoom.data.length === 0, 'Unrelated user đọc room row.')
    const playerRoom = await playerA.from('rooms').select('*').eq('id', created.room.id)
    const playerRoster = await playerA.from('room_players').select('*').eq('room_id', created.room.id)
    const playerMembership = await playerA.from('room_memberships').select('*').eq('room_id', created.room.id)
    const moderatorConfig = await moderator.from('room_role_config').select('*').eq('room_id', created.room.id)
    const moderatorRoster = await moderator.from('room_players').select('*').eq('room_id', created.room.id)
    const unrelatedRoster = await unrelated.from('room_players').select('*').eq('room_id', created.room.id)
    const unrelatedMembership = await unrelated.from('room_memberships').select('*').eq('room_id', created.room.id)
    const unrelatedConfig = await unrelated.from('room_role_config').select('*').eq('room_id', created.room.id)
    invariant(!playerRoom.error && playerRoom.data.length === 1, 'Joined Player cannot read room row.')
    invariant(!playerRoster.error && playerRoster.data.length === 7, 'Joined Player cannot read public roster.')
    invariant(!playerMembership.error && playerMembership.data.length === 1, 'Player membership projection is not self-only.')
    invariant(!moderatorConfig.error && moderatorConfig.data.length === configured.length, 'Moderator cannot read role config.')
    invariant(!moderatorRoster.error && moderatorRoster.data.length === 7, 'Moderator cannot read roster.')
    invariant(!unrelatedRoster.error && unrelatedRoster.data.length === 0, 'Unrelated user can read roster.')
    invariant(!unrelatedMembership.error && unrelatedMembership.data.length === 0, 'Unrelated user can read memberships.')
    invariant(!unrelatedConfig.error && unrelatedConfig.data.length === 0, 'Unrelated user can read role config.')
    const ownPayload = await rpc(playerA, 'ms1a_get_player_room', { p_room_id: created.room.id })
    invariant(ownPayload.assignment?.playerId === ownPayload.self.id, 'Player projection không phải own role.')
    evidence.privacy = {
      ownRoles: own.data.length,
      otherRoles: other.data.length,
      moderatorRoles: moderatorAssignments.data.length,
      unrelatedRoles: unrelatedAssignments.data.length,
      playerRoleConfigRows: playerConfig.data.length,
      unrelatedRoomRows: unrelatedRoom.data.length,
    }

    evidence.rlsMatrix = {
      joinedPlayerRoomRows: playerRoom.data.length,
      joinedPlayerRosterRows: playerRoster.data.length,
      joinedPlayerMembershipRows: playerMembership.data.length,
      joinedPlayerAssignmentRows: own.data.length,
      joinedPlayerConfigRows: playerConfig.data.length,
      moderatorRosterRows: moderatorRoster.data.length,
      moderatorConfigRows: moderatorConfig.data.length,
      moderatorAssignmentRows: moderatorAssignments.data.length,
      unrelatedRoomRows: unrelatedRoom.data.length,
      unrelatedRosterRows: unrelatedRoster.data.length,
      unrelatedMembershipRows: unrelatedMembership.data.length,
      unrelatedConfigRows: unrelatedConfig.data.length,
      unrelatedAssignmentRows: unrelatedAssignments.data.length,
    }

    const beforeHostileDml = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: created.room.id })
    const mutationAttempts = [
      await playerA.from('rooms').update({ status: 'IN_GAME' }).eq('id', created.room.id),
      await playerA.schema('private').from('room_owners').update({ user_id: authenticatedUserIds[1] }).eq('room_id', created.room.id),
      await playerA.from('room_players').insert({
        room_id: created.room.id,
        seat_number: 16,
        display_name: 'Fake Player',
        normalized_name: 'fake player',
      }),
      await playerA.from('room_players').update({ seat_number: 16 }).eq('id', ownPayload.self.id),
      await playerA.from('room_players').update({ display_name: 'Hijacked' }).eq('id', playerBId),
      await playerA.from('room_memberships').insert({
        room_id: created.room.id,
        player_id: randomUUID(),
        user_id: authenticatedUserIds[1],
      }),
      await playerA.from('room_role_assignments').insert({ room_id: created.room.id, player_id: ownPayload.self.id, role_id: 'werewolf' }),
      await playerA.from('room_role_assignments').update({ role_id: 'werewolf' }).eq('room_id', created.room.id),
      await playerA.from('room_role_assignments').delete().eq('room_id', created.room.id),
    ]
    invariant(mutationAttempts.every((attempt) => Boolean(attempt.error)), 'Direct DML không bị deny.')
    const afterHostileDml = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: created.room.id })
    invariant(JSON.stringify(afterHostileDml) === JSON.stringify(beforeHostileDml), 'Denied direct DML changed server truth.')
    evidence.directDmlDenied = true
    evidence.lifecycleAuthority = true
  }
}

const lastSeatRoom = await createRoom(moderator, 7)
for (let index = 0; index < 6; index += 1) {
  await join(players[index], lastSeatRoom.room.code, `Final-${testRun}-${index}`)
}
const finalRace = await Promise.allSettled([
  join(players[6], lastSeatRoom.room.code, `Final-${testRun}-A`),
  join(players[7], lastSeatRoom.room.code, `Final-${testRun}-B`),
])
const finalSnapshot = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: lastSeatRoom.room.id })
const finalLoser = finalRace[0].status === 'rejected' ? players[6] : players[7]
const finalLoserMembership = await finalLoser.from('room_memberships').select('*').eq('room_id', lastSeatRoom.room.id)
invariant(finalRace.filter((result) => result.status === 'fulfilled').length === 1, 'Final-seat race không có đúng một success.')
invariant(finalRace.some((result) => result.status === 'rejected' && result.reason.message.endsWith(':ROOM_FULL')), 'Final-seat loser không nhận ROOM_FULL.')
invariant(finalSnapshot.players.length === 7, 'Final-seat persisted capacity sai.')
invariant(!finalLoserMembership.error && finalLoserMembership.data.length === 0, 'Final-seat loser received a ghost membership.')
evidence.finalSeat = { successes: 1, roomFull: true, persistedPlayers: 7, ghostMemberships: 0 }

const duplicateRoom = await createRoom(moderator, 7)
const duplicateRace = await Promise.allSettled([
  join(players[0], duplicateRoom.room.code, 'Bảo Châu'),
  join(players[1], duplicateRoom.room.code, '  bảo   châu  '),
])
const duplicateSnapshot = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: duplicateRoom.room.id })
const duplicateLoser = duplicateRace[0].status === 'rejected' ? players[0] : players[1]
const duplicateLoserMembership = await duplicateLoser.from('room_memberships').select('*').eq('room_id', duplicateRoom.room.id)
invariant(duplicateRace.filter((result) => result.status === 'fulfilled').length === 1, 'Duplicate-name race không có đúng một success.')
invariant(duplicateRace.some((result) => result.status === 'rejected' && result.reason.message.endsWith(':DUPLICATE_NAME')), 'Duplicate-name loser không bị từ chối.')
invariant(duplicateSnapshot.players.length === 1, 'Duplicate normalized name persist hai Player.')
invariant(!duplicateLoserMembership.error && duplicateLoserMembership.data.length === 0, 'Duplicate-name loser received a ghost membership.')
await rpcFailure(players[2], 'ms1a_join_room', {
  p_code: duplicateRoom.room.code,
  p_display_name: '123456789012345678901',
}, 'INVALID_NAME')
evidence.duplicateName = { successes: 1, duplicateRejected: true, persistedPlayers: 1, ghostMemberships: 0, maxLengthEnforced: true }

const unrelatedOwnedRoom = await createRoom(unrelated, 7)
for (let index = 8; index < 15; index += 1) {
  await join(players[index], unrelatedOwnedRoom.room.code, `Other-${testRun}-${index}`)
}
await rpc(unrelated, 'ms1a_lock_and_assign_roles', { p_room_id: unrelatedOwnedRoom.room.id })
const moderatorOtherRoom = await moderator.from('rooms').select('*').eq('id', unrelatedOwnedRoom.room.id)
const moderatorOtherAssignments = await moderator.from('room_role_assignments').select('*').eq('room_id', unrelatedOwnedRoom.room.id)
invariant(!moderatorOtherRoom.error && moderatorOtherRoom.data.length === 0, 'Moderator can read an unrelated room row.')
invariant(!moderatorOtherAssignments.error && moderatorOtherAssignments.data.length === 0, 'Moderator can read assignments from an unrelated room.')
evidence.rlsMatrix.moderatorUnrelatedRoomRows = moderatorOtherRoom.data.length
evidence.rlsMatrix.moderatorUnrelatedAssignmentRows = moderatorOtherAssignments.data.length

async function browserContextProof() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate))
  invariant(executablePath, 'Không tìm thấy Chrome/Edge cho cross-context QA.')
  const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const address = server.httpServer?.address()
  invariant(address && typeof address !== 'string', 'Vite remote QA server không khởi động.')
  const origin = `http://127.0.0.1:${address.port}`
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms1a-remote-'))
  const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, args: ['--no-sandbox', '--disable-gpu', '--no-first-run'] })
  try {
    const moderatorContext = await browser.createBrowserContext()
    const playerContext = await browser.createBrowserContext()
    const moderatorPage = await moderatorContext.newPage()
    const playerPage = await playerContext.newPage()
    for (const page of [moderatorPage, playerPage]) page.setDefaultTimeout(30_000)
    await moderatorPage.goto(origin, { waitUntil: 'domcontentloaded' })
    await moderatorPage.click('.entry-actions a:first-child')
    await moderatorPage.waitForSelector('.create-room-footer .button.primary')
    await moderatorPage.click('.create-room-footer .button.primary')
    await moderatorPage.waitForSelector('.lobby-moderator')
    const code = (await moderatorPage.$eval('.lobby-heading h1', (node) => node.textContent)).replace(/\D/g, '')
    invariant(/^\d{6}$/.test(code), 'Browser Moderator không nhận code sáu số.')
    await playerPage.goto(origin, { waitUntil: 'domcontentloaded' })
    await playerPage.click('.entry-actions a:nth-child(2)')
    await playerPage.waitForSelector('.join-card form')
    await playerPage.type('input[aria-label="Mã phòng gồm 6 chữ số"]', code)
    await playerPage.click('.join-card form button')
    await playerPage.waitForSelector('.name-modal')
    await playerPage.type('.name-modal input', `Browser-${testRun}`)
    await playerPage.click('.name-modal .button.primary')
    await playerPage.waitForSelector('[data-surface="lobby"]')
    await moderatorPage.waitForFunction(() => document.querySelector('.lobby-count strong')?.textContent?.includes('1 / 7'))
    const authStorageCounts = await Promise.all([moderatorPage, playerPage].map((page) => page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('auth-token')).length)))
    invariant(authStorageCounts.every((count) => count === 1), 'Browser context không persist anonymous session riêng.')
    const readBrowserIdentity = (page) => page.evaluate(() => {
      const key = Object.keys(localStorage).find((candidate) => candidate.includes('auth-token'))
      if (!key) return null
      const value = JSON.parse(localStorage.getItem(key))
      return value?.user?.id ?? value?.currentSession?.user?.id ?? value?.session?.user?.id ?? null
    })
    const initialIdentity = await readBrowserIdentity(playerPage)
    const initialSeat = await playerPage.$eval('.player-identity strong', (node) => node.textContent)
    invariant(typeof initialIdentity === 'string' && initialIdentity.length > 0, 'Player browser identity is missing.')

    await playerPage.reload({ waitUntil: 'domcontentloaded' })
    await playerPage.waitForSelector('[data-surface="lobby"]')
    invariant(await readBrowserIdentity(playerPage) === initialIdentity, 'Lobby refresh changed anonymous identity.')
    invariant(await playerPage.$eval('.player-identity strong', (node) => node.textContent) === initialSeat, 'Lobby refresh changed stable seat.')

    const roomId = new URL(moderatorPage.url()).searchParams.get('room')
    invariant(roomId, 'Browser Moderator URL is missing room id.')
    for (let index = 0; index < 6; index += 1) {
      await join(players[index], code, `BF-${testRun}-${index + 1}`)
    }
    await moderatorPage.waitForFunction(() => document.querySelector('.lobby-count strong')?.textContent?.includes('7 / 7'))
    await moderatorPage.click('.lobby-control-panel .button.primary')
    await playerPage.waitForSelector('[data-surface="reveal"]')
    const revealedRole = await playerPage.$eval('.role-identity-caption strong', (node) => node.textContent)

    await playerPage.reload({ waitUntil: 'domcontentloaded' })
    await playerPage.waitForSelector('[data-surface="reveal"]')
    invariant(await readBrowserIdentity(playerPage) === initialIdentity, 'Role-reveal refresh changed anonymous identity.')
    invariant(await playerPage.$eval('.player-identity strong', (node) => node.textContent) === initialSeat, 'Role-reveal refresh changed stable seat.')
    invariant(await playerPage.$eval('.role-identity-caption strong', (node) => node.textContent) === revealedRole, 'Role-reveal refresh changed private role.')

    await playerPage.click('.role-identity-surface .button.primary')
    await Promise.all(players.slice(0, 6).map((client) => rpc(client, 'ms1a_confirm_role_reveal', { p_room_id: roomId })))
    await moderatorPage.waitForFunction(() => {
      const button = document.querySelector('.reveal-readiness .button.primary')
      return button && !button.disabled
    })
    await moderatorPage.click('.reveal-readiness .button.primary')
    await playerPage.waitForSelector('[data-surface="neutral"]')

    await playerPage.reload({ waitUntil: 'domcontentloaded' })
    await playerPage.waitForSelector('[data-surface="neutral"]')
    invariant(await readBrowserIdentity(playerPage) === initialIdentity, 'IN_GAME refresh changed anonymous identity.')
    invariant(await playerPage.$eval('.player-identity strong', (node) => node.textContent) === initialSeat, 'IN_GAME refresh changed stable seat.')
    await playerPage.click('.quiet-action')
    await playerPage.waitForSelector('[data-surface="recheck"]')
    invariant(await playerPage.$eval('.role-identity-caption strong', (node) => node.textContent) === revealedRole, 'IN_GAME role re-check changed private role.')

    const localRegistryBeforeFailure = await playerPage.evaluate(() => localStorage.getItem('masoi.ms0b.rooms.v1'))
    invariant(localRegistryBeforeFailure === null, 'Remote product flow created a local room registry.')
    await playerPage.setOfflineMode(true)
    const offlineResult = await playerPage.evaluate(async () => {
      const { createConfiguredRoomTransport } = await import('/src/transport/create-room-transport.ts')
      const transport = createConfiguredRoomTransport(null)
      return Promise.race([
        transport.validateRoomCode('000000'),
        new Promise((resolve) => setTimeout(() => resolve({ reason: 'TIMEOUT' }), 10_000)),
      ])
    })
    await playerPage.setOfflineMode(false)
    invariant(offlineResult.reason === 'BACKEND_UNAVAILABLE' && typeof offlineResult.message === 'string', 'Remote outage did not fail visibly.')
    const localRegistryAfterFailure = await playerPage.evaluate(() => localStorage.getItem('masoi.ms0b.rooms.v1'))
    invariant(localRegistryAfterFailure === null, 'Remote outage silently fell back to LocalRoomTransport.')

    await moderatorContext.close()
    await playerContext.close()
    return {
      isolatedBrowserContexts: 2,
      moderatorRealtimeRoster: '7 / 7',
      playerReachedLobby: true,
      refreshIdentityStable: true,
      refreshSeatStable: true,
      refreshRoleStable: true,
      refreshLifecycleStates: ['LOBBY', 'ROLE_REVEAL', 'IN_GAME'],
      remoteFailureVisible: true,
      silentLocalFallback: false,
    }
  } finally {
    await browser.close()
    await server.close()
  }
}

evidence.crossContext = await browserContextProof()
for (const client of [moderator, ...players, unrelated]) {
  client.realtime.disconnect()
}
console.log('MS-1A SUPABASE REMOTE QA PASS')
console.log(JSON.stringify(evidence, null, 2))
