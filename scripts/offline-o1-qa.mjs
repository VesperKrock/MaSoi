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

const offlineKey = 'masoi.offline-moderator.session.v3'
const onlineKey = 'masoi.ms0b.rooms.v1'
const mobileViewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') {
  throw new Error('Vite QA server không khởi động.')
}
const origin = `http://127.0.0.1:${address.port}`
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms-o1-'))
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  userDataDir: profile,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})

async function inspectMobile(page, surface) {
  const metrics = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('main button, main input, main select')]
      .filter((element) => {
        const style = getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden'
      })
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      })
    return {
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      controlCount: controls.length,
      minimumControlWidth: controls.length
        ? Math.min(...controls.map((control) => control.width))
        : 44,
      minimumControlHeight: controls.length
        ? Math.min(...controls.map((control) => control.height))
        : 44,
      imageCount: document.querySelectorAll('main img').length,
    }
  })
  invariant(!metrics.horizontalOverflow, `${surface}: có horizontal overflow.`)
  invariant(
    metrics.minimumControlWidth >= 44,
    `${surface}: control hẹp hơn 44px (${JSON.stringify(metrics)}).`,
  )
  invariant(
    metrics.minimumControlHeight >= 44,
    `${surface}: control thấp hơn 44px (${JSON.stringify(metrics)}).`,
  )
  invariant(metrics.imageCount === 0, `${surface}: Offline không được hiện card artwork.`)
}

async function inspectMobileViewports(page, surface) {
  for (const viewport of mobileViewports) {
    await page.setViewport({
      ...viewport,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    })
    await inspectMobile(page, `${surface}-${viewport.width}`)
  }
}

async function fillNames(page, count) {
  for (let index = 0; index < count; index += 1) {
    await page.type(
      `input[aria-label="Tên người chơi ${index + 1}"]`,
      `Người ${index + 1}`,
    )
  }
}

