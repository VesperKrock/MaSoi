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

const offlineKey = 'masoi.offline-moderator.session.v4'
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

function readyState(roleIds) {
  const composition = {}
  for (const roleId of roleIds) composition[roleId] = (composition[roleId] ?? 0) + 1
  const order = [
    'cupid',
    'traitor',
    'werewolf',
    'seer',
    'protector',
    'half-wolf',
    'serial-killer',
    'hunter',
    'witch',
    'mayor',
    'fool',
  ]
  const callPlan = order.filter((roleId) => (composition[roleId] ?? 0) > 0)
  return {
    schemaVersion: 4,
    mode: 'OFFLINE_MODERATOR',
    phase: 'NIGHT_1_READY',
    seatCount: roleIds.length,
    playerNames: roleIds.map((_, index) => `Người ${index + 1}`),
    roleComposition: composition,
    roleAssignments: roleIds.map((roleId, index) => ({
      playerId: `offline-player-${index + 1}`,
      roleId,
    })),
    offlineEvents: callPlan.map((roleId, index) => ({
      id: `offline-role-discovery-${roleId}-${index + 1}`,
      type: 'ROLE_IDENTITY_DISCOVERED',
      occurredAt: index + 1,
      roleId,
      holderPlayerIds: roleIds.flatMap((candidate, playerIndex) =>
        candidate === roleId ? [`offline-player-${playerIndex + 1}`] : []
      ),
    })),
    nightOne: {
      callPlan,
      callIndex: callPlan.length,
      activeStep: null,
      draftHolderIds: [],
    },
    authority: null,
    authorityInput: {
      cupidTargetIds: [],
      witchResurrectionTargetId: null,
      witchPoisonTargetId: null,
      dayDecision: {
        stage: 'CANDIDATE_DRAFT',
        selection: { kind: 'UNSET' },
      },
    },
    blockingError: null,
    updatedAt: 1,
  }
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms-o2-'))
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  userDataDir: profile,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})

async function clickByText(page, selector, text) {
  const clicked = await page.$$eval(
    selector,
    (nodes, expected) => {
      const node = nodes.find((entry) => entry.textContent?.includes(expected))
      if (!(node instanceof HTMLElement)) return false
      node.click()
      return true
    },
    text,
  )
  invariant(clicked, `Không tìm thấy ${selector} có text ${text}.`)
}

async function inspectViewports(page, surface) {
  for (const viewport of mobileViewports) {
    await page.setViewport({
      ...viewport,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    })
    const metrics = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('main button, main input, main select')]
        .filter((element) => {
          const style = getComputedStyle(element)
          return style.display !== 'none' && style.visibility !== 'hidden'
        })
        .map((element) => element.getBoundingClientRect())
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        minWidth: controls.length ? Math.min(...controls.map((rect) => rect.width)) : 44,
        minHeight: controls.length ? Math.min(...controls.map((rect) => rect.height)) : 44,
        artwork: document.querySelectorAll('main img').length,
        livePackMarkers: document.querySelectorAll('.wolf-peer-marker').length,
      }
    })
    invariant(!metrics.overflow, `${surface}-${viewport.width}: horizontal overflow.`)
    invariant(metrics.minWidth >= 44, `${surface}-${viewport.width}: control width <44.`)
    invariant(metrics.minHeight >= 44, `${surface}-${viewport.width}: control height <44.`)
    invariant(metrics.artwork === 0, `${surface}: Offline hiện card artwork.`)
    invariant(metrics.livePackMarkers === 0, `${surface}: Offline hiện live-pack marker.`)
  }
}

