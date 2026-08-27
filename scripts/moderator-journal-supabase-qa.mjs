import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

invariant(
  process.argv.includes('--local') && !process.argv.includes('--remote'),
  'MS-1H2 QA is intentionally local-only.',
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
  invariant(!result.error && result.data.user?.id && result.data.session, `Anonymous Auth failed: ${result.error?.message}`)
  return { userId: result.data.user.id, session: result.data.session }
}

async function rpc(client, name, args = undefined) {
  const result = await client.rpc(name, args)
  if (result.error) throw new Error(`${name}:${result.error.message}`)
  return result.data
}

async function rpcFailure(client, name, args, expected) {
  const result = await client.rpc(name, args)
  invariant(Boolean(result.error), `${name} unexpectedly succeeded.`)
  if (expected) {
    invariant(result.error.message === expected, `${name}: expected ${expected}, got ${result.error.message}`)
  }
}

function browserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

async function subscribe(channel) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Realtime subscribe timeout.')), 10_000)
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timeout)
        resolve()
      }
    })
  })
}

const moderator = isolatedClient()
const playerClients = Array.from({ length: 7 }, () => isolatedClient())
const outsider = isolatedClient()
const clients = [moderator, ...playerClients, outsider]
const identities = await Promise.all(clients.map(authenticate))
invariant(new Set(identities.map(({ userId }) => userId)).size === 9, 'Local identities are not isolated.')

const roleConfig = {
  werewolf: 1,
  'serial-killer': 1,
  protector: 1,
  seer: 1,
  witch: 1,
  fool: 1,
  villager: 1,
}
const created = await rpc(moderator, 'ms1a_create_room', {
  p_request_id: randomUUID(),
  p_seat_count: 7,
  p_role_config: roleConfig,
  p_wolf_policy: 'RANDOM_ON_TIE',
})
const roomId = created.room.id
for (let index = 0; index < playerClients.length; index += 1) {
  await rpc(playerClients[index], 'ms1a_join_room', {
    p_code: created.room.code,
    p_display_name: `H2-${index + 1}`,
  })
}
await rpc(moderator, 'ms1a_lock_and_assign_roles', { p_room_id: roomId })
await Promise.all(playerClients.map((client) =>
  rpc(client, 'ms1a_confirm_role_reveal', { p_room_id: roomId })))
await rpc(moderator, 'ms1g2_start_room', { p_room_id: roomId })

let snapshot = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: roomId })
const playerIndexById = Object.fromEntries(snapshot.players.map((player, index) => [player.id, index]))
const actorByRole = Object.fromEntries(snapshot.assignments.map((assignment) => [
  assignment.roleId,
  { id: assignment.playerId, client: playerClients[playerIndexById[assignment.playerId]] },
]))
const clientByPlayerId = Object.fromEntries(snapshot.players.map((player, index) => [
  player.id, playerClients[index],
]))
const protectedTarget = actorByRole.villager.id
const rescuedTarget = actorByRole.fool.id

await rpc(moderator, 'ms1g2_open_night_role_call', { p_room_id: roomId, p_role_id: 'protector' })
await rpc(actorByRole.protector.client, 'ms1g2_submit_protector_target', {
  p_room_id: roomId, p_target_player_id: protectedTarget,
})
await rpc(moderator, 'ms1g2_open_night_role_call', { p_room_id: roomId, p_role_id: 'werewolf' })
await rpc(actorByRole.werewolf.client, 'ms1g2_submit_wolf_ballot', {
  p_room_id: roomId, p_target_player_id: protectedTarget,
})
await rpc(actorByRole.werewolf.client, 'ms1g2_confirm_wolf_ballot', { p_room_id: roomId })
await rpc(moderator, 'ms1g2_finalize_wolf_round', { p_room_id: roomId })
await rpc(moderator, 'ms1g2_open_night_role_call', { p_room_id: roomId, p_role_id: 'seer' })
await rpc(actorByRole.seer.client, 'ms1g2_submit_seer_inspection', {
  p_room_id: roomId, p_target_player_id: actorByRole.werewolf.id,
})
await rpc(actorByRole.seer.client, 'ms1g2_acknowledge_seer_result', { p_room_id: roomId })
await rpc(moderator, 'ms1g2_open_serial_killer_call', { p_room_id: roomId })
await rpc(actorByRole['serial-killer'].client, 'ms1g2_submit_serial_killer_intent', {
  p_room_id: roomId, p_target_player_id: rescuedTarget,
})
await rpc(actorByRole['serial-killer'].client, 'ms1g2_confirm_serial_killer_intent', { p_room_id: roomId })
await rpc(moderator, 'ms1g2_resolve_night_effects', { p_room_id: roomId })

