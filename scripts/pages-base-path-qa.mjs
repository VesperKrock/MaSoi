import fs from 'node:fs'
import puppeteer from 'puppeteer-core'
import { preview } from 'vite'

const basePath = '/MaSoi/'
const classicCardFiles = [
  'Bán Sói.jpg',
  'Bảo Vệ.jpg',
  'Dân Làng.jpg',
  'Kẻ Phản Bội.jpg',
  'Ma Sói.jpg',
  'Phù Thủy.jpg',
  'Sát Nhân Hàng Loạt.jpg',
  'Thần Tình Yêu.jpg',
  'Thằng Ngố.jpg',
  'Thị Trưởng.jpg',
  'Thợ Săn.jpg',
  'Tiên Tri.jpg',
]

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
const productionJavaScript = fs.readdirSync('dist/assets')
  .filter((filename) => filename.endsWith('.js'))
  .map((filename) => fs.readFileSync(`dist/assets/${filename}`, 'utf8'))
  .join('\n')
invariant(
  !productionJavaScript.includes('Development inspector') &&
    !productionJavaScript.includes('Match journal'),
  'Production bundle still contains development inspector presentation.',
)
invariant(executablePath, 'Không tìm thấy Chrome/Edge cho Pages base-path QA.')

const server = await preview({
  logLevel: 'error',
  preview: { host: '127.0.0.1', port: 0 },
})
const address = server.httpServer.address()
invariant(address && typeof address !== 'string', 'Vite preview không mở TCP port.')
const origin = `http://127.0.0.1:${address.port}`
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run'],
})

try {
  const page = await browser.newPage()
  page.setDefaultTimeout(20_000)
  const failures = []
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('response', (response) => {
    if (response.url().startsWith(origin) && response.status() >= 400) {
      failures.push({ path: new URL(response.url()).pathname, status: response.status() })
    }
  })

  await page.goto(`${origin}${basePath}`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.entry-actions')
  const root = await page.evaluate((expectedBasePath) => ({
    pathname: location.pathname,
    createHref: document.querySelector('.entry-actions a:first-child')?.getAttribute('href'),
    joinHref: document.querySelector('.entry-actions a:last-child')?.getAttribute('href'),
    authority: document.querySelector('.local-truth')?.textContent ?? '',
    body: document.body.textContent ?? '',
    localRegistry: localStorage.getItem('masoi.ms0b.rooms.v1'),
    resources: performance.getEntriesByType('resource')
      .map((entry) => new URL(entry.name))
      .filter((url) => url.origin === location.origin)
      .map((url) => url.pathname),
    expectedBasePath,
  }), basePath)
  invariant(root.pathname === basePath, 'Landing không nằm dưới /MaSoi/.')
  invariant(root.createHref === `${basePath}?screen=create`, 'Create link thoát khỏi Pages base path.')
  invariant(root.joinHref === `${basePath}?screen=join`, 'Join link thoát khỏi Pages base path.')
  invariant(root.authority.includes('nhiều thiết bị'), 'Production build không dùng Supabase transport.')
  invariant(!root.body.includes('DEV LOCAL'), 'Production landing displays the DEV local label.')
  invariant(!root.body.includes('Development inspector'), 'Production landing displays the development inspector.')
  invariant(root.localRegistry === null, 'Production build đã tạo local room registry.')
  invariant(
    root.resources.every((path) => path.startsWith(basePath)),
    `Bundle resource thoát khỏi Pages base path: ${JSON.stringify(root.resources)}`,
  )

  await page.goto(`${origin}${basePath}?screen=create`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.create-room-layout')
  invariant(new URL(page.url()).pathname === basePath, 'Create Room làm mất Pages base path.')
  const createHomeHref = await page.$eval('.brand', (node) => node.getAttribute('href'))
  invariant(createHomeHref === basePath, 'Moderator home link thoát khỏi Pages base path.')

  await page.goto(`${origin}${basePath}?screen=join`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.join-card')
  invariant(new URL(page.url()).pathname === basePath, 'Join Room làm mất Pages base path.')
  const joinHomeHref = await page.$eval('.entry-back', (node) => node.getAttribute('href'))
  invariant(joinHomeHref === basePath, 'Player home link thoát khỏi Pages base path.')
  invariant(await page.$('.name-modal') === null, 'Name modal mở trước room-code validation.')

  const cards = await page.evaluate(async ({ expectedBasePath, files }) => {
    return Promise.all(files.map(async (filename) => {
      const url = `${expectedBasePath}assets/cards/classic/${encodeURIComponent(filename)}`
      const response = await fetch(url)
      return {
        filename,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
      }
    }))
  }, { expectedBasePath: basePath, files: classicCardFiles })
  invariant(cards.every((card) => card.status === 200), 'Ít nhất một Classic JPG không trả HTTP 200 dưới /MaSoi/.')
  invariant(cards.every((card) => card.contentType.includes('image/jpeg')), 'Classic asset không được phục vụ dưới dạng JPG.')

  await page.goto(`${origin}${basePath}?transport=local`, { waitUntil: 'networkidle0' })
  const productionTransport = await page.evaluate(() => ({
    authority: document.querySelector('.local-truth')?.textContent ?? '',
    localRegistry: localStorage.getItem('masoi.ms0b.rooms.v1'),
  }))
  invariant(productionTransport.authority.includes('nhiều thiết bị'), 'Production đã bật DEV local shortcut.')
  invariant(productionTransport.localRegistry === null, 'Production đã silently fall back sang LocalRoomTransport.')
  invariant(failures.length === 0, `Pages preview có response lỗi: ${JSON.stringify(failures)}`)
  invariant(pageErrors.length === 0, `Pages preview có page error: ${pageErrors.join(' | ')}`)

  console.log('MS-1A-D1 PAGES BASE-PATH QA PASS')
  console.log(JSON.stringify({
    basePath,
    root: 'PASS',
    createQueryRoute: 'PASS',
    joinQueryRoute: 'PASS',
    classicJpgs: { expected: 12, loaded: cards.length, minimumStatus: 200 },
    bundleResourcesUnderBase: true,
    rootAbsoluteAssetLeak: false,
    productionTransport: 'SUPABASE',
    silentLocalFallback: false,
    asset404s: 0,
    pageErrors: 0,
    developmentInspectorBundled: false,
    devLocalLabelVisible: false,
  }, null, 2))
} finally {
  await browser.close()
  await new Promise((resolve, reject) => {
    server.httpServer.close((error) => error ? reject(error) : resolve())
  })
}
