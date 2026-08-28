import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const executablePath = candidates.find((candidate) => fs.existsSync(candidate))
if (!executablePath) throw new Error('Không tìm thấy Chrome/Edge. Đặt CHROME_PATH.')

const offlineKey = 'masoi.offline-moderator.session.v4'
const mobileViewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function dayState() {
  const roleIds = [
    'werewolf', 'hunter', 'seer', 'protector', 'witch', 'villager', 'villager',
  ]
  const players = roleIds.map((_, index) => ({
    id: `offline-player-${index + 1}`,
    seat: index + 1,
    alias: `Người ${index + 1}`,
    alive: true,
  }))
  const roleAssignments = roleIds.map((roleId, index) => ({
    playerId: players[index].id,
    roleId,
  }))
  const roleComposition = roleIds.reduce((result, roleId) => {
    result[roleId] = (result[roleId] ?? 0) + 1
    return result
  }, {})
  return {
    schemaVersion: 4,
    mode: 'OFFLINE_MODERATOR',
    phase: 'MATCH',
    seatCount: 7,
    playerNames: players.map((player) => player.alias),
    roleComposition,
    roleAssignments,
    offlineEvents: [],
    nightOne: {
      callPlan: ['werewolf', 'seer', 'protector', 'hunter', 'witch'],
      callIndex: 5,
      activeStep: null,
      draftHolderIds: [],
    },
    authority: {
      schemaVersion: 2,
      roomId: 'OFFLINE-MODERATOR',
      roomCode: 'OFFLINE',
      revision: 10,
      createdAt: 1,
      lifecycle: 'IN_GAME',
      phase: 'DAY',
      dayNumber: 1,
      players,
      roleAssignments,
      roleRevealConfirmedPlayerIds: players.map((player) => player.id),
      config: {
        seatCount: 7,
        roleComposition,
        wolfPolicy: 'RANDOM_ON_TIE',
        nightRoleIds: ['werewolf', 'seer', 'protector', 'hunter', 'witch'],
        revoteDurationMs: 10_000,
      },
      night: null,
      nightResolution: null,
      witchResources: null,
      witchCheckpoint: null,
      dayVote: null,
      dayVerdict: null,
      factionTransitions: { halfWolves: {}, traitors: {} },
      cupidLovers: {
        couple: null,
        loverRevealAcknowledgedPlayerIds: [],
        objective: null,
      },
      matchResult: null,
      journal: [],
    },
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

async function clickByText(page, selector, text) {
  const clicked = await page.$$eval(selector, (nodes, expected) => {
    const node = nodes.find((entry) => entry.textContent?.includes(expected))
    if (!(node instanceof HTMLElement)) return false
    node.click()
    return true
  }, text)
  invariant(clicked, `Không tìm thấy ${selector} có text ${text}.`)
}

async function saved(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), offlineKey)
}

async function seed(page, origin) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.evaluate(({ key, value }) => {
    localStorage.clear()
    localStorage.setItem(key, JSON.stringify(value))
  }, { key: offlineKey, value: dayState() })
  await page.goto(`${origin}/?screen=offline`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.offline-day-decision')
}

