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

const offlineKey = 'masoi.offline-moderator.session.v5'
const onlineKey = 'masoi.ms0b.rooms.v1'
const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function physicalState() {
  return {
    schemaVersion: 5,
    mode: 'OFFLINE_MODERATOR',
    phase: 'PHYSICAL_DEAL',
    seatCount: 8,
    playerNames: Array.from({ length: 8 }, (_, index) => `Người ${index + 1}`),
    roleComposition: {
      villager: 2,
      werewolf: 2,
      traitor: 1,
      seer: 1,
      protector: 1,
      witch: 1,
    },
    roleAssignments: [],
    offlineEvents: [],
    nightRitual: {
      callPlan: ['werewolf', 'seer', 'protector', 'witch'],
      callIndex: 0,
      activeStep: null,
      draftHolderIdsByRole: {},
    },
    authority: null,
    authorityInput: {
      cupidTargetIds: [],
      nightTargetDraft: { kind: 'UNSET' },
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

function passiveState() {
  const roleIds = [
    'werewolf', 'werewolf', 'fool',
    'villager', 'villager', 'villager', 'villager',
  ]
  return {
    ...physicalState(),
    seatCount: 7,
    playerNames: roleIds.map((_, index) => `Người ${index + 1}`),
    roleComposition: { werewolf: 2, fool: 1, villager: 4 },
    roleAssignments: roleIds.map((roleId, index) => ({
      playerId: `offline-player-${index + 1}`,
      roleId,
    })),
    offlineEvents: [],
    nightRitual: {
      callPlan: ['werewolf', 'fool'],
      callIndex: 0,
      activeStep: null,
      draftHolderIdsByRole: {},
    },
  }
}

async function saved(page) {
  await page.waitForFunction((key) => localStorage.getItem(key), {}, offlineKey)
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), offlineKey)
}

async function clickByText(page, selector, text) {
  const clicked = await page.$$eval(selector, (nodes, expected) => {
    const node = nodes.find((entry) => entry.textContent?.includes(expected))
    if (!(node instanceof HTMLElement)) return false
    node.click()
    return true
  }, text)
  invariant(clicked, `Không tìm thấy ${selector} có text ${text}.`)
}

async function inspectMobile(page, surface) {
  for (const viewport of viewports) {
    await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
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
      }
    })
    invariant(!metrics.overflow, `${surface}-${viewport.width}: horizontal overflow.`)
    invariant(metrics.minWidth >= 44, `${surface}-${viewport.width}: control width <44.`)
    invariant(metrics.minHeight >= 44, `${surface}-${viewport.width}: control height <44.`)
  }
}

async function seed(page, state) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.evaluate(({ offlineStorageKey, onlineStorageKey, value }) => {
    localStorage.clear()
    localStorage.setItem(offlineStorageKey, JSON.stringify(value))
    localStorage.setItem(onlineStorageKey, '{"online":"untouched-hf4"}')
  }, { offlineStorageKey: offlineKey, onlineStorageKey: onlineKey, value: state })
  await page.goto(`${origin}/?screen=offline`, { waitUntil: 'domcontentloaded' })
}