try {
  const page = await browser.newPage()
  page.setDefaultTimeout(20_000)
  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  })
  const supabaseRequests = []
  page.on('request', (request) => {
    if (/\.supabase\.co/i.test(request.url())) supabaseRequests.push(request.url())
  })

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  const offlineEntry = await page.$eval(
    '.entry-actions a:last-child',
    (link) => link.textContent?.trim(),
  )
  invariant(offlineEntry === 'QUẢN TRÒ 1 MÁY', 'Landing thiếu entry Offline.')
  await page.evaluate(
    (key, value) => localStorage.setItem(key, value),
    onlineKey,
    '{"online":"untouched"}',
  )
  await page.click('.entry-actions a:last-child')
  await page.waitForSelector('.offline-setup-layout')
  await inspectMobileViewports(page, 'setup-7')
  await fillNames(page, 7)
  await page.click('.offline-sticky-footer .button.primary')
  await page.waitForSelector('.offline-checkpoint-layout')
  const physicalDealState = await page.evaluate((key) => {
    return JSON.parse(localStorage.getItem(key))
  }, offlineKey)
  invariant(physicalDealState.phase === 'PHYSICAL_DEAL', 'Không vào checkpoint chia bài.')
  invariant(physicalDealState.roleAssignments.length === 0, 'Ứng dụng đã tự gán vai.')
  invariant(physicalDealState.playerNames.length === 7, 'Setup 7 người không bền.')
  await inspectMobileViewports(page, 'physical-deal')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-checkpoint-layout')
  await page.click('.offline-primary-action')
  await page.waitForSelector('.offline-holder-selector')
  invariant(
    (await page.$$('.offline-holder-selector button')).length === 7,
    'Wolf holder selector không có đủ 7 người chưa gán.',
  )
  await inspectMobileViewports(page, 'wolf-holder')
  await page.click('.offline-holder-selector button:nth-child(1)')
  await page.click('.offline-holder-selector button:nth-child(2)')
  await page.click('.offline-holder-panel .offline-primary-action')
  await page.waitForSelector('.offline-action-handoff')
  let targets = await page.$$eval(
    '.offline-action-targets strong',
    (nodes) => nodes.map((node) => node.textContent?.trim()),
  )
  invariant(!targets.includes('Người 1') && !targets.includes('Người 2'), 'Wolf được target chính Wolf.')
  await inspectMobileViewports(page, 'wolf-role-action')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-action-handoff')
  await page.click('.offline-action-handoff .offline-primary-action')
  await page.waitForSelector('.offline-holder-selector')
  const laterHolders = await page.$$eval(
    '.offline-holder-selector strong',
    (nodes) => nodes.map((node) => node.textContent?.trim()),
  )
  invariant(!laterHolders.includes('Người 1') && !laterHolders.includes('Người 2'), 'Holder đã gán vẫn xuất hiện.')
  invariant(laterHolders.length === 5, 'Holder selector sau Wolf phải còn 5 người.')
  await page.click('.offline-holder-selector button:nth-child(1)')
  await page.click('.offline-holder-panel .offline-primary-action')
  await page.waitForSelector('.offline-action-handoff')
  targets = await page.$$eval(
    '.offline-action-targets strong',
    (nodes) => nodes.map((node) => node.textContent?.trim()),
  )
  invariant(targets.includes('Người 1'), 'Holder đã gán bị loại sai khỏi action target.')
  invariant(!targets.includes('Người 3'), 'Tiên Tri được target chính mình.')
  await page.click('.offline-action-handoff .offline-primary-action')
  await page.waitForSelector('.offline-ready-layout')
  const completed = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), offlineKey)
  invariant(completed.roleAssignments.length === 7, 'Không gán đủ 7 vai.')
  invariant(
    completed.roleAssignments.filter((entry) => entry.roleId === 'villager').length === 4,
    'Không auto-assign đúng 4 Dân Làng.',
  )
  invariant(
    new Set(completed.roleAssignments.map((entry) => entry.playerId)).size === 7,
    'Có duplicate holder.',
  )
  await inspectMobileViewports(page, 'night-one-ready')

  await page.evaluate((key) => localStorage.removeItem(key), offlineKey)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.select('.offline-basics select', '16')
  await fillNames(page, 16)
  await page.click('.offline-sticky-footer .button.primary')
  await page.waitForSelector('.offline-checkpoint-layout')
  const sixteen = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), offlineKey)
  invariant(sixteen.seatCount === 16 && sixteen.playerNames.length === 16, 'Setup 16 người thất bại.')
  invariant(sixteen.roleAssignments.length === 0, 'Setup 16 đã tự assignment.')
  await inspectMobileViewports(page, 'physical-deal-16')

  await page.evaluate((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        schemaVersion: 3,
        mode: 'OFFLINE_MODERATOR',
        phase: 'NIGHT_1_DISCOVERY',
        seatCount: 7,
        playerNames: Array.from({ length: 7 }, (_, index) => `Người ${index + 1}`),
        roleComposition: { villager: 6, mayor: 1 },
        roleAssignments: [{ playerId: 'offline-player-1', roleId: 'mayor' }],
        offlineEvents: [{
          id: 'offline-role-discovery-mayor-1',
          type: 'ROLE_IDENTITY_DISCOVERED',
          occurredAt: 1,
          roleId: 'mayor',
          holderPlayerIds: ['offline-player-1'],
        }],
        nightOne: {
          callPlan: ['mayor'],
          callIndex: 0,
          activeStep: { kind: 'ROLE_ACTION', roleId: 'mayor', actionType: 'NONE' },
          draftHolderIds: [],
        },
        authority: null,
        authorityInput: {
          cupidTargetIds: [],
          witchResurrectionTargetId: null,
          witchPoisonTargetId: null,
          dayVoterId: null,
        },
        blockingError: null,
        updatedAt: 1,
      }),
    )
  }, offlineKey)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-no-action')
  const ritualLabel = await page.$eval(
    '.offline-action-handoff .offline-primary-action',
    (button) => button.textContent?.trim(),
  )
  invariant(ritualLabel === '[ĐÃ GỌI — ĐI NGỦ]', 'No-action ritual sai nhãn.')
  await page.click('.offline-action-handoff .offline-primary-action')
  await page.waitForSelector('.offline-ready-layout')
  const noActionComplete = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    offlineKey,
  )
  invariant(
    noActionComplete.roleAssignments.filter((entry) => entry.roleId === 'villager').length === 6,
    'No-action ritual không hoàn tất đúng Villager invariant.',
  )

  const onlineValue = await page.evaluate((key) => localStorage.getItem(key), onlineKey)
  invariant(onlineValue === '{"online":"untouched"}', 'Offline làm thay đổi Online storage.')
  invariant(supabaseRequests.length === 0, 'Offline đã gọi Supabase.')

  console.log('PASS landing entry + isolated/versioned Offline storage + no Supabase calls')
  console.log('PASS 7/16 setup + physical deal checkpoint + refresh durability')
  console.log('PASS exact Wolf/singleton discovery + no duplicate holder')
  console.log('PASS holder/action-target separation + exact Villager auto-assignment')
  console.log('PASS configured no-action role ritual [ĐÃ GỌI — ĐI NGỦ]')
  console.log('PASS mobile 320/360/390/430px no horizontal overflow + controls >=44px + no artwork')
} finally {
  await browser.close()
  await server.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
