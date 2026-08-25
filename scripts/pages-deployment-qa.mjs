import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const publicUrl = new URL(
  process.env.MASOI_PAGES_URL ?? 'https://vesperkrock.github.io/MaSoi/',
)
const basePath = '/MaSoi/'
const classicCardFiles = [
  'Bán Sói.jpg',
  'Bảo Vệ.jpg',
  'Dân Làng.jpg',
  'Kẻ Phản Bội.jpg',
  'Ma Sói.jpg',
  'Phù Thủy.jpg',
  'Sát Nhân Hàng Loạt.jpg',
  'Thần Tình Yêu.jpg',
  'Thằng Ngố.jpg',
  'Thị Trưởng.jpg',
  'Thợ Săn.jpg',
  'Tiên Tri.jpg',
]

function invariant(condition, message) {
  if (!condition) throw new Error(message)
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

async function observePage(page, evidence) {
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message))
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin === publicUrl.origin && response.status() >= 400) {
      evidence.publicFailures.push({ path: url.pathname, status: response.status() })
    }
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.includes('/auth/v1/')) evidence.supabaseAuth = true
    const rpcMarker = '/rest/v1/rpc/'
    if (url.pathname.includes(rpcMarker)) {
      evidence.supabaseRpcs.add(url.pathname.split(rpcMarker)[1])
    }
  })
  const devtools = await page.createCDPSession()
  await devtools.send('Network.enable')
  devtools.on('Network.webSocketCreated', () => {
    evidence.webSockets += 1
  })
}

async function authStorage(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((entry) => entry.startsWith('sb-') && entry.endsWith('-auth-token'))
    return key ? { key, value: localStorage.getItem(key) } : null
  })
}

const executablePath = browserExecutable()
invariant(executablePath, 'Không tìm thấy Chrome/Edge cho deployed Pages QA.')
invariant(publicUrl.protocol === 'https:', 'Deployed QA chỉ được chạy trên HTTPS.')
invariant(publicUrl.pathname === basePath, 'Public URL không khớp /MaSoi/.')

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})
const evidence = {
  pageErrors: [],
  publicFailures: [],
  supabaseAuth: false,
  supabaseRpcs: new Set(),
  webSockets: 0,
}