const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite QA server không khởi động.')
const origin = `http://127.0.0.1:${address.port}`
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms-hf4-'))
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

  await seed(page, physicalState())
  await page.waitForSelector('.offline-checkpoint-layout')
  await inspectMobile(page, 'physical-deal')
  await clickByText(page, '.offline-primary-action', 'Bắt đầu Đêm 1')
  await page.waitForSelector('.offline-next-call')
  let state = await saved(page)
  invariant(state.phase === 'MATCH', 'Physical Deal không vào thẳng Night 1.')
  invariant(state.roleAssignments.length === 0, 'Night 1 còn gate yêu cầu mọi holder.')

  await clickByText(page, '.offline-next-call button', 'GỌI PHE SÓI')
  await page.waitForSelector('.offline-interleaved-discovery')
  invariant(
    (await page.$$('.offline-holder-group')).length === 2,
    'Wolf faction không có hai section Ma Sói + Kẻ Phản Bội.',
  )
  await inspectMobile(page, 'wolf-group-discovery')
  const wolfSelector = '.offline-holder-selector[aria-label="Người giữ vai Ma Sói"] button'
  const traitorSelector = '.offline-holder-selector[aria-label="Người giữ vai Kẻ Phản Bội"] button'
  await page.click(`${wolfSelector}:nth-child(1)`)
  await page.click(`${wolfSelector}:nth-child(2)`)
  await page.click(`${traitorSelector}:nth-child(3)`)
  state = await saved(page)
  invariant(state.nightRitual.draftHolderIdsByRole.werewolf.length === 2, 'Draft Wolf sai số lượng.')
  invariant(state.nightRitual.draftHolderIdsByRole.traitor.length === 1, 'Draft Traitor sai số lượng.')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-interleaved-discovery')
  await clickByText(page, '.offline-interleaved-discovery > button', 'Xác nhận holder')
  await page.waitForSelector('.offline-action-card')
  state = await saved(page)
  invariant(state.roleAssignments.length === 3, 'Wolf holder không persist ngay.')
  invariant(state.authority.night.actionsByRole.werewolf.eligibleActorIds.length === 3, 'Traitor không thức cùng Wolves.')
  invariant(Object.keys(state.authority.night.actionsByRole).length === 1, 'Traitor tạo thêm action.')
  const wolfTargets = await page.$$eval(
    '.offline-match-targets strong',
    (nodes) => nodes.map((node) => node.textContent?.trim()),
  )
  invariant(wolfTargets.includes('Người 4'), 'UNKNOWN-role player biến mất khỏi Wolf target.')
  await inspectMobile(page, 'wolf-immediate-action')
  await clickByText(page, '.offline-match-targets button', 'Người 4')
  state = await saved(page)
  invariant(state.authorityInput.nightTargetDraft.playerId === 'offline-player-4', 'Wolf draft không persist.')
  await page.reload({ waitUntil: 'domcontentloaded' })
  invariant((await page.$('.offline-match-targets button.selected')) !== null, 'Refresh mất Wolf action draft.')
  await clickByText(page, '.offline-action-card > button.primary', 'Xác nhận hành động')
  await page.waitForSelector('.offline-call-complete')
  state = await saved(page)
  const wolfJournalCount = state.authority.journal.length
  invariant(state.authority.night.actionsByRole.werewolf.result.targetId === 'offline-player-4', 'Wolf action không confirm.')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-call-complete')
  invariant((await saved(page)).authority.journal.length === wolfJournalCount, 'Refresh lặp Wolf action.')
  await clickByText(page, '.offline-call-complete button', 'Tiếp tục')

  await clickByText(page, '.offline-next-call button', 'GỌI TIÊN TRI')
  await clickByText(page, '.offline-holder-selector button', 'Người 4')
  await clickByText(page, '.offline-interleaved-discovery > button', 'Xác nhận holder')
  await page.waitForSelector('.offline-action-card')
  state = await saved(page)
  invariant(state.authority.night.calls[0].status === 'COMPLETED', 'Seer mở trước khi Wolf hoàn tất.')
  invariant(
    !state.roleAssignments.some((entry) => entry.playerId === 'offline-player-5'),
    'Seer target dự kiến không còn UNKNOWN.',
  )
  await clickByText(page, '.offline-match-targets button', 'Người 5')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-match-targets button.selected')
  await clickByText(page, '.offline-action-card > button.primary', 'Xác nhận hành động')
  await page.waitForSelector('.offline-seer-result')
  invariant(
    (await page.$eval('.offline-seer-result strong', (node) => node.textContent?.trim())) === 'KHÔNG PHẢI SÓI',
    'Seer classification không dùng SÓI / KHÔNG PHẢI SÓI.',
  )
  await inspectMobile(page, 'seer-result')
  const seerJournalCount = (await saved(page)).authority.journal.length
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-seer-result')
  invariant((await saved(page)).authority.journal.length === seerJournalCount, 'Refresh lặp Seer result.')
  await page.click('.offline-seer-result .button.primary')
  await page.waitForSelector('.offline-call-complete')
  await clickByText(page, '.offline-call-complete button', 'Tiếp tục')

  await clickByText(page, '.offline-next-call button', 'GỌI BẢO VỆ')
  await clickByText(page, '.offline-holder-selector button', 'Người 5')
  await clickByText(page, '.offline-interleaved-discovery > button', 'Xác nhận holder')
  await clickByText(page, '.offline-match-targets button', 'Người 8')
  await clickByText(page, '.offline-action-card > button.primary', 'Xác nhận hành động')
  await clickByText(page, '.offline-call-complete button', 'Tiếp tục')

  await clickByText(page, '.offline-next-call button', 'GỌI PHÙ THỦY')
  await clickByText(page, '.offline-holder-selector button', 'Người 6')
  await clickByText(page, '.offline-interleaved-discovery > button', 'Xác nhận holder')
  await page.waitForSelector('.offline-witch-action')
  state = await saved(page)
  invariant(state.authority.nightResolution.provisionalDeathCandidateIds.includes('offline-player-4'), 'Witch mở thiếu provisional death.')
  invariant(state.roleAssignments.filter((entry) => entry.roleId === 'villager').length === 2, 'Villager không auto-assign đúng điểm hoàn tất khám phá.')
  await page.click('.offline-witch-action > .button.primary')
  await page.waitForSelector('.offline-call-complete')

  await seed(page, passiveState())
  await page.click('.offline-primary-action')
  await page.click('.offline-next-call .button.primary')
  await clickByText(page, '.offline-match-targets button', 'Người 4')
  await clickByText(page, '.offline-action-card > button.primary', 'Xác nhận hành động')
  await clickByText(page, '.offline-call-complete button', 'Tiếp tục')
  await clickByText(page, '.offline-next-call button', 'GỌI THẰNG NGỐ')
  await page.waitForSelector('.offline-active-call')
  invariant(
    (await page.$eval('.offline-active-call h2', (node) => node.textContent)).includes('NGỦ ĐI'),
    'Passive role không có ritual ngủ.',
  )
  await inspectMobile(page, 'passive-role')
  const passiveBefore = JSON.stringify(await saved(page))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-active-call')
  invariant(JSON.stringify(await saved(page)) === passiveBefore, 'Refresh restart passive call.')

  invariant(
    (await page.evaluate((key) => localStorage.getItem(key), onlineKey)) === '{"online":"untouched-hf4"}',
    'HF4 thay đổi Online storage.',
  )
  invariant(supabaseRequests.length === 0, 'HF4 Offline gọi Supabase.')

  console.log('PASS Physical Deal → immediate Night 1 with no discover-all gate')
  console.log('PASS grouped 2-Wolf + Traitor discovery → one immediate mandatory attack')
  console.log('PASS UNKNOWN-role action targets + Seer immediate result + Wolf-before-Seer')
  console.log('PASS Protector/Witch provisional-death dependency + exact Villager auto-assign')
  console.log('PASS holder/action drafts, confirmed actions, result, sleep and refresh boundaries')
  console.log('PASS passive ritual + no duplicate holder/action/call replay')
  console.log('PASS mobile 320/360/390/430 + Online storage isolation + no Supabase')
} finally {
  await browser.close()
  await server.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