try {
  const page = await browser.newPage()
  page.setDefaultTimeout(20_000)
  const supabaseRequests = []
  page.on('request', (request) => {
    if (/\.supabase\.co/i.test(request.url())) supabaseRequests.push(request.url())
  })
  await page.goto(`${origin}/?screen=offline`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    (key, value) => localStorage.setItem(key, value),
    onlineKey,
    '{"online":"untouched-o2"}',
  )
  await page.evaluate(
    (key, state) => localStorage.setItem(key, JSON.stringify(state)),
    offlineKey,
    readyState([
      'werewolf',
      'werewolf',
      'seer',
      'villager',
      'villager',
      'villager',
      'villager',
    ]),
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.click('.offline-final-roster .offline-primary-action')
  await page.waitForSelector('.offline-match-layout')
  await inspectViewports(page, 'night-1-ready')

  await page.click('.offline-next-call .button.primary')
  await page.waitForSelector('.offline-active-call')
  const wolfHasNoAbstain = !(await page.$('.offline-active-call .button.secondary'))
  invariant(wolfHasNoAbstain, 'Wolf Offline có lựa chọn Không chọn.')
  await clickByText(page, '.offline-match-targets button', 'Người 4')
  await page.waitForSelector('.offline-next-call')
  await page.click('.offline-next-call .button.primary')
  await clickByText(page, '.offline-match-targets button', 'Người 1')
  await page.waitForSelector('.offline-seer-result')

  const midSeer = await page.evaluate((key) => localStorage.getItem(key), offlineKey)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-seer-result')
  invariant(
    (await page.evaluate((key) => localStorage.getItem(key), offlineKey)) === midSeer,
    'Refresh giữa action Tiên Tri làm đổi authority state.',
  )
  await page.click('.offline-seer-result .button.primary')
  await page.waitForSelector('.offline-night-finalize')
  await page.click('.offline-night-finalize .button.primary')
  await page.waitForSelector('.offline-morning-checkpoint')
  const morningText = await page.$eval(
    '.offline-morning-checkpoint',
    (node) => node.textContent,
  )
  invariant(morningText.includes('Người 4'), 'Morning không công bố đúng final death.')
  await inspectViewports(page, 'morning-checkpoint')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.click('.offline-morning-checkpoint .button.primary')
  await page.waitForSelector('.offline-day-discussion')
  await clickByText(page, '.offline-day-decision > .button.secondary', 'KHÔNG CÓ AI')
  await clickByText(page, '.offline-final-confirmation .button.primary', 'XÁC NHẬN KHÔNG CÓ AI')
  await page.waitForSelector('.offline-day-result')
  const dayResult = await page.$eval('.offline-day-result h2', (node) => node.textContent)
  invariant(dayResult.includes('Không ai được đưa lên trăng trối'), 'No-candidate Day không ra nobody.')
  await inspectViewports(page, 'day-result')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.click('.offline-day-result .button.primary')
  await page.waitForSelector('.offline-next-call')
  const nightTwo = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), offlineKey)
  invariant(nightTwo.authority.dayNumber === 2, 'Không chuyển đúng sang Đêm 2.')
  invariant(
    nightTwo.authority.night.calls.every((call) => call.status === 'NOT_CALLED'),
    'Night actions/calls không reset.',
  )
  invariant(
    !(await page.evaluate(() => document.body.textContent?.includes('AI LÀ'))),
    'Đêm 2 hỏi lại holder.',
  )

  await page.evaluate(
    (key, state) => localStorage.setItem(key, JSON.stringify(state)),
    offlineKey,
    readyState(Array.from({ length: 7 }, () => 'villager')),
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.click('.offline-final-roster .offline-primary-action')
  await page.waitForSelector('.moderator-end-match')
  invariant((await page.$$('.moderator-final-roster .final-roster-row')).length === 7, 'Final roster thiếu người.')
  invariant(
    (await page.$eval('.moderator-end-actions button', (button) => button.textContent)).includes('Nhật ký'),
    'Offline terminal thiếu Journal.',
  )
  invariant(
    !(await page.evaluate(() => document.body.textContent?.includes('Chơi lại'))),
    'Offline terminal hiển thị Play Again.',
  )
  const finishedBeforeReload = await page.evaluate((key) => localStorage.getItem(key), offlineKey)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.moderator-end-match')
  invariant(
    (await page.evaluate((key) => localStorage.getItem(key), offlineKey)) === finishedBeforeReload,
    'FINISHED refresh làm replay hoặc đổi state.',
  )
  await inspectViewports(page, 'finished')

  invariant(
    (await page.evaluate((key) => localStorage.getItem(key), onlineKey)) ===
      '{"online":"untouched-o2"}',
    'O2 làm thay đổi Online storage.',
  )
  invariant(supabaseRequests.length === 0, 'O2 Offline gọi Supabase.')

  console.log('PASS Offline Moderator one-target Wolf + Seer + final Night deaths')
  console.log('PASS exact refresh at Night action, Morning, Day, Next Night and FINISHED')
  console.log('PASS local no-candidate Day verdict + explicit Next Night + no holder rediscovery')
  console.log('PASS terminal winner/original roster + Journal handoff + no Play Again')
  console.log('PASS mobile 320/360/390/430px + no overflow/artwork/live-pack markers')
  console.log('PASS Offline storage isolation + no Supabase calls')
} finally {
  await browser.close()
  await server.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
