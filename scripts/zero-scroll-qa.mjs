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
if (!executablePath) {
  throw new Error('Không tìm thấy Chrome/Edge. Đặt CHROME_PATH để chạy viewport QA.')
}

const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite QA server không khởi động.')
const origin = `http://127.0.0.1:${address.port}`
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-ms0b-qa-'))
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  userDataDir: profile,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})

const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]
const surfaces = [
  'landing',
  'join',
  'name-modal',
  'lobby',
  'reveal',
  'neutral',
  'action',
  'seer-select',
  'seer-result',
  'protector-action',
  'vote',
  'role-recheck',
]
const results = []

async function openSurface(page, surface) {
  const harnessSurface = surface === 'role-recheck' ? 'neutral' : surface
  await page.goto(
    `${origin}/?dev=zero-scroll&surface=${encodeURIComponent(harnessSurface)}&transport=local`,
    { waitUntil: 'networkidle0' },
  )
  if (surface === 'name-modal') {
    await page.type('input[aria-label="Mã phòng gồm 6 chữ số"]', '381624')
    await page.click('.join-card button[type="submit"], .join-card button:not([type])')
    await page.waitForSelector('.name-modal')
  }
  if (surface === 'role-recheck') {
    await page.click('.quiet-action')
    await page.waitForSelector('[data-surface="recheck"]')
  }
  if (surface === 'reveal' || surface === 'role-recheck') {
    await page.waitForFunction(() => {
      const image = document.querySelector('.role-art-frame img')
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
    })
  }
}