snapshot = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: roomId })
const nightFacts = snapshot.moderatorJournal?.facts ?? []
invariant(nightFacts.some((fact) => fact.kind === 'WOLF_FINAL_TARGET' && fact.targetName), 'Wolf resolved target is absent from Journal.')
invariant(nightFacts.some((fact) => fact.kind === 'WOLF_ATTACK_CREATED' && fact.resolution === 'BLOCKED_BY_PROTECTOR'), 'Protector-blocked Wolf attack is absent from Journal.')
invariant(nightFacts.some((fact) => fact.kind === 'SERIAL_KILLER_ATTACK_CREATED' && fact.targetName), 'Serial Killer attack is absent from Journal.')
invariant(nightFacts.some((fact) => fact.kind === 'SEER_INSPECTION' && fact.resolution === 'WOLF'), 'Authoritative Seer truth is absent from Journal.')

const playerProjection = await rpc(playerClients[0], 'ms1a_get_player_room', { p_room_id: roomId })
invariant(!Object.hasOwn(playerProjection, 'moderatorJournal'), 'Player projection leaked Moderator Journal.')
await rpcFailure(playerClients[0], 'ms1a_get_moderator_room', { p_room_id: roomId }, 'NOT_MODERATOR')
await rpcFailure(outsider, 'ms1a_get_moderator_room', { p_room_id: roomId }, 'NOT_MODERATOR')
const directRead = await playerClients[0].schema('private').from('gameplay_events').select('*')
invariant(Boolean(directRead.error), 'Player directly read private gameplay history.')
const directWrite = await playerClients[0].schema('private').from('gameplay_events').insert({
  room_id: roomId, night_number: 1, event_type: 'MATCH_FINISHED', resolution: 'WOLF',
})
invariant(Boolean(directWrite.error), 'Player forged a private gameplay event.')
const directHelper = await playerClients[0].schema('private').rpc('ms1h2_moderator_journal_payload', {
  p_room_id: roomId,
})
invariant(Boolean(directHelper.error), 'Player directly executed the private Journal helper.')

const repeatedNight = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: roomId })
invariant(
  JSON.stringify(snapshot.moderatorJournal) === JSON.stringify(repeatedNight.moderatorJournal),
  'Repeated Journal fetch changed order or duplicated facts.',
)

const realtimePayloads = []
const signalChannel = moderator
  .channel(`room:${roomId}`, { config: { private: true } })
  .on('broadcast', { event: 'room_changed' }, (payload) => realtimePayloads.push(payload))
await subscribe(signalChannel)

const executablePath = browserExecutable()
invariant(executablePath, 'Chrome/Edge is required for Moderator Journal UI QA.')
process.env.VITE_SUPABASE_URL = url
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = key
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const address = server.httpServer?.address()
invariant(address && typeof address !== 'string', 'Vite H2 QA server did not start.')
const origin = `http://127.0.0.1:${address.port}`
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms1h2-qa-'))
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  userDataDir: profile,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})
const contexts = []
const pageErrors = []

