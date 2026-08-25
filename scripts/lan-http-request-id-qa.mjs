import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function privateLanAddress() {
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
  return addresses.find((address) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address),
  ) ?? null
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

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('LAN QA timeout.')
}

const lanAddress = privateLanAddress()
const executablePath = browserExecutable()
invariant(lanAddress, 'Không tìm thấy private LAN IPv4 để kiểm thử HTTP origin thật.')
invariant(executablePath, 'Không tìm thấy Chrome/Edge cho LAN HTTP QA.')

const server = await createServer({
  logLevel: 'error',
  server: { host: lanAddress, port: 5173, strictPort: true },
})
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masoi-lan-http-'))
let browser

try {
  await server.listen()
  const serverAddress = server.httpServer?.address()
  invariant(serverAddress && typeof serverAddress !== 'string', 'LAN Vite server did not expose a TCP port.')
  const origin = `http://${lanAddress}:${serverAddress.port}`
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: profile,
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
  })

  const mainContext = await browser.createBrowserContext()
  const createPage = await mainContext.newPage()
  createPage.setDefaultTimeout(30_000)
  const pageErrors = []
  createPage.on('pageerror', (error) => pageErrors.push(error.message))

  const createRequests = []
  let forcedFailures = 0
  await createPage.setRequestInterception(true)
  createPage.on('request', (request) => {
    const isCreateRpc = request.method() === 'POST'
      && request.url().includes('/rest/v1/rpc/ms1a_create_room')
    if (!isCreateRpc) {
      void request.continue()
      return
    }

    const body = JSON.parse(request.postData() ?? '{}')
    createRequests.push(body)
    if (forcedFailures < 2) {
      forcedFailures += 1
      void request.respond({
        status: 503,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
        },
        body: JSON.stringify({
          code: 'LAN_QA_RETRY',
          details: null,
          hint: null,
          message: 'FORCED_LAN_QA_RETRY',
        }),
      })
      return
    }
    void request.continue()
  })

  await createPage.goto(`${origin}/?screen=create`, { waitUntil: 'domcontentloaded' })
  await createPage.waitForSelector('.create-room-layout')
  await createPage.waitForSelector('.role-market')
  const runtime = await createPage.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    randomUUID: typeof crypto.randomUUID,
    getRandomValues: typeof crypto.getRandomValues,
  }))
  invariant(runtime.isSecureContext === false, 'LAN HTTP was unexpectedly treated as a secure context.')
  invariant(runtime.randomUUID === 'undefined', 'LAN HTTP unexpectedly exposed crypto.randomUUID.')
  invariant(runtime.getRandomValues === 'function', 'LAN HTTP did not expose secure getRandomValues entropy.')

  const selects = await createPage.$$('.room-basics select')
  invariant(selects.length === 2, 'Create Room controls did not render.')
  await selects[1].select('REVOTE_10S')
  await selects[1].select('RANDOM_ON_TIE')

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await createPage.click('.create-room-footer .button.primary')
    await waitFor(() => createRequests.length === attempt)
    await createPage.waitForFunction(() => {
      const button = document.querySelector('.create-room-footer .button.primary')
      return Boolean(document.querySelector('.inline-error')) && button && !button.disabled
    })
  }

  const retryRequestIds = createRequests.map((request) => request.p_request_id)
  invariant(retryRequestIds.length === 2, 'Did not capture both logical create retries.')
  invariant(retryRequestIds[0] === retryRequestIds[1], 'React rerender/retry changed the logical create request ID.')
  invariant(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(retryRequestIds[0]),
    'LAN request ID is not an RFC4122-v4 UUID.',
  )

  await createPage.click('.create-room-footer .button.primary')
  await createPage.waitForSelector('.lobby-moderator')
  invariant(createRequests.length === 3, 'Remote create RPC was not attempted after retry qualification.')
  invariant(createRequests[2].p_request_id === retryRequestIds[0], 'Successful retry changed the idempotency request ID.')
  const roomCode = (await createPage.$eval('.lobby-heading h1', (node) => node.textContent)).replace(/\D/g, '')
  invariant(/^\d{6}$/.test(roomCode), 'Remote LAN create did not return a six-digit room code.')

  const joinPage = await mainContext.newPage()
  joinPage.setDefaultTimeout(30_000)
  await joinPage.goto(`${origin}/?screen=join`, { waitUntil: 'domcontentloaded' })
  await joinPage.waitForSelector('.join-card')

  const noEntropyContext = await browser.createBrowserContext()
  const noEntropyPage = await noEntropyContext.newPage()
  noEntropyPage.setDefaultTimeout(30_000)
  const noEntropyErrors = []
  noEntropyPage.on('pageerror', (error) => noEntropyErrors.push(error.message))
  await noEntropyPage.evaluateOnNewDocument(() => {
    Object.defineProperty(Crypto.prototype, 'getRandomValues', {
      configurable: true,
      value: undefined,
    })
  })
  await noEntropyPage.goto(`${origin}/?screen=create`, { waitUntil: 'domcontentloaded' })
  await noEntropyPage.waitForSelector('.create-room-layout')
  await noEntropyPage.waitForSelector('.inline-error')
  const noEntropyState = await noEntropyPage.evaluate(() => ({
    getRandomValues: typeof crypto.getRandomValues,
    createDisabled: document.querySelector('.create-room-footer .button.primary')?.disabled,
    errorVisible: Boolean(document.querySelector('.inline-error')?.textContent?.trim()),
  }))
  invariant(noEntropyState.getRandomValues === 'undefined', 'No-entropy browser simulation did not apply.')
  invariant(noEntropyState.createDisabled === true && noEntropyState.errorVisible, 'Missing secure entropy did not fail visibly before write.')
  invariant(pageErrors.length === 0 && noEntropyErrors.length === 0, 'LAN Create Room produced an uncaught page exception.')

  await noEntropyContext.close()
  await mainContext.close()
  console.log('MS-1A-PQA-R1 LAN HTTP QA PASS')
  console.log(JSON.stringify({
    origin,
    isSecureContext: runtime.isSecureContext,
    randomUUID: runtime.randomUUID,
    getRandomValues: runtime.getRandomValues,
    createView: 'PASS',
    roleMarket: 'PASS',
    stableRetryRequestId: true,
    requestIdFormat: 'RFC4122-v4',
    remoteCreate: 'PASS',
    roomCodeDigits: roomCode.length,
    joinView: 'PASS',
    missingEntropyVisibleFailure: true,
    blankScreen: false,
    uncaughtRandomUUIDError: false,
  }, null, 2))
} finally {
  if (browser) await browser.close()
  await server.close()
  const resolvedProfile = path.resolve(profile)
  const resolvedTemp = path.resolve(os.tmpdir())
  if (resolvedProfile.startsWith(`${resolvedTemp}${path.sep}`)) {
    fs.rmSync(resolvedProfile, { recursive: true, force: true })
  }
}
