import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)
const executablePath = candidates.find((candidate) => fs.existsSync(candidate))
if (!executablePath) throw new Error('Không tìm thấy Chrome/Edge. Đặt CHROME_PATH.')

const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite QA server không khởi động.')
const origin = `http://127.0.0.1:${address.port}`
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms0b-flow-'))
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  userDataDir: profile,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})

async function joinPlayer(code, name) {
  const page = await browser.newPage()
  page.setDefaultTimeout(15_000)
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await page.goto(`${origin}/?screen=join&transport=local`, { waitUntil: 'domcontentloaded' })
  await page.type('input[aria-label="Mã phòng gồm 6 chữ số"]', code)
  await page.click('.join-card button')
  await page.waitForSelector('.name-modal')
  await page.type('input[aria-label="Tên của bạn"]', name)
  await page.click('.name-modal .button.primary')
  await page.waitForFunction(() => new URL(location.href).searchParams.has('player'))
  await page.waitForSelector('[data-surface="lobby"]')
  console.log(`JOINED ${name}`)
  return page
}

try {
  const landing = await browser.newPage()
  landing.setDefaultTimeout(15_000)
  await landing.goto(`${origin}/?transport=local`, { waitUntil: 'domcontentloaded' })
  const entryLabels = await landing.$$eval('.entry-actions a', (links) =>
    links.map((link) => link.textContent?.trim()),
  )
  if (entryLabels.join('|') !== 'Tạo phòng|Vào phòng|QUẢN TRÒ 1 MÁY') {
    throw new Error(`Landing actions sai: ${entryLabels.join('|')}`)
  }
  await landing.close()
  console.log('CHECKPOINT landing')

  const moderator = await browser.newPage()
  moderator.setDefaultTimeout(15_000)
  await moderator.setViewport({ width: 1280, height: 900 })
  await moderator.goto(`${origin}/?screen=create&transport=local`, { waitUntil: 'domcontentloaded' })
  await moderator.click('.create-room-footer .button.primary')
  await moderator.waitForFunction(() => new URL(location.href).searchParams.get('as') === 'moderator')
  await moderator.waitForSelector('.lobby-moderator')
  const roomData = await moderator.evaluate(() => {
    const registry = JSON.parse(localStorage.getItem('masoi.ms0b.rooms.v1') ?? '{}')
    const roomId = new URL(location.href).searchParams.get('room')
    return { roomId, room: registry.rooms[roomId] }
  })
  if (!roomData.roomId || !/^\d{6}$/.test(roomData.room.roomCode)) {
    throw new Error('Room không có internal ID + six-digit code.')
  }
  if (roomData.room.players.length !== 0 || roomData.room.roleAssignments.length !== 0) {
    throw new Error('Room creation đã tạo Player hoặc assignment quá sớm.')
  }
  const code = roomData.room.roomCode
  console.log(`CHECKPOINT room ${code}`)

  const playerUrls = []
  for (const name of ['Bảo Châu', 'Minh', 'Xuka', 'An', 'Bình', 'Chi', 'Dũng']) {
    const playerPage = await joinPlayer(code, name)
    playerUrls.push(playerPage.url())
    await playerPage.close()
  }
  await moderator.waitForFunction(
    () => document.querySelector('.lobby-count strong')?.textContent?.includes('7 / 7'),
  )
  console.log('CHECKPOINT lobby full')

  await moderator.click('.lobby-control-panel .button.primary')
  await new Promise((resolve) => setTimeout(resolve, 500))
  const lockState = await moderator.evaluate(() => {
    const registry = JSON.parse(localStorage.getItem('masoi.ms0b.rooms.v1') ?? '{}')
    const roomId = new URL(location.href).searchParams.get('room')
    return {
      lifecycle: registry.rooms[roomId]?.lifecycle,
      error: document.querySelector('.error-banner')?.textContent,
    }
  })
  if (lockState.lifecycle !== 'ROLE_REVEAL') {
    throw new Error(`Lock failed: ${JSON.stringify(lockState)}`)
  }
  await moderator.waitForSelector('.reveal-moderator')
  const assignmentCount = await moderator.evaluate(() => {
    const registry = JSON.parse(localStorage.getItem('masoi.ms0b.rooms.v1') ?? '{}')
    const roomId = new URL(location.href).searchParams.get('room')
    return registry.rooms[roomId].roleAssignments.length
  })
  if (assignmentCount !== 7) throw new Error(`Expected 7 assignments, got ${assignmentCount}.`)
  console.log('CHECKPOINT roles assigned')

  const lateJoin = await browser.newPage()
  lateJoin.setDefaultTimeout(15_000)
  await lateJoin.goto(`${origin}/?screen=join&transport=local`, { waitUntil: 'domcontentloaded' })
  await lateJoin.type('input[aria-label="Mã phòng gồm 6 chữ số"]', code)
  await lateJoin.click('.join-card button')
  await lateJoin.waitForSelector('.form-error')
  if (await lateJoin.$('.name-modal')) throw new Error('Started room vẫn mở name modal.')
  await lateJoin.close()
  console.log('CHECKPOINT late join rejected')

  for (const playerUrl of playerUrls) {
    const playerPage = await browser.newPage()
    playerPage.setDefaultTimeout(15_000)
    await playerPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await playerPage.goto(playerUrl, { waitUntil: 'domcontentloaded' })
    await playerPage.waitForSelector('[data-surface="reveal"]')
    await playerPage.click('.role-identity-surface .button.primary')
    await playerPage.waitForSelector('[data-surface="neutral"]')
    await playerPage.close()
  }
  await moderator.waitForFunction(
    () => !document.querySelector('.reveal-readiness .button.primary')?.hasAttribute('disabled'),
  )
  console.log('CHECKPOINT reveals confirmed')
  await moderator.click('.reveal-readiness .button.primary')
  await moderator.waitForSelector('.night-panel')
  for (const playerUrl of playerUrls) {
    const playerPage = await browser.newPage()
    playerPage.setDefaultTimeout(15_000)
    await playerPage.goto(playerUrl, { waitUntil: 'domcontentloaded' })
    await playerPage.waitForFunction(
      () =>
        document.querySelector('[data-surface="neutral"]') &&
        document.body.textContent?.includes('ĐÊM 1'),
    )
    await playerPage.close()
  }

  console.log(`PASS landing → create → LOBBY (${code})`)
  console.log('PASS 7 joins → lock → 7 private assignments → reveal confirmations')
  console.log('PASS started room rejects late join before name modal')
  console.log('PASS Moderator explicitly starts IN_GAME / ĐÊM 1')
  await moderator.close()
} finally {
  await browser.close()
  await server.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