async function openAuthorizedPage(session, destination) {
  const context = await browser.createBrowserContext()
  contexts.push(context)
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.evaluateOnNewDocument(({ storageKey, authSession }) => {
    localStorage.setItem(storageKey, JSON.stringify(authSession))
  }, { storageKey: moderator.auth.storageKey, authSession: session })
  await page.goto(`${origin}/${destination}`, { waitUntil: 'networkidle0' })
  return page
}

let moderatorPage
let playerPage
let nightJournalCopy
let finalJournalCopy
try {
  moderatorPage = await openAuthorizedPage(
    identities[0].session,
    `?room=${encodeURIComponent(roomId)}&as=moderator`,
  )
  playerPage = await openAuthorizedPage(
    identities[1].session,
    `?room=${encodeURIComponent(roomId)}&player=${encodeURIComponent(snapshot.players[0].id)}`,
  )
  invariant(await moderatorPage.$eval('.local-badge', (node) => node.textContent?.includes('SERVER')), 'Moderator browser used local transport fallback.')
  invariant(!(await playerPage.$eval('body', (node) => node.textContent?.includes('Nhật ký'))), 'Player UI exposed a Journal entry point.')
  await moderatorPage.click('.phase-heading-actions .button')
  await moderatorPage.waitForSelector('.moderator-journal-view')
  nightJournalCopy = await moderatorPage.$eval('.moderator-journal-view', (node) => node.textContent ?? '')
  invariant(nightJournalCopy.includes('ĐÊM 1'), 'Night Journal grouping is missing.')
  invariant(nightJournalCopy.includes('Tiên Tri soi'), 'Journal UI omitted Seer narrative.')
  invariant(nightJournalCopy.includes('bị Bảo Vệ chặn'), 'Journal UI omitted Protector narrative.')
  await moderatorPage.click('.moderator-journal-heading .button')

  await rpc(moderator, 'ms1g2_open_witch_call', { p_room_id: roomId })
  await rpc(actorByRole.witch.client, 'ms1g2_submit_witch_decision', {
    p_room_id: roomId,
    p_resurrection_target_id: rescuedTarget,
    p_poison_target_id: null,
  })
  await rpc(moderator, 'ms1g2_finalize_night_checkpoint', { p_room_id: roomId })
  await rpc(moderator, 'ms1g2_start_morning', { p_room_id: roomId })
  await rpc(moderator, 'ms1g2_start_day_vote', { p_room_id: roomId })
  const voter = snapshot.players.find((player) => player.id !== rescuedTarget)
  await rpc(clientByPlayerId[voter.id], 'ms1g2_cast_day_vote', {
    p_room_id: roomId, p_target_player_id: rescuedTarget,
  })
  localSql(`update private.day_vote_rounds set opened_at = statement_timestamp() - interval '31 seconds', deadline_at = statement_timestamp() - interval '1 second' where room_id = ${sqlUuid(roomId)};`)
  const finished = await rpc(moderator, 'ms1g2_resolve_day_vote', { p_room_id: roomId })
  invariant(finished.matchResult?.outcome === 'FOOL', 'Focused Journal fixture did not finish through Fool hanging.')

  await moderatorPage.waitForSelector('.moderator-end-match')
  await playerPage.waitForSelector('[data-surface="end-match-result"]')
  await moderatorPage.click('.moderator-end-actions .button.secondary')
  await moderatorPage.waitForSelector('.moderator-journal-view')
  finalJournalCopy = await moderatorPage.$eval('.moderator-journal-view', (node) => node.textContent ?? '')
  invariant(finalJournalCopy.includes('NGÀY 1'), 'Day Journal grouping is missing.')
  invariant(finalJournalCopy.includes('KẾT QUẢ'), 'Final Journal grouping is missing.')
  invariant(finalJournalCopy.includes('Thằng Ngố chiến thắng'), 'Journal did not consume persisted Fool outcome.')
  invariant(finalJournalCopy.includes('hồi sinh') && !finalJournalCopy.includes(`${snapshot.players.find((player) => player.id === rescuedTarget).displayName} chết trong Đêm`), 'Witch rescue narrative falsely finalized the rescued victim.')
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  await browser.close().catch(() => {})
  await server.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
}

