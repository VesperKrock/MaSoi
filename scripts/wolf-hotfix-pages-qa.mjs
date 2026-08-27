import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

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

function browserExecutable() {
  return [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate))
}

function localEnvironment() {
  const command = process.platform === 'win32'
    ? [process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', 'npx supabase status -o env']]
    : ['npx', ['supabase', 'status', '-o', 'env']]
  const values = parseEnv(execFileSync(command[0], command[1], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }))
  return {
    url: values.API_URL,
    key: values.PUBLISHABLE_KEY ?? values.ANON_KEY,
  }
}

function remoteEnvironment() {
  const values = { ...process.env }
  if (fs.existsSync('.env.local')) {
    Object.assign(values, parseEnv(fs.readFileSync('.env.local', 'utf8')))
  }
  return {
    url: values.VITE_SUPABASE_URL,
    key: values.VITE_SUPABASE_PUBLISHABLE_KEY,
  }
}

async function sessionToken(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find(
      (entry) => entry.startsWith('sb-') && entry.endsWith('-auth-token'),
    )
    if (!key) return null
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null')
    return parsed?.access_token ?? parsed?.currentSession?.access_token ?? null
  })
}

async function rpcFetch(environment, token, name, args) {
  const response = await fetch(`${environment.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: environment.key,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  })
  const text = await response.text()
  let payload
  try { payload = text ? JSON.parse(text) : null } catch { payload = text }
  return { ok: response.ok, status: response.status, payload }
}

async function clickButtonWithText(page, selector, text) {
  const clicked = await page.$$eval(selector, (buttons, expected) => {
    const button = buttons.find((entry) => entry.textContent?.includes(expected))
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  }, text)
  invariant(clicked, `Could not find ${selector} containing ${text}.`)
}

async function playerMetrics(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-player-viewport]')
    const controls = [...(root?.querySelectorAll('[data-required-control]') ?? [])]
      .filter((element) => {
        const style = getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden'
      })
      .map((element) => element.getBoundingClientRect())
    return {
      documentScroll:
        document.documentElement.scrollHeight > innerHeight + 1 ||
        document.documentElement.scrollWidth > innerWidth + 1,
      nestedScroll: root
        ? [...root.querySelectorAll('*')].some((element) => {
            const style = getComputedStyle(element)
            return /^(auto|scroll)$/.test(style.overflowX) ||
              /^(auto|scroll)$/.test(style.overflowY)
          })
        : true,
      minWidth: controls.length ? Math.min(...controls.map((rect) => rect.width)) : null,
      minHeight: controls.length ? Math.min(...controls.map((rect) => rect.height)) : null,
    }
  })
}

const publicMode = process.argv.includes('--public')
const environment = publicMode ? remoteEnvironment() : localEnvironment()
invariant(environment.url && environment.key, 'Missing Supabase frontend environment.')
const executablePath = browserExecutable()
invariant(executablePath, 'Chrome/Edge not found.')

let viteServer
let origin = 'https://vesperkrock.github.io/MaSoi/'
if (!publicMode) {
  process.env.VITE_SUPABASE_URL = environment.url
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = environment.key
  viteServer = await createServer({
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  })
  await viteServer.listen()
  const address = viteServer.httpServer?.address()
  invariant(address && typeof address !== 'string', 'Vite QA server did not start.')
  origin = `http://127.0.0.1:${address.port}/`
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})
const contexts = []
const pages = []
const pageErrors = []
const failedResponses = []

async function createIsolatedPage(viewport) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  contexts.push(context)
  pages.push(page)
  page.setDefaultTimeout(45_000)
  await page.setViewport(viewport)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 500) failedResponses.push({ status: response.status(), url: response.url() })
  })
  return page
}