async function inspectMobile(page, surface) {
  for (const viewport of mobileViewports) {
    await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    const metrics = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('main button, main a[data-required-control]')]
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

const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite QA server không khởi động.')
const origin = `http://127.0.0.1:${address.port}`
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms-hf3-'))
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

  await seed(page, origin)
  await clickByText(page, '.offline-match-targets button', 'Người 6')
  await clickByText(page, '.offline-match-targets button', 'Người 5')
  let state = await saved(page)
  invariant(state.authorityInput.dayDecision.selection.playerId === 'offline-player-5', 'Candidate draft không đổi tự do.')
  invariant(state.authority.players[4].alive, 'Candidate draft đã mutate gameplay.')
  invariant(state.authority.revision === 10, 'Candidate draft đã mutate shared authority.')
  await inspectMobile(page, 'candidate-draft')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await clickByText(page, '.offline-day-decision > .button.primary', 'KHÓA NGƯỜI TRĂNG TRỐI')
  state = await saved(page)
  invariant(state.authorityInput.dayDecision.stage === 'LAST_WORDS', 'Không vào trạng thái trăng trối đã khóa.')
  invariant(state.authority.players[4].alive, 'Khóa trăng trối đã giết candidate.')
  invariant(state.offlineEvents.filter((event) => event.type === 'DAY_CANDIDATE_LOCKED').length === 1, 'Journal candidate lock sai số lượng.')
  const lockedSnapshot = JSON.stringify(state)
  await page.reload({ waitUntil: 'domcontentloaded' })
  invariant(JSON.stringify(await saved(page)) === lockedSnapshot, 'Reload thay đổi locked last-words snapshot.')
  invariant((await page.$eval('.offline-last-words h2', (node) => node.textContent)).includes('Người 5 ĐANG TRĂNG TRỐI'), 'Thiếu copy đang trăng trối.')

  await clickByText(page, '.offline-verdict-options button', 'XỬ')
  await clickByText(page, '.offline-verdict-options button', 'THA')
  state = await saved(page)
  invariant(state.authorityInput.dayDecision.verdictDraft === 'SPARE', 'THA/XỬ draft không đổi tự do.')
  invariant(state.authority.players[4].alive, 'Verdict draft đã mutate gameplay.')
  const verdictDraftSnapshot = JSON.stringify(state)
  await page.reload({ waitUntil: 'domcontentloaded' })
  invariant(JSON.stringify(await saved(page)) === verdictDraftSnapshot, 'Reload thay đổi THA/XỬ draft snapshot.')
  await clickByText(page, '.offline-day-decision > .button.primary', 'TIẾP TỤC XÁC NHẬN THA')
  invariant((await saved(page)).authorityInput.dayDecision.stage === 'VERDICT_CONFIRM', 'Thiếu final confirmation boundary.')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await clickByText(page, '.offline-confirm-actions button', 'XÁC NHẬN THA')
  state = await saved(page)
  invariant(state.authority.dayVerdict.outcome === 'SPARED' && state.authority.players[4].alive, 'THA không giữ candidate sống.')
  await page.click('.offline-session-tools .button')
  const sparedJournal = await page.$eval('.moderator-journal-view', (node) => node.textContent)
  invariant(sparedJournal.includes('Người 5 được đưa lên trăng trối.'), 'Journal thiếu candidate lock.')
  invariant(sparedJournal.includes('Người 5 được tha.'), 'Journal thiếu THA.')
  invariant(!/phiếu|Mayor|×2/i.test(sparedJournal), 'Journal còn vote count/Mayor history.')

  await seed(page, origin)
  await clickByText(page, '.offline-match-targets button', 'Người 2')
  await clickByText(page, '.offline-day-decision > .button.primary', 'KHÓA NGƯỜI TRĂNG TRỐI')
  await clickByText(page, '.offline-verdict-options button', 'XỬ')
  await clickByText(page, '.offline-day-decision > .button.primary', 'TIẾP TỤC XÁC NHẬN XỬ')
  await clickByText(page, '.offline-confirm-actions button', 'XÁC NHẬN XỬ')
  await page.waitForSelector('.offline-hunter-revenge')
  state = await saved(page)
  invariant(state.authority.dayVerdict.outcome === 'EXECUTED', 'XỬ không tạo authoritative verdict.')
  invariant(state.authority.dayVerdict.hunterRevenge.status === 'PENDING', 'XỬ Hunter không dùng shared revenge semantics.')
  const deathEvents = state.authority.journal.filter((event) => event.type === 'PLAYER_DEATH').length
  await page.reload({ waitUntil: 'domcontentloaded' })
  invariant((await saved(page)).authority.journal.filter((event) => event.type === 'PLAYER_DEATH').length === deathEvents, 'Reload replay hanging/death.')
  await inspectMobile(page, 'execute-hunter-revenge')

  await seed(page, origin)
  await clickByText(page, '.offline-day-decision > .button.secondary', 'KHÔNG CÓ AI')
  invariant((await saved(page)).authorityInput.dayDecision.selection.kind === 'NO_CANDIDATE', 'No-one draft không persist.')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await clickByText(page, '.offline-final-confirmation .button.primary', 'XÁC NHẬN KHÔNG CÓ AI')
  state = await saved(page)
  invariant(state.authority.dayVerdict.outcome === 'NO_CANDIDATE', 'No-one không resolve đúng.')
  invariant(state.authority.players.every((player) => player.alive), 'No-one gây tử vong sai.')
  await page.click('.offline-session-tools .button')
  invariant((await page.$eval('.moderator-journal-view', (node) => node.textContent)).includes('Không ai được đưa lên trăng trối.'), 'Journal thiếu no-one outcome.')

  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  const landing = await page.$eval('.entry-actions', (node) => node.textContent)
  invariant(landing.includes('Tạo phòng') && landing.includes('Vào phòng'), 'Online entry bị regression.')
  invariant(supabaseRequests.length === 0, 'Offline HF3 phát sinh Supabase request.')

  console.log('PASS draft → lock → THA/XỬ draft → final confirm → irreversible flow')
  console.log('PASS no-candidate shortcut + typed outcome-only Journal + no vote/count/Mayor history')
  console.log('PASS refresh boundaries + no duplicate hanging/death + shared Hunter consequence')
  console.log('PASS mobile 320/360/390/430 + no overflow + controls >=44px')
  console.log('PASS Online entry intact + no Supabase gameplay dependency')
} finally {
  await browser.close()
  await server.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