function inspectPlayerLayout() {
  const root = document.querySelector('[data-player-viewport]')
  if (!(root instanceof HTMLElement)) {
    return { pass: false, reason: 'missing player viewport', surface: 'unknown' }
  }
  const tolerance = 1
  const rootRect = root.getBoundingClientRect()
  const controls = [...root.querySelectorAll('[data-required-control], img')]
    .filter((element) => {
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })
  const requiredControlRects = [...root.querySelectorAll('[data-required-control]')]
    .filter((element) => {
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })
    .map((element) => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
  const requiredControlMetrics = requiredControlRects.length > 0
    ? {
        count: requiredControlRects.length,
        minWidth: Math.min(...requiredControlRects.map(({ width }) => width)),
        minHeight: Math.min(...requiredControlRects.map(({ height }) => height)),
      }
    : null
  const requiredTargets = [...root.querySelectorAll('.target[data-required-control]')]
  const targetRects = requiredTargets.map((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  const targetList = root.querySelector('.target-list')
  const targetMetrics = targetRects.length > 0
    ? {
        count: targetRects.length,
        minWidth: Math.min(...targetRects.map(({ width }) => width)),
        maxWidth: Math.max(...targetRects.map(({ width }) => width)),
        minHeight: Math.min(...targetRects.map(({ height }) => height)),
        maxHeight: Math.max(...targetRects.map(({ height }) => height)),
        fontSize: Number.parseFloat(
          getComputedStyle(requiredTargets[0].querySelector('strong') ?? requiredTargets[0]).fontSize,
        ),
        gridGap: targetList
          ? Number.parseFloat(getComputedStyle(targetList).rowGap)
          : 0,
      }
    : null
  const touchTargetsPass =
    !targetMetrics ||
    (targetMetrics.minWidth >= 44 && targetMetrics.minHeight >= 44)
  const requiredControlsPass =
    !requiredControlMetrics ||
    (requiredControlMetrics.minWidth >= 44 && requiredControlMetrics.minHeight >= 44)
  const outsideControls = controls
    .filter((element) => {
      const rect = element.getBoundingClientRect()
      return (
        rect.left < -tolerance ||
        rect.top < -tolerance ||
        rect.right > innerWidth + tolerance ||
        rect.bottom > innerHeight + tolerance
      )
    })
    .map((element) => `${element.tagName}.${element.className}`)
  const nestedScroll = [...root.querySelectorAll('*')]
    .filter((element) => {
      const style = getComputedStyle(element)
      return /^(auto|scroll)$/.test(style.overflowX) || /^(auto|scroll)$/.test(style.overflowY)
    })
    .map((element) => `${element.tagName}.${element.className}`)
  const stages = [root, ...root.querySelectorAll('.player-stage, .name-modal, .modal-backdrop')]
  const clippedStages = stages
    .filter(
      (element) =>
        element.scrollHeight > element.clientHeight + tolerance ||
        element.scrollWidth > element.clientWidth + tolerance,
    )
    .map((element) => `${element.tagName}.${element.className}`)
  const documentScroll =
    document.documentElement.scrollHeight > innerHeight + tolerance ||
    document.documentElement.scrollWidth > innerWidth + tolerance
  const rootOutside =
    rootRect.left < -tolerance ||
    rootRect.top < -tolerance ||
    rootRect.right > innerWidth + tolerance ||
    rootRect.bottom > innerHeight + tolerance

  return {
    pass:
      !documentScroll &&
      !rootOutside &&
      nestedScroll.length === 0 &&
      clippedStages.length === 0 &&
      outsideControls.length === 0 &&
      touchTargetsPass &&
      requiredControlsPass,
    surface: root.dataset.surface,
    documentScroll,
    rootOutside,
    nestedScroll,
    clippedStages,
    outsideControls,
    controlCount: controls.length,
    touchTargetsPass,
    requiredControlsPass,
    requiredControlMetrics,
    targetMetrics,
  }
}

try {
  for (const viewport of viewports) {
    for (const surface of surfaces) {
      const page = await browser.newPage()
      await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
      await openSurface(page, surface)
      const inspection = await page.evaluate(inspectPlayerLayout)
      results.push({ ...inspection, surface, viewport: `${viewport.width}x${viewport.height}` })
      await page.close()
    }
  }

  const moderatorViewports = [
    { name: 'portrait-mobile', width: 390, height: 844 },
    { name: 'landscape-mobile', width: 844, height: 390 },
    { name: 'desktop', width: 1440, height: 900 },
  ]
  for (const viewport of moderatorViewports) {
    const page = await browser.newPage()
    await page.setViewport({ width: viewport.width, height: viewport.height })
    await page.goto(`${origin}/?screen=create&transport=local`, { waitUntil: 'networkidle0' })
    const inspection = await page.evaluate(() => ({
      horizontalScroll: document.documentElement.scrollWidth > innerWidth + 1,
      verticalScrollable: document.documentElement.scrollHeight > innerHeight,
      createButtonVisible: (() => {
        const button = document.querySelector('.create-room-footer .button')
        if (!button) return false
        const rect = button.getBoundingClientRect()
        return rect.top >= 0 && rect.bottom <= innerHeight
      })(),
    }))
    results.push({
      surface: `moderator-${viewport.name}`,
      viewport: `${viewport.width}x${viewport.height}`,
      pass: !inspection.horizontalScroll && inspection.createButtonVisible,
      ...inspection,
    })
    await page.close()
  }

  const failed = results.filter((result) => !result.pass)
  for (const result of results) {
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.surface.padEnd(28)} ${result.viewport}`)
    if (result.targetMetrics) {
      const metrics = result.targetMetrics
      console.log(
        `  targets=${metrics.count} min=${metrics.minWidth.toFixed(2)}x${metrics.minHeight.toFixed(2)} max=${metrics.maxWidth.toFixed(2)}x${metrics.maxHeight.toFixed(2)} font=${metrics.fontSize.toFixed(2)} gap=${metrics.gridGap.toFixed(2)}`,
      )
    }
    if (result.requiredControlMetrics) {
      const metrics = result.requiredControlMetrics
      console.log(
        `  required-controls=${metrics.count} min=${metrics.minWidth.toFixed(2)}x${metrics.minHeight.toFixed(2)}`,
      )
    }
    if (!result.pass) console.log(JSON.stringify(result, null, 2))
  }
  if (failed.length > 0) process.exitCode = 1
} finally {
  await browser.close()
  await server.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
