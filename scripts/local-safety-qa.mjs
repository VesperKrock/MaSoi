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

const storageKey = 'masoi.ms0b.rooms.v1'
const expectedErrorCode = 'LOCAL_CONCURRENCY_UNSUPPORTED'
const expectedMessage =
  'Trình duyệt này không hỗ trợ đồng bộ phòng cục bộ an toàn. Vui lòng dùng Chrome hoặc Edge phiên bản mới, rồi thử lại.'

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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms0d-safety-'))
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  userDataDir: profile,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})

async function newPage({ disableLocks = false, desktop = false } = {}) {
  const page = await browser.newPage()
  page.setDefaultTimeout(20_000)
  await page.setViewport(
    desktop
      ? { width: 1280, height: 900 }
      : { width: 390, height: 844, isMobile: true, hasTouch: true },
  )
  if (disableLocks) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: undefined,
      })
    })
  }
  return page
}

async function clearRooms() {
  const page = await newPage()
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.close()
}

async function registry(page) {
  return page.evaluate((key) => {
    return JSON.parse(
      localStorage.getItem(key) ?? '{"schemaVersion":1,"rooms":{}}',
    )
  }, storageKey)
}

async function createRoom() {
  const page = await newPage({ desktop: true })
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.click('.entry-actions a:first-child')
  await page.waitForSelector('.create-room-layout')
  await page.click('.create-room-footer .button.primary')
  await page.waitForFunction(
    () => new URL(location.href).searchParams.get('as') === 'moderator',
  )
  await page.waitForSelector('.lobby-moderator')
  const roomId = new URL(page.url()).searchParams.get('room')
  const state = await registry(page)
  return {
    page,
    roomId,
    code: state.rooms[roomId].roomCode,
    moderatorUrl: page.url(),
  }
}

async function prepareJoin(code, name, disableLocks = false) {
  const page = await newPage({ disableLocks })
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.click('.entry-actions a:nth-child(2)')
  await page.waitForSelector('.join-card')
  await page.type('input[inputmode="numeric"]', code)
  await page.click('.join-card form button')
  await page.waitForSelector('.name-modal')
  await page.type('.name-modal input', name)
  return page
}

async function awaitJoinResult(page) {
  await page.waitForFunction(
    () =>
      new URL(location.href).searchParams.has('player') ||
      Boolean(document.querySelector('.name-modal .form-error')),
  )
  const success = new URL(page.url()).searchParams.has('player')
  if (success) await page.waitForSelector('[data-surface="lobby"]')
  return {
    success,
    playerId: new URL(page.url()).searchParams.get('player'),
    error: await page
      .$eval('.name-modal .form-error', (node) => node.textContent.trim())
      .catch(() => ''),
  }
}

async function submitTogether(pages) {
  await Promise.all(
    pages.map((page) =>
      page.$eval('.name-modal .button.primary', (button) => button.click()),
    ),
  )
  return Promise.all(pages.map(awaitJoinResult))
}

async function join(code, name) {
  const page = await prepareJoin(code, name)
  await page.$eval('.name-modal .button.primary', (button) => button.click())
  const result = await awaitJoinResult(page)
  invariant(result.success, `Join ${name} thất bại: ${result.error}`)
  return page
}

async function webLocksLastSeatRace() {
  await clearRooms()
  const room = await createRoom()
  for (let index = 1; index <= 6; index += 1) {
    const player = await join(room.code, `Existing ${index}`)
    await player.close()
  }
  const left = await prepareJoin(room.code, 'Final Left')
  const right = await prepareJoin(room.code, 'Final Right')
  const lockSupport = await Promise.all(
    [left, right].map((page) => page.evaluate(() => Boolean(navigator.locks?.request))),
  )
  const outcomes = await submitTogether([left, right])
  const state = (await registry(room.page)).rooms[room.roomId]
  invariant(lockSupport.every(Boolean), 'Web Locks không có trong safe-path QA.')
  invariant(outcomes.filter(({ success }) => success).length === 1, 'Last-seat race không có đúng một winner.')
  invariant(state.players.length === 7, `Last-seat race lưu ${state.players.length} Player.`)
  invariant(new Set(state.players.map((player) => player.seat)).size === 7, 'Last-seat race tạo seat trùng.')
  await left.close()
  await right.close()
  await room.page.close()
  return { successes: 1, rejectedAsFull: outcomes.some(({ error }) => error === 'Phòng đã đủ người.'), playerCount: 7 }
}