try {
  const moderatorContext = await browser.createBrowserContext()
  const playerContext = await browser.createBrowserContext()
  const moderator = await moderatorContext.newPage()
  const player = await playerContext.newPage()
  moderator.setDefaultTimeout(45_000)
  player.setDefaultTimeout(45_000)
  await observePage(moderator, evidence)
  await observePage(player, evidence)

  await moderator.goto(publicUrl.href, { waitUntil: 'networkidle0' })
  await moderator.waitForSelector('.entry-actions')
  const landing = await moderator.evaluate((expectedBasePath) => ({
    secureContext: window.isSecureContext,
    pathname: location.pathname,
    createHref: document.querySelector('.entry-actions a:first-child')?.getAttribute('href'),
    joinHref: document.querySelector('.entry-actions a:last-child')?.getAttribute('href'),
    authority: document.querySelector('.local-truth')?.textContent ?? '',
    localRegistry: localStorage.getItem('masoi.ms0b.rooms.v1'),
    expectedBasePath,
  }), basePath)
  invariant(landing.secureContext, 'Public Pages origin không phải secure context.')
  invariant(landing.pathname === basePath, 'Public root không nằm ở /MaSoi/.')
  invariant(landing.createHref === `${basePath}?screen=create`, 'Public Create link sai base path.')
  invariant(landing.joinHref === `${basePath}?screen=join`, 'Public Join link sai base path.')
  invariant(landing.authority.includes('nhiều thiết bị'), 'Public product không hiển thị server authority.')
  invariant(landing.localRegistry === null, 'Public product đã tạo local room registry.')

  const cards = await moderator.evaluate(async ({ expectedBasePath, files }) => {
    return Promise.all(files.map(async (filename) => {
      const response = await fetch(`${expectedBasePath}assets/cards/classic/${encodeURIComponent(filename)}`)
      return { status: response.status, contentType: response.headers.get('content-type') ?? '' }
    }))
  }, { expectedBasePath: basePath, files: classicCardFiles })
  invariant(cards.length === 12, 'Deployed card inventory không đủ 12 JPG.')
  invariant(cards.every((card) => card.status === 200), 'Deployed Classic JPG có response khác 200.')
  invariant(cards.every((card) => card.contentType.includes('image/jpeg')), 'Deployed Classic asset không có JPEG content type.')

  await moderator.goto(new URL('?screen=create', publicUrl).href, { waitUntil: 'networkidle0' })
  await moderator.waitForSelector('.create-room-layout')
  invariant(new URL(moderator.url()).pathname === basePath, 'Create query route làm mất base path.')
  await moderator.click('.create-room-footer .button.primary')
  await moderator.waitForFunction(() => new URL(location.href).searchParams.get('as') === 'moderator')
  await moderator.waitForSelector('.lobby-moderator')
  const moderatorUrl = new URL(moderator.url())
  const roomId = moderatorUrl.searchParams.get('room')
  invariant(roomId && moderatorUrl.pathname === basePath, 'Create success URL sai room/base state.')
  const roomCode = (await moderator.$eval('.lobby-heading h1', (node) => node.textContent ?? '')).replace(/\D/g, '')
  invariant(/^\d{6}$/.test(roomCode), 'Public create không trả six-digit room code.')
  const moderatorSession = await authStorage(moderator)
  invariant(moderatorSession?.value, 'Moderator anonymous session không được persist.')

  await player.goto(new URL('?screen=join', publicUrl).href, { waitUntil: 'networkidle0' })
  await player.waitForSelector('.join-card')
  invariant(new URL(player.url()).pathname === basePath, 'Join query route làm mất base path.')
  invariant(await player.$('.name-modal') === null, 'Name modal mở trước room lookup.')
  await player.type('.room-code-field input', roomCode)
  await player.click('.join-card button')
  await player.waitForSelector('.name-modal')
  const playerName = `D1 Player ${Date.now().toString().slice(-6)}`
  await player.type('.name-modal input', playerName)
  await player.click('.name-modal .button.primary')
  await player.waitForFunction(() => new URL(location.href).searchParams.has('player'))
  await player.waitForSelector('[data-surface="lobby"]')
  const playerUrlBeforeRefresh = new URL(player.url())
  const playerId = playerUrlBeforeRefresh.searchParams.get('player')
  invariant(playerId && playerUrlBeforeRefresh.pathname === basePath, 'Join success URL sai player/base state.')

  const playerSessionBeforeRefresh = await authStorage(player)
  invariant(playerSessionBeforeRefresh?.value, 'Player anonymous session không được persist.')
  invariant(
    moderatorSession.value !== playerSessionBeforeRefresh.value,
    'Hai isolated browser contexts dùng cùng anonymous identity.',
  )

  await moderator.waitForFunction((expectedName) => {
    const count = document.querySelector('.lobby-count strong')?.textContent?.replace(/\s/g, '')
    const roster = [...document.querySelectorAll('.joined-seat strong')].map((node) => node.textContent?.trim())
    return count === '1/7' && roster.includes(expectedName)
  }, {}, playerName)

  await player.reload({ waitUntil: 'networkidle0' })
  await player.waitForSelector('[data-surface="lobby"]')
  const refreshedPlayer = await player.evaluate(() => ({
    playerId: new URL(location.href).searchParams.get('player'),
    pathname: location.pathname,
    body: document.body.textContent ?? '',
    localRegistry: localStorage.getItem('masoi.ms0b.rooms.v1'),
  }))
  const playerSessionAfterRefresh = await authStorage(player)
  invariant(refreshedPlayer.playerId === playerId, 'Refresh đổi stable Player seat identity.')
  invariant(refreshedPlayer.pathname === basePath, 'Refresh làm mất Pages base path.')
  invariant(refreshedPlayer.body.includes(playerName), 'Refresh không resume đúng Player membership.')
  invariant(playerSessionAfterRefresh?.value === playerSessionBeforeRefresh.value, 'Refresh đổi anonymous auth session.')
  invariant(refreshedPlayer.localRegistry === null, 'Player refresh đã silently fall back sang local room.')

  const moderatorLocalRegistry = await moderator.evaluate(() => localStorage.getItem('masoi.ms0b.rooms.v1'))
  invariant(moderatorLocalRegistry === null, 'Moderator đã silently fall back sang local room.')
  invariant(evidence.supabaseAuth, 'Không quan sát được Supabase Anonymous Auth traffic.')
  invariant(evidence.supabaseRpcs.has('ms1a_create_room'), 'Public Create không gọi server RPC.')
  invariant(evidence.supabaseRpcs.has('ms1a_lookup_room'), 'Public lookup không gọi server RPC.')
  invariant(evidence.supabaseRpcs.has('ms1a_join_room'), 'Public Join không gọi server RPC.')
  invariant(evidence.webSockets > 0, 'Không quan sát được realtime WebSocket.')
  invariant(evidence.publicFailures.length === 0, `Public origin có response lỗi: ${JSON.stringify(evidence.publicFailures)}`)
  invariant(evidence.pageErrors.length === 0, `Public origin có page error: ${evidence.pageErrors.join(' | ')}`)

  await playerContext.close()
  await moderatorContext.close()
  console.log('MS-1A-D1 DEPLOYED PAGES QA PASS')
  console.log(JSON.stringify({
    publicOrigin: 'https://vesperkrock.github.io/MaSoi/',
    secureContext: true,
    root: 'PASS',
    createRoute: 'PASS',
    joinRoute: 'PASS',
    classicJpgs: { expected: 12, loaded: 12, status: 200 },
    asset404s: 0,
    anonymousAuth: 'PASS',
    isolatedIdentities: 2,
    roomCodeDigits: 6,
    remoteCreate: 'PASS',
    remoteJoin: 'PASS',
    realtimeRoster: '1/7',
    refreshMembership: 'PASS',
    stableSeat: true,
    supabaseRpcAuthority: true,
    silentLocalFallback: false,
    pageErrors: 0,
  }, null, 2))
} finally {
  await browser.close()
}
