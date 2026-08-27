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
  'MS-1H1 QA is intentionally local-only.',
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
  'half-wolf': 1,
  traitor: 1,
  cupid: 1,
  fool: 1,
  villager: 2,
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
    p_display_name: `H1-${index + 1}`,
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
  {
    id: assignment.playerId,
    client: playerClients[playerIndexById[assignment.playerId]],
  },
]))
const clientByPlayerId = Object.fromEntries(snapshot.players.map((player, index) => [
  player.id,
  playerClients[index],
]))

// Establish the relationship and runtime-transition truth through existing E/F authority.
await rpc(moderator, 'ms1g2_open_cupid_call', { p_room_id: roomId })
await rpc(actorByRole.cupid.client, 'ms1g2_submit_cupid_pairing', {
  p_room_id: roomId,
  p_first_target_player_id: actorByRole['half-wolf'].id,
  p_second_target_player_id: actorByRole.traitor.id,
})
await rpc(moderator, 'ms1g2_open_night_role_call', { p_room_id: roomId, p_role_id: 'werewolf' })
for (const actor of [actorByRole.werewolf, actorByRole.traitor]) {
  await rpc(actor.client, 'ms1g2_submit_wolf_ballot', {
    p_room_id: roomId,
    p_target_player_id: actorByRole['half-wolf'].id,
  })
  await rpc(actor.client, 'ms1g2_confirm_wolf_ballot', { p_room_id: roomId })
}
await rpc(moderator, 'ms1g2_finalize_wolf_round', { p_room_id: roomId })
await rpc(moderator, 'ms1g2_resolve_night_effects', { p_room_id: roomId })
await rpc(moderator, 'ms1g2_finalize_night_checkpoint', { p_room_id: roomId })
await rpc(moderator, 'ms1g2_start_morning', { p_room_id: roomId })

// No-hang Day 1 reaches the real Night 2 transition, transforming Half-Wolf.
await rpc(moderator, 'ms1g2_start_day_vote', { p_room_id: roomId })
localSql(`update private.day_vote_rounds set opened_at = statement_timestamp() - interval '31 seconds', deadline_at = statement_timestamp() - interval '1 second' where room_id = ${sqlUuid(roomId)};`)
await rpc(moderator, 'ms1g2_resolve_day_vote', { p_room_id: roomId })
await rpc(moderator, 'ms1g2_start_next_night', { p_room_id: roomId })
invariant(
  localSql(`select status from private.half_wolf_transitions where room_id = ${sqlUuid(roomId)} and player_id = ${sqlUuid(actorByRole['half-wolf'].id)};`) === 'TRANSFORMED',
  'Half-Wolf runtime truth is not transformed before final reveal fixture.',
)

// Focused H1 fixture: the projection consumes an existing authoritative conversion row.
localSql(`insert into private.traitor_faction_transitions (
  room_id, player_id, converted_night_number, conversion_reason
) values (
  ${sqlUuid(roomId)}, ${sqlUuid(actorByRole.traitor.id)}, 2,
  'NO_LIVING_BITE_CAPABLE_WOLF'
) on conflict (room_id, player_id) do nothing;`)
localSql(`update public.rooms set phase = 'DAY', revision = revision + 1 where id = ${sqlUuid(roomId)};`)
await rpc(moderator, 'ms1g2_start_day_vote', { p_room_id: roomId })
const foolId = actorByRole.fool.id
const voter = snapshot.players.find((player) => player.id !== foolId)
await rpc(clientByPlayerId[voter.id], 'ms1g2_cast_day_vote', {
  p_room_id: roomId,
  p_target_player_id: foolId,
})
localSql(`update private.day_vote_rounds set opened_at = statement_timestamp() - interval '31 seconds', deadline_at = statement_timestamp() - interval '1 second' where room_id = ${sqlUuid(roomId)};`)

for (const client of playerClients) {
  const before = await rpc(client, 'ms1a_get_player_room', { p_room_id: roomId })
  invariant(before.endMatch === null || before.endMatch === undefined, 'Final roster leaked before FINISHED.')
}

const realtimePayloads = []
const signalChannel = moderator
  .channel(`room:${roomId}`, { config: { private: true } })
  .on('broadcast', { event: 'room_changed' }, (payload) => realtimePayloads.push(payload))
await subscribe(signalChannel)

const executablePath = browserExecutable()
invariant(executablePath, 'Chrome/Edge is required for all-device END_MATCH QA.')
process.env.VITE_SUPABASE_URL = url
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = key
const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const address = server.httpServer?.address()
invariant(address && typeof address !== 'string', 'Vite H1 QA server did not start.')
const origin = `http://127.0.0.1:${address.port}`
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms1h1-qa-'))
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  userDataDir: profile,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})
const contexts = []
const pageErrors = []