async function webLocksDuplicateNameRace() {
  await clearRooms()
  const room = await createRoom()
  const left = await prepareJoin(room.code, 'Bảo Châu')
  const right = await prepareJoin(room.code, 'bảo   châu')
  const outcomes = await submitTogether([left, right])
  const state = (await registry(room.page)).rooms[room.roomId]
  invariant(outcomes.filter(({ success }) => success).length === 1, 'Duplicate-name race không có đúng một winner.')
  invariant(state.players.length === 1, `Duplicate-name race lưu ${state.players.length} Player.`)
  invariant(outcomes.some(({ error }) => error === 'Tên này đã có người dùng trong phòng.'), 'Thiếu duplicate-name rejection.')
  await left.close()
  await right.close()
  await room.page.close()
  return { successes: 1, duplicateRejections: 1, playerCount: 1 }
}

async function noLocksCreate() {
  await clearRooms()
  const page = await newPage({ disableLocks: true, desktop: true })
  await page.goto(`${origin}/?screen=create`, { waitUntil: 'domcontentloaded' })
  const machineResult = await page.evaluate(async () => {
    const module = await import('/src/transport/local/local-room-transport.ts')
    const transport = new module.LocalRoomTransport()
    const result = await transport.createRoom({
      seatCount: 7,
      roleComposition: { villager: 4, werewolf: 2, seer: 1 },
      wolfPolicy: 'RANDOM_ON_TIE',
    })
    transport.dispose()
    return result
  })
  invariant(machineResult.ok === false && machineResult.errorCode === expectedErrorCode, 'Create thiếu machine-readable error.')
  invariant(Object.keys((await registry(page)).rooms).length === 0, 'Machine create đã ghi registry.')
  await page.click('.create-room-footer .button.primary')
  await page.waitForSelector('.inline-error')
  const visibleError = await page.$eval('.inline-error', (node) => node.textContent.trim())
  const state = await registry(page)
  invariant(visibleError === expectedMessage, 'Create không surface đúng thông báo tiếng Việt.')
  invariant(Object.keys(state.rooms).length === 0, 'No-lock create đã tạo room.')
  invariant(new URL(page.url()).searchParams.get('screen') === 'create', 'No-lock create đã trả success URL.')
  await page.close()
  return { errorCode: machineResult.errorCode, visibleError, roomCount: 0, successUrl: false }
}

async function noLocksJoin() {
  await clearRooms()
  const room = await createRoom()
  const page = await prepareJoin(room.code, 'Blocked Player', true)
  const before = JSON.stringify(await registry(page))
  await page.$eval('.name-modal .button.primary', (button) => button.click())
  const outcome = await awaitJoinResult(page)
  const after = JSON.stringify(await registry(page))
  invariant(!outcome.success, 'No-lock join báo success.')
  invariant(outcome.error === expectedMessage, 'No-lock join thiếu thông báo tiếng Việt.')
  invariant(before === after, 'No-lock join đã thay đổi registry.')
  invariant(!new URL(page.url()).searchParams.has('player'), 'No-lock join trả ghost Player URL.')
  const state = (await registry(room.page)).rooms[room.roomId]
  invariant(state.players.length === 0, 'No-lock join đã tạo Player.')
  await page.close()
  await room.page.close()
  return { success: false, playerCount: 0, ghostUrl: false, registryUnchanged: true }
}

async function noLocksLockAndDeal() {
  await clearRooms()
  const room = await createRoom()
  for (let index = 1; index <= 7; index += 1) {
    const player = await join(room.code, `Ready ${index}`)
    await player.close()
  }
  const page = await newPage({ disableLocks: true, desktop: true })
  await page.goto(room.moderatorUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lobby-moderator')
  const before = JSON.stringify(await registry(page))
  await page.click('.lobby-control-panel .button.primary')
  await page.waitForSelector('.error-banner')
  const visibleError = await page.$eval('.error-banner span', (node) => node.textContent.trim())
  const after = JSON.stringify(await registry(page))
  const state = (await registry(page)).rooms[room.roomId]
  invariant(visibleError === expectedMessage, 'No-lock dispatch thiếu thông báo tiếng Việt.')
  invariant(before === after, 'No-lock lock/deal đã thay đổi registry.')
  invariant(state.lifecycle === 'LOBBY' && state.roleAssignments.length === 0, 'No-lock lock/deal tạo partial mutation.')
  await page.close()
  await room.page.close()
  return { lifecycle: state.lifecycle, assignments: 0, registryUnchanged: true }
}

try {
  const results = {
    webLocksLastSeat: await webLocksLastSeatRace(),
    webLocksDuplicateName: await webLocksDuplicateNameRace(),
    noWebLocksCreate: await noLocksCreate(),
    noWebLocksJoin: await noLocksJoin(),
    noWebLocksLockAndDeal: await noLocksLockAndDeal(),
  }
  console.log('MS-0D LOCAL SAFETY QA PASS')
  console.log(JSON.stringify(results, null, 2))
} finally {
  await browser.close()
  await server.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
