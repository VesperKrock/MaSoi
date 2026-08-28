import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

const phase = process.argv[2]
if (phase !== 'before' && phase !== 'after') {
  throw new Error('Dùng: npm run qa:ui-polish -- before|after')
}

const outputDirectory = path.resolve(
  'prompts/masoi/25082026/artifacts/ms-1a-u1',
  phase,
)
fs.mkdirSync(outputDirectory, { recursive: true })

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

const executablePath = browserExecutable()
invariant(executablePath, 'Không tìm thấy Chrome/Edge cho U1 visual QA.')

const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const address = server.httpServer?.address()
invariant(address && typeof address !== 'string', 'Vite QA server không mở TCP port.')
const origin = `http://127.0.0.1:${address.port}`
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  protocolTimeout: 120_000,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})
const metrics = { phase, origin, surfaces: {} }

async function settle(page) {
  await page.evaluate(() => document.fonts.ready)
  await new Promise((resolve) => setTimeout(resolve, 250))
}

async function viewport(page, width, height, mobile = false) {
  await page.setViewport({
    width,
    height,
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
  })
}

async function measure(page, selectors = {}) {
  return page.evaluate((requestedSelectors) => {
    const elementMetrics = Object.fromEntries(
      Object.entries(requestedSelectors).map(([name, selector]) => {
        const element = document.querySelector(selector)
        if (!element) return [name, null]
        const rect = element.getBoundingClientRect()
        return [name, {
          top: Number(rect.top.toFixed(2)),
          right: Number(rect.right.toFixed(2)),
          bottom: Number(rect.bottom.toFixed(2)),
          left: Number(rect.left.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
          fullyVisible: rect.top >= 0
            && rect.left >= 0
            && rect.right <= document.documentElement.clientWidth
            && rect.bottom <= document.documentElement.clientHeight,
        }]
      }),
    )
    const nestedScrollers = [...document.querySelectorAll('*')].filter((element) => {
      const style = getComputedStyle(element)
      const canScroll = /(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)
      return canScroll && (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1)
    })
    return {
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        verticalScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      },
      body: {
        width: document.body.scrollWidth,
        height: document.body.scrollHeight,
      },
      nestedScrollerCount: nestedScrollers.length,
      elements: elementMetrics,
    }
  }, selectors)
}