const finalSnapshot = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: roomId })
const finalFacts = finalSnapshot.moderatorJournal.facts
invariant(finalFacts.some((fact) => fact.kind === 'WITCH_RESURRECTION_USED'), 'Witch rescue fact is missing.')
invariant(!finalFacts.some((fact) => fact.kind === 'NIGHT_DEATH_FINALIZED' && fact.targetName === snapshot.players.find((player) => player.id === rescuedTarget).displayName), 'Rescued victim was falsely journaled as final-dead.')
invariant(finalFacts.some((fact) => fact.kind === 'DAY_VOTE_RESOLVED' && fact.totals?.[0]?.total === 1), 'Authoritative weighted Day total is missing.')
invariant(finalFacts.some((fact) => fact.kind === 'DAY_HANGING_CREATED'), 'Day hanging is missing.')
invariant(finalFacts.some((fact) => fact.kind === 'MATCH_FINISHED' && fact.resolution === 'FOOL'), 'Persisted final result is missing.')
const finalAgain = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: roomId })
invariant(JSON.stringify(finalSnapshot.moderatorJournal) === JSON.stringify(finalAgain.moderatorJournal), 'Finished Journal is not durable/idempotent.')
invariant(finalSnapshot.moderatorJournal.facts.every((fact, index, facts) => index === 0 || fact.occurredAt >= facts[index - 1].occurredAt), 'Journal chronology is unstable.')

await new Promise((resolve) => setTimeout(resolve, 250))
const secretRealtimeKeys = new Set([
  'moderatorJournal', 'event_type', 'target_player_id', 'actor_player_id',
  'role_id', 'outcome_type', 'source_type', 'metadata',
  'loverPlayerIds', 'partnerName',
])
function secretRealtimeKeyPaths(value, parent = '') {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([keyName, child]) => {
    const keyPath = parent ? `${parent}.${keyName}` : keyName
    return [
      ...(secretRealtimeKeys.has(keyName) ? [keyPath] : []),
      ...secretRealtimeKeyPaths(child, keyPath),
    ]
  })
}
for (const payload of realtimePayloads) {
  const leakedKeyPaths = secretRealtimeKeyPaths(payload)
  invariant(
    leakedKeyPaths.length === 0,
    `Generic Realtime payload leaked Journal or gameplay secrets at ${leakedKeyPaths.join(', ')}.`,
  )
  invariant(payload.event === 'room_changed', 'Unexpected generic Realtime event type.')
  invariant(
    payload.payload?.schema === 'public' &&
      (payload.payload?.table === 'rooms' || payload.payload?.table === 'room_players'),
    'Generic Realtime signal exposed a private table.',
  )
}
invariant(pageErrors.length === 0, `Browser page exception: ${pageErrors.join(' | ')}`)

await moderator.removeChannel(signalChannel)
for (const client of clients) {
  await client.removeAllChannels()
  await client.auth.signOut()
}

console.log(JSON.stringify({
  result: 'PASS',
  scope: 'MS-1H2 local Supabase + Moderator browser',
  rooms: 1,
  identities: 9,
  chronology: ['ĐÊM 1', 'NGÀY 1', 'KẾT QUẢ'],
  authoritativeFacts: finalFacts.length,
  privacy: 'Moderator owner only; Player/unrelated/direct private access denied',
  dayVote: 'weighted totals only; no voter identities',
  refresh: 'repeated active/FINISHED projections stable and duplicate-free',
  realtime: 'generic signal secret-free',
  playerJournalUi: 'ABSENT',
  localTransportFallback: false,
  browserNarrative: {
    night: Boolean(nightJournalCopy),
    final: Boolean(finalJournalCopy),
  },
}, null, 2))
process.exit(0)
