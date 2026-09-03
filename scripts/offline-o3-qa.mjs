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

const offlineV5Key = 'masoi.offline-moderator.session.v5'
const offlineV4Key = 'masoi.offline-moderator.session.v4'
const offlineV2Key = 'masoi.offline-moderator.session.v2'
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

function roleComposition(roleIds) {
  return roleIds.reduce((composition, roleId) => {
    composition[roleId] = (composition[roleId] ?? 0) + 1
    return composition
  }, {})
}

function callPlanFor(roleIds) {
  const configured = new Set(roleIds)
  return [
    'cupid', 'traitor', 'werewolf', 'seer', 'protector', 'half-wolf',
    'serial-killer', 'hunter', 'witch', 'mayor', 'fool',
  ].filter((roleId) => configured.has(roleId))
}

function readyState(roleIds, version = 4) {
  const callPlan = callPlanFor(roleIds)
  const state = {
    schemaVersion: version,
    mode: 'OFFLINE_MODERATOR',
    phase: 'NIGHT_1_READY',
    seatCount: roleIds.length,
    playerNames: roleIds.map((_, index) => `Người ${index + 1}`),
    roleComposition: roleComposition(roleIds),
    roleAssignments: roleIds.map((roleId, index) => ({
      playerId: `offline-player-${index + 1}`,
      roleId,
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
      ...(version >= 4
        ? {
            dayDecision: {
              stage: 'CANDIDATE_DRAFT',
              selection: { kind: 'UNSET' },
            },
          }
        : { dayVoterId: null }),
    },
    blockingError: null,
    updatedAt: 100,
  }
  if (version >= 3) {
    state.offlineEvents = callPlan.map((roleId, index) => ({
      id: `offline-role-discovery-${roleId}-${index + 1}`,
      type: 'ROLE_IDENTITY_DISCOVERED',
      occurredAt: index + 1,
      roleId,
      holderPlayerIds: roleIds.flatMap((candidate, playerIndex) =>
        candidate === roleId ? [`offline-player-${playerIndex + 1}`] : []
      ),
    }))
  }
  return state
}

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
      const controls = [...document.querySelectorAll(
        'main button, main input, main select, main a[data-required-control]',
      )]
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
      }
    })
    invariant(!metrics.overflow, `${surface}-${viewport.width}: horizontal overflow.`)
    invariant(metrics.minWidth >= 44, `${surface}-${viewport.width}: control width <44.`)
    invariant(metrics.minHeight >= 44, `${surface}-${viewport.width}: control height <44.`)
    invariant(metrics.artwork === 0, `${surface}: Offline hiện card artwork.`)
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms-o3-'))
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  userDataDir: profile,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})