async function capture(page, name, selectors = {}) {
  await settle(page)
  const file = path.join(outputDirectory, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  metrics.surfaces[name] = await measure(page, selectors)
}

async function openPlayer(roomCode, name, captureNameModal = false) {
  const page = await browser.newPage()
  page.setDefaultTimeout(20_000)
  await viewport(page, 390, 844, true)
  await page.goto(`${origin}/?screen=join&transport=local`, { waitUntil: 'domcontentloaded' })
  await page.type('.room-code-field input', roomCode)
  await page.click('.join-card button')
  await page.waitForSelector('.name-modal')
  if (captureNameModal) {
    await viewport(page, 320, 568, true)
    await capture(page, 'player-name-modal-320x568', {
      modal: '.name-modal',
      cancel: '.modal-actions .button.secondary',
      join: '.modal-actions .button.primary',
    })
  }
  await page.type('.name-modal input', name)
  await page.click('.name-modal .button.primary')
  await page.waitForFunction(() => new URL(location.href).searchParams.has('player'))
  await page.waitForSelector('[data-surface="lobby"]')
  return page
}

try {
  const landing = await browser.newPage()
  landing.setDefaultTimeout(20_000)
  await viewport(landing, 320, 568, true)
  await landing.goto(`${origin}/?transport=local`, { waitUntil: 'domcontentloaded' })
  await landing.waitForSelector('.entry-actions')
  await capture(landing, 'player-landing-320x568', {
    create: '.entry-actions a:first-child',
    join: '.entry-actions a[href*="screen=join"]',
  })

  const join = await browser.newPage()
  join.setDefaultTimeout(20_000)
  await viewport(join, 320, 568, true)
  await join.goto(`${origin}/?screen=join&transport=local`, { waitUntil: 'domcontentloaded' })
  await join.waitForSelector('.join-card')
  await capture(join, 'player-join-320x568', {
    code: '.room-code-field',
    continue: '.join-card button',
  })

  const moderator = await browser.newPage()
  moderator.setDefaultTimeout(20_000)
  await viewport(moderator, 1440, 900)
  await moderator.goto(`${origin}/?screen=create&transport=local`, { waitUntil: 'domcontentloaded' })
  await moderator.waitForSelector('.create-room-layout')
  await capture(moderator, 'moderator-create-1440x900', {
    heading: '.create-heading',
    controls: '.room-basics',
    market: '.role-market',
    quantityAction: '.quantity-control button',
    singletonAction: '.singleton-toggle',
    primaryAction: '.create-room-footer .button.primary',
  })
  await moderator.click('.create-room-footer .button.primary')
  await moderator.waitForSelector('.lobby-moderator')
  const roomId = new URL(moderator.url()).searchParams.get('room')
  invariant(roomId, 'Create Room không trả room ID.')
  const roomCode = (await moderator.$eval('.lobby-heading h1', (node) => node.textContent ?? '')).replace(/\D/g, '')
  invariant(/^\d{6}$/.test(roomCode), 'Create Room không trả room code 6 số.')

  const playerNames = ['Bảo Châu', 'Minh', 'Xuka', 'An', 'Bình', 'Chi', 'Dũng']
  const playerUrls = []
  for (let index = 0; index < playerNames.length; index += 1) {
    const playerPage = await openPlayer(roomCode, playerNames[index], index === 0)
    playerUrls.push(playerPage.url())
    if (index === 0) {
      await viewport(playerPage, 320, 568, true)
      await capture(playerPage, 'player-lobby-320x568', {
        surface: '[data-surface="lobby"]',
      })
    }
    await playerPage.close()
  }

  await moderator.waitForFunction(() => {
    return document.querySelector('.lobby-count strong')?.textContent?.replace(/\s/g, '') === '7/7'
  })
  await viewport(moderator, 1440, 900)
  await capture(moderator, 'moderator-lobby-7p-1440x900', {
    heading: '.lobby-heading',
    roster: '.lobby-roster-panel',
    deck: '.lobby-control-panel',
    primaryAction: '.lobby-control-panel .button.primary',
  })

  await moderator.$eval(
    '.lobby-control-panel .button.primary',
    (button) => button.click(),
  )
  await moderator.waitForSelector('.reveal-moderator')
  const firstPlayer = await browser.newPage()
  firstPlayer.setDefaultTimeout(20_000)
  await viewport(firstPlayer, 320, 568, true)
  await firstPlayer.goto(playerUrls[0], { waitUntil: 'domcontentloaded' })
  await firstPlayer.waitForSelector('[data-surface="reveal"]')
  await firstPlayer.waitForFunction(() => {
    const image = document.querySelector('.role-art-frame img')
    return image?.complete && image.naturalWidth > 0
  })
  await capture(firstPlayer, 'player-role-reveal-320x568', {
    card: '.role-art-frame img',
    confirm: '.role-identity-surface .button.primary',
  })

  await firstPlayer.$eval(
    '.role-identity-surface .button.primary',
    (button) => button.click(),
  )
  await firstPlayer.waitForSelector('[data-surface="neutral"]')
  await firstPlayer.close()
  for (let index = 1; index < 4; index += 1) {
    const playerPage = await browser.newPage()
    playerPage.setDefaultTimeout(20_000)
    await playerPage.goto(playerUrls[index], { waitUntil: 'domcontentloaded' })
    await playerPage.waitForSelector('[data-surface="reveal"]')
    await playerPage.$eval(
      '.role-identity-surface .button.primary',
      (button) => button.click(),
    )
    await playerPage.waitForSelector('[data-surface="neutral"]')
    await playerPage.close()
  }
  await moderator.reload({ waitUntil: 'domcontentloaded' })
  await moderator.waitForSelector('.reveal-moderator')
  await viewport(moderator, 1440, 900)
  await capture(moderator, 'moderator-role-reveal-7p-1440x900', {
    heading: '.phase-heading',
    progress: '.reveal-heading-status',
    roster: '.reveal-readiness .joined-list',
    primaryAction: '.reveal-readiness > .button.primary',
  })

  for (let index = 4; index < playerUrls.length; index += 1) {
    const playerPage = await browser.newPage()
    playerPage.setDefaultTimeout(20_000)
    await playerPage.goto(playerUrls[index], { waitUntil: 'domcontentloaded' })
    await playerPage.waitForSelector('[data-surface="reveal"]')
    await playerPage.$eval(
      '.role-identity-surface .button.primary',
      (button) => button.click(),
    )
    await playerPage.waitForSelector('[data-surface="neutral"]')
    await playerPage.close()
  }
  await moderator.reload({ waitUntil: 'domcontentloaded' })
  await moderator.waitForFunction(() => {
    const button = document.querySelector('.reveal-readiness > .button.primary')
    return button && !button.disabled
  })
  await moderator.$eval(
    '.reveal-readiness > .button.primary',
    (button) => button.click(),
  )
  await moderator.waitForSelector('.night-panel')
  const neutralPlayer = await browser.newPage()
  neutralPlayer.setDefaultTimeout(20_000)
  await neutralPlayer.goto(playerUrls[0], { waitUntil: 'domcontentloaded' })
  await neutralPlayer.waitForSelector('[data-surface="neutral"]')

  await viewport(neutralPlayer, 320, 568, true)
  await capture(neutralPlayer, 'player-neutral-night-320x568', {
    surface: '[data-surface="neutral"]',
    recheck: '.quiet-action',
  })
  await neutralPlayer.close()

  await viewport(moderator, 1440, 900)
  await capture(moderator, 'moderator-night-1440x900', {
    heading: '.phase-heading',
    checklist: '.night-panel',
    firstCall: '.night-calls .call-row:first-child',
    roster: '.roster-panel',
    primaryAction: '.night-calls .call-row:first-child .call-button',
  })
  await viewport(moderator, 390, 844, true)
  await capture(moderator, 'moderator-night-portrait-390x844', {
    heading: '.phase-heading',
    checklist: '.night-panel',
    primaryAction: '.night-calls .call-row:first-child .call-button',
  })
  await viewport(moderator, 844, 390)
  await capture(moderator, 'moderator-night-landscape-844x390', {
    heading: '.phase-heading',
    checklist: '.night-panel',
    primaryAction: '.night-calls .call-row:first-child .call-button',
  })

  await viewport(moderator, 1440, 900)
  await moderator.evaluate((currentRoomId) => {
    const key = 'masoi.ms0b.rooms.v1'
    const registry = JSON.parse(localStorage.getItem(key) ?? '{}')
    const room = registry.rooms?.[currentRoomId]
    if (!room) throw new Error('Không tìm thấy room để dựng Day visual state.')
    room.phase = 'DAY'
    room.night = null
    room.dayVote = null
    room.revision += 1
    localStorage.setItem(key, JSON.stringify(registry))
  }, roomId)
  await moderator.reload({ waitUntil: 'domcontentloaded' })
  await moderator.waitForSelector('.day-panel')
  await moderator.click('.day-panel > .button.primary')
  await moderator.waitForSelector('.vote-open')
  await capture(moderator, 'moderator-day-vote-1440x900', {
    heading: '.phase-heading',
    vote: '.day-panel',
    roster: '.roster-panel',
    primaryAction: '.vote-open .button.danger',
  })

  const target = await browser.newPage()
  target.setDefaultTimeout(20_000)
  await viewport(target, 390, 844, true)
  await target.goto(`${origin}/?dev=zero-scroll&surface=action`, { waitUntil: 'domcontentloaded' })
  await target.waitForSelector('[data-surface="night_action"]')
  await capture(target, 'player-night-target-390x844', {
    grid: '.compact-action .target-list',
    firstTarget: '.compact-action .target:first-child',
    confirm: '.action-confirm',
  })

  const vote = await browser.newPage()
  vote.setDefaultTimeout(20_000)
  await viewport(vote, 390, 844, true)
  await vote.goto(`${origin}/?dev=zero-scroll&surface=vote`, { waitUntil: 'domcontentloaded' })
  await vote.waitForSelector('[data-surface="day_vote"]')
  await capture(vote, 'player-day-vote-390x844', {
    grid: '.compact-action .target-list',
    firstTarget: '.compact-action .target:first-child',
  })

  if (phase === 'after') {
    const beforeMetricsPath = path.resolve(
      'prompts/masoi/25082026/artifacts/ms-1a-u1/before/metrics.json',
    )
    invariant(fs.existsSync(beforeMetricsPath), 'Thiếu BEFORE metrics để so sánh U1.')
    const beforeMetrics = JSON.parse(fs.readFileSync(beforeMetricsPath, 'utf8'))
    const after = metrics.surfaces
    const before = beforeMetrics.surfaces
    const playerSurfaceNames = [
      'player-landing-320x568',
      'player-join-320x568',
      'player-name-modal-320x568',
      'player-lobby-320x568',
      'player-role-reveal-320x568',
      'player-neutral-night-320x568',
      'player-night-target-390x844',
      'player-day-vote-390x844',
    ]
    for (const name of playerSurfaceNames) {
      const surface = after[name]
      invariant(!surface.document.horizontalScroll, `${name} có horizontal scroll.`)
      invariant(!surface.document.verticalScroll, `${name} có vertical scroll.`)
      invariant(surface.nestedScrollerCount === 0, `${name} có nested scroll.`)
    }
    for (const [name, surface] of Object.entries(after)) {
      if (name.startsWith('moderator-')) {
        invariant(!surface.document.horizontalScroll, `${name} có horizontal scroll.`)
      }
    }
    invariant(after['moderator-create-1440x900'].elements.market.fullyVisible, 'Role market 7-player không nằm trọn first viewport.')
    for (const element of ['quantityAction', 'singletonAction']) {
      const target = after['moderator-create-1440x900'].elements[element]
      invariant(target.width >= 44 && target.height >= 44, `Create Room ${element} nhỏ hơn 44×44.`)
    }
    invariant(after['moderator-lobby-7p-1440x900'].elements.primaryAction.fullyVisible, 'Lobby deal action không nằm above fold.')
    invariant(after['moderator-role-reveal-7p-1440x900'].elements.primaryAction.fullyVisible, 'Role Reveal start action không nằm above fold.')
    invariant(after['moderator-night-1440x900'].elements.primaryAction.fullyVisible, 'Night primary call action không nằm above fold.')
    invariant(after['moderator-night-landscape-844x390'].elements.primaryAction.fullyVisible, 'Landscape Night primary action bị clip.')
    const requiredTouchTargets = [
      ['player-neutral-night-320x568', 'recheck'],
      ['player-night-target-390x844', 'firstTarget'],
      ['player-day-vote-390x844', 'firstTarget'],
    ]
    for (const [name, element] of requiredTouchTargets) {
      const target = after[name].elements[element]
      invariant(target.width >= 44 && target.height >= 44, `${name} có target nhỏ hơn 44×44.`)
    }
    metrics.comparison = {
      createDocumentHeight: {
        before: before['moderator-create-1440x900'].document.height,
        after: after['moderator-create-1440x900'].document.height,
      },
      lobbyHeadingHeight: {
        before: before['moderator-lobby-7p-1440x900'].elements.heading.height,
        after: after['moderator-lobby-7p-1440x900'].elements.heading.height,
      },
      revealHeadingHeight: {
        before: before['moderator-role-reveal-7p-1440x900'].elements.heading.height,
        after: after['moderator-role-reveal-7p-1440x900'].elements.heading.height,
      },
      nightChecklistTop: {
        before: before['moderator-night-1440x900'].elements.checklist.top,
        after: after['moderator-night-1440x900'].elements.checklist.top,
      },
      landscapePrimaryActionAboveFold: {
        before: before['moderator-night-landscape-844x390'].elements.primaryAction.fullyVisible,
        after: after['moderator-night-landscape-844x390'].elements.primaryAction.fullyVisible,
      },
    }
  }

  fs.writeFileSync(
    path.join(outputDirectory, 'metrics.json'),
    `${JSON.stringify(metrics, null, 2)}\n`,
  )
  console.log(`MS-1A-U1 ${phase.toUpperCase()} VISUAL CAPTURE PASS`)
  console.log(JSON.stringify({
    phase,
    outputDirectory,
    screenshots: Object.keys(metrics.surfaces).length,
    roomFlow: 'CREATE→7/7 LOBBY→DEAL→REVEAL→NIGHT',
  }, null, 2))
} finally {
  await browser.close()
  await server.close()
}
