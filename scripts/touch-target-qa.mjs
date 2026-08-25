import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

const browserCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate))
if (!executablePath) throw new Error('Không tìm thấy Chrome/Edge. Đặt CHROME_PATH.')

const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]
const storageKey = 'masoi.ms0b.rooms.v1'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite QA server không khởi động.')
const origin = `http://127.0.0.1:${address.port}`
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms0d-touch-'))
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  userDataDir: profile,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})

async function newPage(viewport = { width: 390, height: 844 }) {
  const page = await browser.newPage()
  page.setDefaultTimeout(20_000)
  await page.setViewport({
    ...viewport,
    deviceScaleFactor: 1,
    isMobile: viewport.width < 600,
    hasTouch: viewport.width < 600,
  })
  return page
}

async function roomState(page, roomId) {
  return page.evaluate(
    (key, id) => JSON.parse(localStorage.getItem(key)).rooms[id],
    storageKey,
    roomId,
  )
}

async function joinPlayer(code, name) {
  const page = await newPage()
  await page.goto(`${origin}/?transport=local`, { waitUntil: 'domcontentloaded' })
  await page.click('.entry-actions a:nth-child(2)')
  await page.waitForSelector('.join-card')
  await page.type('input[inputmode="numeric"]', code)
  await page.click('.join-card form button')
  await page.waitForSelector('.name-modal')
  await page.type('.name-modal input', name)
  await page.$eval('.name-modal .button.primary', (button) => button.click())
  await page.waitForFunction(() => new URL(location.href).searchParams.has('player'))
  await page.waitForSelector('[data-surface="lobby"]')
  return page
}

async function inspectModeratorLayout(page, surface) {
  const metrics = await page.evaluate(() => ({
    viewport: `${innerWidth}x${innerHeight}`,
    documentHeight: document.documentElement.scrollHeight,
    horizontalScroll: document.documentElement.scrollWidth > innerWidth + 1,
    verticalScroll: document.documentElement.scrollHeight > innerHeight + 1,
  }))
  invariant(!metrics.horizontalScroll, `Moderator ${surface} has horizontal scroll.`)
  return { surface, ...metrics }
}

async function inspectTargets(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-player-viewport]')
    const targetList = root?.querySelector('.target-list')
    const targets = [...(root?.querySelectorAll('.target[data-required-control]') ?? [])]
    const rects = targets.map((target) => {
      const rect = target.getBoundingClientRect()
      return {
        width: rect.width,
        height: rect.height,
        clipped:
          rect.left < -1 ||
          rect.top < -1 ||
          rect.right > innerWidth + 1 ||
          rect.bottom > innerHeight + 1,
      }
    })
    const nestedScroll = root
      ? [...root.querySelectorAll('*')].some((element) => {
          const style = getComputedStyle(element)
          return /^(auto|scroll)$/.test(style.overflowX) || /^(auto|scroll)$/.test(style.overflowY)
        })
      : true
    const minWidth = Math.min(...rects.map(({ width }) => width))
    const maxWidth = Math.max(...rects.map(({ width }) => width))
    const minHeight = Math.min(...rects.map(({ height }) => height))
    const maxHeight = Math.max(...rects.map(({ height }) => height))
    return {
      surface: root?.dataset.surface,
      count: targets.length,
      minWidth,
      maxWidth,
      minHeight,
      maxHeight,
      fontSize: targets.length
        ? Number.parseFloat(
            getComputedStyle(targets[0].querySelector('strong') ?? targets[0]).fontSize,
          )
        : 0,
      gridGap: targetList
        ? Number.parseFloat(getComputedStyle(targetList).rowGap)
        : 0,
      documentScroll:
        document.documentElement.scrollHeight > innerHeight + 1 ||
        document.documentElement.scrollWidth > innerWidth + 1,
      rootScroll: root
        ? root.scrollHeight > root.clientHeight + 1 ||
          root.scrollWidth > root.clientWidth + 1
        : true,
      nestedScroll,
      clippedTargets: rects.filter(({ clipped }) => clipped).length,
    }
  })
}