async function openAuthorizedPage(session, destination, viewport) {
  const context = await browser.createBrowserContext()
  contexts.push(context)
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  await page.setViewport(viewport)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.evaluateOnNewDocument(({ storageKey, authSession }) => {
    localStorage.setItem(storageKey, JSON.stringify(authSession))
  }, { storageKey: moderator.auth.storageKey, authSession: session })
  await page.goto(`${origin}/${destination}`, { waitUntil: 'networkidle0' })
  return page
}

let moderatorPage
let playerPages = []
let viewportEvidence
try {
  moderatorPage = await openAuthorizedPage(
    identities[0].session,
    `?room=${encodeURIComponent(roomId)}&as=moderator`,
    { width: 1440, height: 900 },
  )
  playerPages = await Promise.all(playerClients.map((_, index) =>
    openAuthorizedPage(
      identities[index + 1].session,
      `?room=${encodeURIComponent(roomId)}&player=${encodeURIComponent(snapshot.players[index].id)}`,
      { width: 390, height: 844 },
    )))
  invariant(await moderatorPage.$('.moderator-end-match') === null, 'Moderator saw END_MATCH before FINISHED.')
  for (const page of playerPages) {
    invariant(await page.$('[data-surface="end-match-result"]') === null, 'Player saw END_MATCH before FINISHED.')
  }

  const finished = await rpc(moderator, 'ms1g2_resolve_day_vote', { p_room_id: roomId })
  invariant(finished.matchResult?.outcome === 'FOOL', 'Authoritative Fool outcome was not persisted.')
  await moderatorPage.waitForSelector('.moderator-end-match')
  await Promise.all(playerPages.map((page) => page.waitForSelector('[data-surface="end-match-result"]')))

  const resultLabels = await Promise.all(playerPages.map((page) =>
    page.$eval('.end-result-copy h1', (node) => node.textContent?.trim())))
  invariant(resultLabels.every((label) => label === 'THẰNG NGỐ CHIẾN THẮNG'), 'Connected Players disagree on FOOL result copy.')
  for (const page of playerPages) {
    invariant(await page.$('.player-action, .day-vote-player, .role-identity-surface') === null, 'A stale gameplay surface remained active after FINISHED.')
    const terminalText = await page.$eval('[data-player-viewport]', (node) => node.textContent ?? '')
    invariant(!/Chơi lại|Play Again/i.test(terminalText), 'END_MATCH exposed a replay action.')
    invariant(await page.$('.end-match-player img') === null, 'END_MATCH used card artwork.')
  }

  const authorized = await Promise.all(playerClients.map((client) =>
    rpc(client, 'ms1a_get_player_room', { p_room_id: roomId })))
  invariant(authorized.every((payload) => payload.endMatch?.outcome === 'FOOL'), 'Authorized Players did not receive the same result.')
  invariant(authorized.every((payload) => payload.endMatch?.roster?.length === 7), 'Authorized final roster is incomplete.')
  const finalRoster = authorized[0].endMatch.roster
  invariant(finalRoster.find((entry) => entry.player.id === actorByRole['half-wolf'].id)?.roleId === 'half-wolf', 'Original Half-Wolf role was rewritten.')
  invariant(finalRoster.find((entry) => entry.player.id === actorByRole['half-wolf'].id)?.runtimeNote === 'HALF_WOLF_TRANSFORMED', 'Transformed Half-Wolf runtime note is missing.')
  invariant(finalRoster.find((entry) => entry.player.id === actorByRole.traitor.id)?.roleId === 'traitor', 'Original Traitor role was rewritten.')
  invariant(finalRoster.find((entry) => entry.player.id === actorByRole.traitor.id)?.runtimeNote === 'TRAITOR_CONVERTED_VILLAGE', 'Converted Traitor runtime note is missing.')
  invariant(finalRoster.find((entry) => entry.player.id === actorByRole['half-wolf'].id)?.loverPartnerPlayerId === actorByRole.traitor.id, 'Finished Lover relation is missing.')

  const revealPage = playerPages[0]
  await revealPage.click('.end-match-actions .button.primary')
  await revealPage.waitForSelector('[data-surface="end-match-roster"]')
  invariant(await revealPage.$$eval('.final-roster-row', (rows) => rows.length) === 7, 'Seven-player final reveal is incomplete.')
  viewportEvidence = await revealPage.evaluate(() => {
    const root = document.querySelector('[data-player-viewport]')
    const controls = [...root.querySelectorAll('[data-required-control]')]
      .filter((element) => getComputedStyle(element).display !== 'none')
      .map((element) => element.getBoundingClientRect())
    const nestedScroll = [...root.querySelectorAll('*')].some((element) => {
      const style = getComputedStyle(element)
      return /^(auto|scroll)$/.test(style.overflowX) || /^(auto|scroll)$/.test(style.overflowY)
    })
    return {
      documentScroll: document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1,
      rootScroll: root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1,
      nestedScroll,
      minWidth: Math.min(...controls.map((rect) => rect.width)),
      minHeight: Math.min(...controls.map((rect) => rect.height)),
    }
  })
  invariant(!viewportEvidence.documentScroll && !viewportEvidence.rootScroll && !viewportEvidence.nestedScroll, 'Finished Player reveal scrolls.')
  invariant(viewportEvidence.minWidth >= 44 && viewportEvidence.minHeight >= 44, 'Finished Player controls are below 44x44.')

  await playerPages[1].reload({ waitUntil: 'networkidle0' })
  await playerPages[1].waitForSelector('[data-surface="end-match-result"]')

  const beforeHome = await rpc(playerClients[2], 'ms1a_get_player_room', { p_room_id: roomId })
  await playerPages[2].click('.end-match-actions a[href]')
  await playerPages[2].waitForSelector('[data-surface="landing"]')
  invariant(!new URL(playerPages[2].url()).searchParams.has('room'), 'Return Home retained the room route.')
  const afterHome = await rpc(playerClients[2], 'ms1a_get_player_room', { p_room_id: roomId })
  invariant(JSON.stringify(beforeHome.endMatch) === JSON.stringify(afterHome.endMatch), 'Return Home mutated terminal server state.')

  await rpcFailure(outsider, 'ms1a_get_player_room', { p_room_id: roomId }, 'UNAUTHORIZED')
  await rpcFailure(outsider, 'ms1a_get_moderator_room', { p_room_id: roomId }, 'NOT_MODERATOR')
  await rpcFailure(moderator, 'ms1g2_start_day_vote', { p_room_id: roomId }, 'MATCH_FINISHED')
  await rpcFailure(clientByPlayerId[voter.id], 'ms1g2_cast_day_vote', {
    p_room_id: roomId, p_target_player_id: foolId,
  }, 'MATCH_FINISHED')
  await rpcFailure(moderator, 'ms1g2_open_night_role_call', {
    p_room_id: roomId, p_role_id: 'werewolf',
  }, 'MATCH_FINISHED')
  const beforeTerminalRetry = await rpc(moderator, 'ms1a_get_moderator_room', { p_room_id: roomId })
  const terminalRetry = await rpc(moderator, 'ms1g2_start_next_night', { p_room_id: roomId })
  invariant(terminalRetry.room.status === 'FINISHED' && terminalRetry.matchResult?.outcome === 'FOOL', 'Terminal Next Night retry did not remain FINISHED.')
  invariant(terminalRetry.room.dayNumber === beforeTerminalRetry.room.dayNumber && terminalRetry.room.revision === beforeTerminalRetry.room.revision, 'Terminal Next Night retry mutated lifecycle truth.')

  const directRead = await playerClients[0].schema('private').from('match_results').select('*')
  invariant(Boolean(directRead.error), 'Player directly read private terminal truth.')
  const directWrite = await playerClients[0].from('rooms').update({ status: 'FINISHED' }).eq('id', roomId)
  invariant(Boolean(directWrite.error), 'Player directly mutated room terminal truth.')
  const repeatA = await rpc(playerClients[0], 'ms1a_get_player_room', { p_room_id: roomId })
  const repeatB = await rpc(playerClients[0], 'ms1a_get_player_room', { p_room_id: roomId })
  invariant(JSON.stringify(repeatA.endMatch) === JSON.stringify(repeatB.endMatch), 'Repeated FINISHED projection diverged.')
} finally {
  for (const context of contexts) await context.close().catch(() => {})
  await browser.close().catch(() => {})
  await server.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
}

await new Promise((resolve) => setTimeout(resolve, 250))
for (const payload of realtimePayloads) {
  invariant(
    !JSON.stringify(payload).match(/roleId|role_id|outcome|subject|roster|lover|half.wolf|traitor/i),
    'Generic Realtime payload leaked final reveal truth.',
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
  scope: 'MS-1H1 LOCAL Supabase + browser',
  rooms: 1,
  identities: 9,
  connectedDevices: '1 Moderator + 7 Players transitioned to END_MATCH',
  outcome: 'FOOL',
  finalReveal: 'original roles + Half-Wolf/Traitor runtime notes + Lovers',
  refresh: 'FINISHED restored END_MATCH',
  returnHome: 'Landing; terminal server state unchanged',
  privacy: 'pre-FINISHED hidden; unrelated denied; private DML/read denied; generic signal secret-free',
  viewport390x844: viewportEvidence,
  realtimeSignalsObserved: realtimePayloads.length,
}, null, 2))
process.exit(0)