try {
  const moderator = await createIsolatedPage({ width: 1440, height: 900 })
  const playerPages = []
  for (let index = 0; index < 7; index += 1) {
    playerPages.push(await createIsolatedPage({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
    }))
  }

  await moderator.goto(new URL('?screen=create', origin).href, { waitUntil: 'domcontentloaded' })
  await moderator.waitForSelector('.create-room-footer .button.primary')
  await moderator.click('.create-room-footer .button.primary')
  await moderator.waitForSelector('.lobby-moderator')
  const roomId = new URL(moderator.url()).searchParams.get('room')
  const roomCode = (await moderator.$eval('.lobby-heading h1', (node) => node.textContent ?? ''))
    .replace(/\D/g, '')
  invariant(roomId && /^\d{6}$/.test(roomCode), 'Product create flow did not create a six-digit room.')

  const names = Array.from({ length: 7 }, (_, index) => `HF1 ${index + 1}`)
  for (let index = 0; index < playerPages.length; index += 1) {
    const page = playerPages[index]
    await page.goto(new URL('?screen=join', origin).href, { waitUntil: 'domcontentloaded' })
    await page.type('.room-code-field input', roomCode)
    await page.click('.join-card button')
    await page.waitForSelector('.name-modal input')
    await page.type('.name-modal input', names[index])
    await page.click('.name-modal .button.primary')
    await page.waitForSelector('[data-surface="lobby"]')
  }

  await moderator.waitForFunction(
    () => document.querySelector('.lobby-count strong')?.textContent?.replace(/\s/g, '') === '7/7',
  )
  await moderator.click('.lobby-control-panel .button.primary')
  await moderator.waitForSelector('.reveal-moderator')

  const roles = []
  for (const page of playerPages) {
    await page.waitForSelector('[data-surface="reveal"] .role-identity-caption strong')
    roles.push(await page.$eval(
      '.role-identity-caption strong',
      (node) => node.textContent?.trim() ?? '',
    ))
    await page.click('.role-identity-surface .button.primary')
    await page.waitForSelector('[data-surface="neutral"]')
  }
  const wolfIndexes = roles
    .map((role, index) => ({ role, index }))
    .filter(({ role }) => role === 'Ma Sói')
    .map(({ index }) => index)
  invariant(wolfIndexes.length === 2, `Expected two Werewolves; roles=${roles.join(',')}`)
  const ordinaryIndex = roles.findIndex((role) => role !== 'Ma Sói')
  invariant(ordinaryIndex >= 0, 'Expected an ordinary non-Wolf Player.')

  await moderator.reload({ waitUntil: 'domcontentloaded' })
  await moderator.waitForSelector('.reveal-moderator')
  await moderator.waitForFunction(
    () => !document.querySelector('.reveal-readiness .button.primary')?.hasAttribute('disabled'),
  )
  await moderator.click('.reveal-readiness .button.primary')
  await moderator.waitForSelector('.night-panel')
  await clickButtonWithText(moderator, '.call-button', 'Ma Sói')

  const wolfA = playerPages[wolfIndexes[0]]
  const wolfB = playerPages[wolfIndexes[1]]
  const ordinary = playerPages[ordinaryIndex]
  await Promise.all([
    wolfA.waitForSelector('[data-surface="night_action"] .action-confirm'),
    wolfB.waitForSelector('[data-surface="night_action"] .action-confirm'),
    ordinary.waitForSelector('[data-surface="neutral"]'),
  ])

  const mandatoryBefore = await wolfA.evaluate(() => ({
    body: document.body.textContent ?? '',
    confirmDisabled: (document.querySelector('.action-confirm') instanceof HTMLButtonElement)
      ? document.querySelector('.action-confirm').disabled
      : null,
    targetCount: document.querySelectorAll('.target-list .target').length,
  }))
  invariant(!mandatoryBefore.body.includes('Không chọn'), 'Wolf UI still exposes Không chọn.')
  invariant(mandatoryBefore.confirmDisabled === true, 'Wolf confirm is enabled before a target.')
  invariant(mandatoryBefore.targetCount === 5, 'Wolf target grid contains a non-target abstain card.')

  const moderatorToken = await sessionToken(moderator)
  const wolfAToken = await sessionToken(wolfA)
  invariant(moderatorToken && wolfAToken, 'Missing browser anonymous session token.')
  const nullResult = await rpcFetch(environment, wolfAToken, 'ms1g2_submit_wolf_ballot', {
    p_room_id: roomId,
    p_target_player_id: null,
  })
  invariant(!nullResult.ok && nullResult.payload?.message === 'WOLF_TARGET_REQUIRED', 'Crafted null Wolf ballot was not denied.')
  const zeroResult = await rpcFetch(environment, moderatorToken, 'ms1g2_finalize_wolf_round', {
    p_room_id: roomId,
  })
  invariant(!zeroResult.ok && zeroResult.payload?.message === 'WOLF_TARGET_REQUIRED', 'Zero-ballot finalization was not denied.')

  const targetName = names[ordinaryIndex]
  const selected = await wolfA.$$eval('.target-list .target', (buttons, expected) => {
    const button = buttons.find((entry) => entry.getAttribute('title') === expected)
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  }, targetName)
  invariant(selected, 'Wolf A could not select the intended target.')
  await wolfA.waitForFunction(
    (expected) =>
      document.querySelector('.target.selected')?.getAttribute('title') === expected &&
      !(document.querySelector('.action-confirm')?.hasAttribute('disabled')),
    {},
    targetName,
  )
  await wolfA.click('.action-confirm')
  await wolfA.waitForSelector('[data-surface="neutral"]')

  const wolfAName = names[wolfIndexes[0]]
  await wolfB.waitForFunction(
    (expectedTarget, expectedPeer) => {
      const target = [...document.querySelectorAll('.target-list .target')]
        .find((entry) => entry.getAttribute('title') === expectedTarget)
      return target?.querySelector('.wolf-peer-marker')?.textContent?.includes(expectedPeer)
    },
    { timeout: 20_000 },
    targetName,
    wolfAName,
  )
  const peerMarker = await wolfB.$eval(
    '.wolf-peer-marker',
    (node) => node.textContent?.trim() ?? '',
  )
  const metrics = await playerMetrics(wolfB)
  invariant(!metrics.documentScroll && !metrics.nestedScroll, 'Live marker broke Player zero-scroll.')
  invariant(metrics.minWidth >= 44 && metrics.minHeight >= 44, 'Live marker surface has a control below 44x44.')

  const coordinated = await wolfB.$$eval('.target-list .target', (buttons, expected) => {
    const button = buttons.find((entry) => entry.getAttribute('title') === expected)
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  }, targetName)
  invariant(coordinated, 'Wolf B could not coordinate onto Wolf A target.')
  await wolfB.waitForFunction(
    () => !document.querySelector('.action-confirm')?.hasAttribute('disabled'),
  )
  await wolfB.click('.action-confirm')
  await wolfB.waitForSelector('[data-surface="neutral"]')

  await moderator.waitForFunction(() => {
    const monitor = document.querySelector('.action-monitor')
    const button = monitor?.querySelector('.button.primary')
    return monitor?.textContent?.replace(/\s/g, '').includes('2/2') &&
      button instanceof HTMLButtonElement && !button.disabled
  })
  await moderator.click('.action-monitor .button.primary')
  await moderator.waitForFunction(
    (expected) => document.querySelector('.final-target strong')?.textContent?.trim().endsWith(expected),
    {},
    targetName,
  )

  const ordinaryPrivacy = await ordinary.evaluate(() => ({
    surface: document.querySelector('[data-player-viewport]')?.getAttribute('data-surface'),
    markerCount: document.querySelectorAll('.wolf-peer-marker').length,
    localRegistry: localStorage.getItem('masoi.ms0b.rooms.v1'),
  }))
  invariant(ordinaryPrivacy.surface === 'neutral', 'Ordinary Player left neutral surface during Wolf call.')
  invariant(ordinaryPrivacy.markerCount === 0, 'Ordinary Player received Wolf peer marker.')
  invariant(ordinaryPrivacy.localRegistry === null, 'Product silently used LocalRoomTransport.')
  invariant(pageErrors.length === 0, `Page exception: ${pageErrors.join(' | ')}`)
  invariant(failedResponses.length === 0, `Server failures: ${JSON.stringify(failedResponses)}`)

  console.log(JSON.stringify({
    gate: 'MS-HF1-PAGES',
    mode: publicMode ? 'PUBLIC' : 'LOCAL_BROWSER',
    roomsUsed: 1,
    identities: 8,
    productFlow: 'CREATE_JOIN_DEAL_REVEAL_START_WOLF',
    noAbstainUi: true,
    confirmBeforeTargetDenied: true,
    craftedNullDenied: true,
    zeroBallotFinalizeDenied: true,
    wolfAConfirmedTarget: targetName,
    wolfBMarkerWithoutRefresh: peerMarker,
    wolfBCoordinatedTarget: targetName,
    resolvedTarget: targetName,
    ordinaryPlayerPeerData: 'ABSENT',
    localFallback: false,
    playerMetrics: metrics,
    pageErrors: 0,
  }, null, 2))
} finally {
  await Promise.all(contexts.map((context) => context.close().catch(() => undefined)))
  await browser.close()
  if (viteServer) await viteServer.close()
}