async function measureAtAllViewports(page, surface) {
  const measurements = []
  for (const viewport of viewports) {
    await page.setViewport({
      ...viewport,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-surface="${surface}"]`)
    const result = await inspectTargets(page)
    invariant(result.minWidth >= 44, `${surface} ${viewport.width}x${viewport.height} width ${result.minWidth}`)
    invariant(result.minHeight >= 44, `${surface} ${viewport.width}x${viewport.height} height ${result.minHeight}`)
    invariant(!result.documentScroll && !result.rootScroll && !result.nestedScroll, `${surface} ${viewport.width}x${viewport.height} scroll regression`)
    invariant(result.clippedTargets === 0, `${surface} ${viewport.width}x${viewport.height} clipped target`)
    measurements.push({ viewport: `${viewport.width}x${viewport.height}`, ...result })
  }
  return measurements
}

try {
  const clear = await newPage()
  await clear.goto(`${origin}/?transport=local`, { waitUntil: 'domcontentloaded' })
  await clear.evaluate(() => localStorage.clear())
  await clear.close()

  const moderator = await newPage({ width: 1280, height: 900 })
  await moderator.goto(`${origin}/?transport=local`, { waitUntil: 'domcontentloaded' })
  await moderator.click('.entry-actions a:first-child')
  await moderator.waitForSelector('.create-room-layout')
  await moderator.select('.room-basics select', '16')
  for (let index = 0; index < 9; index += 1) {
    await moderator.click('.quantity-control:first-of-type button:last-child')
  }
  await moderator.click('.create-room-footer .button.primary')
  await moderator.waitForFunction(
    () => new URL(location.href).searchParams.get('as') === 'moderator',
  )
  await moderator.waitForSelector('.lobby-moderator')
  const roomId = new URL(moderator.url()).searchParams.get('room')
  let state = await roomState(moderator, roomId)
  const code = state.roomCode
  invariant(/^\d{6}$/.test(code), 'Room 16 người thiếu code sáu số.')

  const urls = []
  for (let index = 1; index <= 16; index += 1) {
    const player = await joinPlayer(code, `Touch ${String(index).padStart(2, '0')}`)
    urls.push(player.url())
    await player.close()
  }
  await moderator.bringToFront()
  await moderator.waitForFunction(() => document.querySelector('.lobby-count strong')?.textContent.includes('16 / 16'))
  const moderatorLayouts = [await inspectModeratorLayout(moderator, '16-player lobby')]
  await moderator.click('.lobby-control-panel .button.primary')
  await moderator.waitForSelector('.reveal-moderator')
  moderatorLayouts.push(await inspectModeratorLayout(moderator, '16-player role reveal'))

  for (const url of urls) {
    const player = await newPage()
    await player.goto(url, { waitUntil: 'domcontentloaded' })
    await player.waitForSelector('[data-surface="reveal"]')
    await player.click('.role-identity-surface .button.primary')
    await player.waitForSelector('[data-surface="neutral"]')
    await player.close()
  }
  await moderator.bringToFront()
  await moderator.waitForFunction(() => {
    const button = document.querySelector('.reveal-readiness .button.primary')
    return button instanceof HTMLButtonElement && !button.disabled
  })
  await moderator.click('.reveal-readiness .button.primary')
  await moderator.waitForSelector('.night-panel')
  moderatorLayouts.push(await inspectModeratorLayout(moderator, '16-player night'))

  state = await roomState(moderator, roomId)
  const urlByPlayer = new Map(
    urls.map((url) => [new URL(url).searchParams.get('player'), url]),
  )
  const wolfIds = state.roleAssignments
    .filter(({ roleId }) => roleId === 'werewolf')
    .map(({ playerId }) => playerId)
  const seerId = state.roleAssignments.find(({ roleId }) => roleId === 'seer')?.playerId
  invariant(wolfIds.length === 2 && seerId, '16-player default deck không có 2 Sói + 1 Tiên Tri.')

  await moderator.click('.night-calls .call-button')
  await moderator.waitForSelector('.action-monitor')
  const measuredWolf = await newPage()
  await measuredWolf.goto(urlByPlayer.get(wolfIds[0]), { waitUntil: 'domcontentloaded' })
  await measuredWolf.waitForSelector('[data-surface="night_action"]')
  const night = await measureAtAllViewports(measuredWolf, 'night_action')
  await measuredWolf.click('.target:first-child')
  await measuredWolf.waitForFunction(() => !document.querySelector('.action-confirm')?.hasAttribute('disabled'))
  await measuredWolf.click('.action-confirm')
  await measuredWolf.waitForSelector('[data-surface="neutral"]')
  await measuredWolf.close()

  for (const wolfId of wolfIds.slice(1)) {
    const wolf = await newPage()
    await wolf.goto(urlByPlayer.get(wolfId), { waitUntil: 'domcontentloaded' })
    await wolf.waitForSelector('[data-surface="night_action"]')
    await wolf.click('.target:first-child')
    await wolf.waitForFunction(() => !document.querySelector('.action-confirm')?.hasAttribute('disabled'))
    await wolf.click('.action-confirm')
    await wolf.waitForSelector('[data-surface="neutral"]')
    await wolf.close()
  }

  await moderator.bringToFront()
  await moderator.waitForFunction(() => {
    const button = document.querySelector('.action-monitor .button.primary')
    return button instanceof HTMLButtonElement && !button.disabled
  })
  await moderator.click('.action-monitor .button.primary')
  await moderator.waitForSelector('.final-target')
  await moderator.waitForFunction(() => Boolean(document.querySelector('.night-calls .call-button:not([disabled])')))
  await moderator.click('.night-calls .call-button:not([disabled])')

  const seer = await newPage()
  await seer.goto(urlByPlayer.get(seerId), { waitUntil: 'domcontentloaded' })
  await seer.waitForSelector('[data-surface="night_action"]')
  await seer.click('.target:first-child')
  await seer.waitForSelector('[data-surface="neutral"]')
  await seer.close()

  await moderator.bringToFront()
  await moderator.waitForSelector('.next-phase')
  await moderator.click('.next-phase')
  await moderator.waitForSelector('.day-panel')
  await moderator.click('.day-panel > .button.primary')
  const voter = await newPage()
  await voter.goto(urls[0], { waitUntil: 'domcontentloaded' })
  await voter.waitForSelector('[data-surface="day_vote"]')
  const dayVote = await measureAtAllViewports(voter, 'day_vote')
  await voter.close()

  console.log('MS-0D 16-PLAYER PRODUCT TOUCH QA PASS')
  console.log(JSON.stringify({ roomCode: code, moderatorLayouts, night, dayVote }, null, 2))
  await moderator.close()
} finally {
  await browser.close()
  await server.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