try {
  const page = await browser.newPage()
  page.setDefaultTimeout(20_000)
  const supabaseRequests = []
  page.on('request', (request) => {
    if (/\.supabase\.co/i.test(request.url())) supabaseRequests.push(request.url())
  })

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  invariant(
    (await page.$eval('.offline-entry-state', (node) => node.textContent)).includes('Chưa có ván Offline'),
    'Landing không phân biệt trạng thái chưa có bản lưu.',
  )

  const roles = [
    'werewolf', 'seer', 'protector', 'witch',
    'villager', 'villager', 'villager',
  ]
  await page.evaluate(
    ({ key, state, onlineStorageKey }) => {
      localStorage.setItem(key, JSON.stringify(state))
      localStorage.setItem(onlineStorageKey, '{"online":"untouched-o3"}')
    },
    { key: offlineV2Key, state: readyState(roles, 2), onlineStorageKey: onlineKey },
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  const activeLanding = await page.$eval('.offline-entry-state', (node) => node.textContent)
  invariant(activeLanding.includes('Đang có một ván Offline'), 'Landing thiếu trạng thái active.')
  invariant(
    (await page.$eval('.offline-entry-action', (node) => node.textContent)).includes('TIẾP TỤC VÁN OFFLINE'),
    'Landing thiếu Resume active.',
  )
  await inspectViewports(page, 'landing-active-resume')
  await clickByText(page, '.offline-entry-action', 'TIẾP TỤC')
  await page.waitForSelector('.offline-checkpoint-layout')
  await page.waitForFunction((key) => localStorage.getItem(key), {}, offlineV5Key)
  const migrated = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    offlineV5Key,
  )
  invariant(migrated.schemaVersion === 5, 'Không migrate v2 → v5.')
  invariant(migrated.offlineEvents.length === 4, 'Migration mất role-discovery truth.')
  invariant(
    migrated.offlineEvents.find((event) => event.roleId === 'werewolf')
      ?.holderPlayerIds.length === 1,
    'Migration sai holder Ma Sói.',
  )

  await page.click('.offline-checkpoint-layout .offline-primary-action')
  await page.click('.offline-next-call .button.primary')
  await clickByText(page, '.offline-match-targets button', 'Người 5')
  await page.click('.offline-action-card > .button.primary')
  await page.click('.offline-call-complete .button.primary')
  await page.click('.offline-next-call .button.primary')
  await clickByText(page, '.offline-match-targets button', 'Người 1')
  await page.click('.offline-action-card > .button.primary')
  await page.click('.offline-seer-result .button.primary')
  await page.click('.offline-call-complete .button.primary')
  await page.click('.offline-next-call .button.primary')
  await clickByText(page, '.offline-match-targets button', 'Người 6')
  await page.click('.offline-action-card > .button.primary')
  await page.click('.offline-call-complete .button.primary')
  await page.click('.offline-next-call .button.primary')
  await clickByText(
    page,
    '.offline-witch-action section:first-child .offline-match-targets button',
    'Người 5',
  )
  await page.click('.offline-witch-action > .button.primary')
  await page.click('.offline-call-complete .button.primary')
  await page.click('.offline-night-finalize .button.primary')
  await page.waitForSelector('.offline-morning-checkpoint')

  await page.click('.offline-session-tools .button')
  await page.waitForSelector('.moderator-journal-view')
  const firstJournalText = await page.$eval(
    '.moderator-journal-view',
    (node) => node.textContent,
  )
  for (const expected of [
    'Ma Sói: Người 1',
    'Tiên Tri: Người 2',
    'Bảo Vệ: Người 3',
    'Phù Thủy: Người 4',
    'Ma Sói chọn Người 5',
    'Tiên Tri soi Người 1 → Sói',
    'Bảo Vệ bảo vệ Người 6',
    'Phù Thủy hồi sinh Người 5',
  ]) {
    invariant(firstJournalText.includes(expected), `Journal thiếu: ${expected}`)
  }
  invariant(!firstJournalText.includes('Người 5 chết'), 'Witch rescue tạo false final death.')
  invariant(!firstJournalText.includes('ĐI NGỦ'), 'Journal ghi ritual wake/sleep.')
  await inspectViewports(page, 'offline-journal')
  const journalLineCount = await page.$$('.moderator-journal-section li')
  const beforeReload = await page.evaluate((key) => localStorage.getItem(key), offlineV5Key)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-morning-checkpoint')
  invariant(
    (await page.evaluate((key) => localStorage.getItem(key), offlineV5Key)) === beforeReload,
    'Reload làm đổi hoặc replay authoritative snapshot.',
  )
  await page.click('.offline-session-tools .button')
  invariant(
    (await page.$$('.moderator-journal-section li')).length === journalLineCount.length,
    'Reload làm trùng Journal events.',
  )
  await page.click('.moderator-journal-heading .button')

  await page.click('.offline-morning-checkpoint .button.primary')
  await clickByText(page, '.offline-day-decision > .button.secondary', 'KHÔNG CÓ AI')
  await clickByText(page, '.offline-final-confirmation .button.primary', 'XÁC NHẬN KHÔNG CÓ AI')
  await page.click('.offline-session-tools .button')
  const dayJournal = await page.$eval('.moderator-journal-view', (node) => node.textContent)
  invariant(dayJournal.includes('Không ai được đưa lên trăng trối'), 'Journal thiếu no-candidate Day result.')
  invariant(!dayJournal.includes('Phiếu của'), 'Journal lộ phiếu từng người.')
  await page.click('.moderator-journal-heading .button')

  const activeSnapshot = await page.evaluate((key) => localStorage.getItem(key), offlineV5Key)
  await page.click('.topbar nav > a')
  await page.waitForSelector('.entry-actions')
  invariant(
    (await page.$eval('.offline-entry-state', (node) => node.textContent)).includes('chưa kết thúc'),
    'Landing mất trạng thái active session.',
  )
  await clickByText(page, '.offline-entry-action', 'TIẾP TỤC')
  await page.waitForSelector('.offline-day-result')
  invariant(
    (await page.evaluate((key) => localStorage.getItem(key), offlineV5Key)) === activeSnapshot,
    'Resume active làm thay đổi snapshot.',
  )

  const villagerState = readyState(Array.from({ length: 7 }, () => 'villager'))
  await page.evaluate(({ currentKey, legacyKey, state }) => {
    localStorage.removeItem(currentKey)
    localStorage.setItem(legacyKey, JSON.stringify(state))
  }, { currentKey: offlineV5Key, legacyKey: offlineV4Key, state: villagerState })
  await page.goto(`${origin}/?screen=offline`, { waitUntil: 'domcontentloaded' })
  await page.click('.offline-checkpoint-layout .offline-primary-action')
  await page.waitForSelector('.moderator-end-match')
  invariant(
    !(await page.evaluate(() => document.body.textContent?.includes('Chơi lại'))),
    'FINISHED hiển thị Play Again.',
  )
  await inspectViewports(page, 'offline-finished')
  const finishedSnapshot = await page.evaluate((key) => localStorage.getItem(key), offlineV5Key)
  await clickByText(page, '.moderator-end-actions a', 'Về trang chủ')
  await page.waitForSelector('.offline-entry-state')
  const finishedLanding = await page.$eval('.offline-entry-state', (node) => node.textContent)
  invariant(finishedLanding.includes('đã kết thúc'), 'Landing thiếu trạng thái finished.')
  invariant(
    (await page.$eval('.offline-entry-action', (node) => node.textContent)).includes('VÁN OFFLINE ĐÃ XONG'),
    'Landing thiếu finished resume.',
  )
  await clickByText(page, '.offline-entry-action', 'XEM VÁN')
  await page.waitForSelector('.moderator-end-match')
  invariant(
    (await page.evaluate((key) => localStorage.getItem(key), offlineV5Key)) === finishedSnapshot,
    'Resume FINISHED làm replay outcome.',
  )

  await clickByText(page, '.moderator-end-actions a', 'Về trang chủ')
  await page.waitForSelector('.offline-entry-state')
  await clickByText(page, '.offline-entry-state a', 'Bắt đầu ván Offline mới')
  await page.waitForSelector('.offline-replacement-layout')
  invariant(
    (await page.evaluate((key) => localStorage.getItem(key), offlineV5Key)) === finishedSnapshot,
    'Mở New intent đã âm thầm ghi đè ván cũ.',
  )
  await inspectViewports(page, 'offline-destructive-confirmation')
  await clickByText(page, '.offline-replacement-actions button', 'Xóa và bắt đầu mới')
  await page.waitForSelector('.offline-setup-layout')
  const replacement = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), offlineV5Key)
  invariant(
    replacement.schemaVersion === 5 &&
      replacement.phase === 'SETUP' &&
      replacement.authority === null &&
      replacement.offlineEvents.length === 0,
    'Destructive confirmation không tạo session v5 sạch.',
  )

  await page.evaluate((key) => localStorage.setItem(key, '{bad json'), offlineV5Key)
  await page.goto(`${origin}/?screen=offline`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-replacement-layout')
  invariant(
    (await page.$eval('.offline-replacement-layout', (node) => node.textContent)).includes('Bản lưu không thể đọc'),
    'Corrupt snapshot không fail-safe.',
  )
  invariant(
    (await page.evaluate((key) => localStorage.getItem(key), offlineV5Key)) === '{bad json',
    'Corrupt snapshot bị tự động ghi đè.',
  )

  invariant(
    (await page.evaluate((key) => localStorage.getItem(key), onlineKey)) ===
      '{"online":"untouched-o3"}',
    'O3 thay đổi Online storage.',
  )
  invariant(supabaseRequests.length === 0, 'O3 Offline gọi Supabase.')

  console.log('PASS typed Offline Journal role truth + meaningful chronology + Witch rescue truth')
  console.log('PASS Moderator Day outcome only + no ritual/voter-choice disclosure')
  console.log('PASS v2→v5 migration + exact reload/resume + duplicate-free Journal')
  console.log('PASS active/finished resume + explicit destructive new-session confirmation')
  console.log('PASS corrupt snapshot fail-safe + Online storage isolation + no Supabase')
  console.log('PASS Moderator mobile 320/360/390/430px + no overflow/artwork + >=44px controls')
} finally {
  await browser.close()
  await server.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
