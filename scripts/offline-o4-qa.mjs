import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const baseline = '0f34ca4eda2730b3630684e0a1d04dd61082e8dc'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function sourceFiles(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(relativePath)
      return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')
        ? [relativePath]
        : []
    })
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    shell: options.shell ?? false,
  })
  invariant(
    result.status === 0,
    `${command} ${args.join(' ')} thất bại.\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  )
  return result.stdout ?? ''
}

const offlineFiles = [
  ...sourceFiles('src/domain/offline'),
  ...sourceFiles('src/views/offline'),
  'src/state/use-offline-session.ts',
]
const offlineSource = offlineFiles.map(read).join('\n')
const authoritySource = read('src/domain/offline/offline-authority.ts')
const sessionSource = read('src/domain/offline/offline-session.ts')
const storageSource = read('src/domain/offline/offline-storage.ts')
const mainSource = read('src/main.tsx')
const appSource = read('src/App.tsx')

for (const forbidden of [
  /@supabase/i,
  /transport[\\/]supabase/i,
  /LocalRoomTransport/,
  /BroadcastChannel/,
  /createConfiguredRoomTransport/,
]) {
  invariant(!forbidden.test(offlineSource), `Offline dependency leak: ${forbidden}.`)
}
invariant(!/<img\b/i.test(offlineSource), 'Offline render role/card artwork.')
invariant(!/Play Again|Chơi lại/i.test(offlineSource), 'Offline có Play Again ngoài scope.')
invariant(!/\btextarea\b/i.test(offlineSource), 'Offline có Journal narrative editor.')
invariant(!/roomCode/.test(read('src/views/offline/offline-moderator-view.tsx')), 'Offline UI render room code.')
invariant(!/roomCode/.test(read('src/views/offline/offline-match-view.tsx')), 'Offline match render room code.')

invariant(authoritySource.includes('applyRoomCommand'), 'Offline không dùng shared RoomCommand engine.')
invariant(/\bRoomCommand\b/.test(authoritySource), 'Offline adapter thiếu shared RoomCommand contract.')
invariant(/\bRoomState\b/.test(authoritySource), 'Offline adapter thiếu shared RoomState contract.')
for (const duplicateResolver of [
  'resolveGlobalWin',
  'stabilizeDeathConsequences',
  'finalizeWitchCheckpoint',
  'resolveFoolHanging',
]) {
  invariant(
    !authoritySource.includes(duplicateResolver),
    `Offline authority fork resolver ${duplicateResolver}.`,
  )
}
invariant(!/Math\.random|\bshuffle\b/i.test(sessionSource), 'Offline setup tự xáo/gán bài.')
invariant(storageSource.includes('session.v4'), 'Offline persistence không ở schema v4.')
invariant(storageSource.includes('session.v3'), 'Offline mất migration v3.')
invariant(storageSource.includes('session.v2'), 'Offline mất migration v2.')
invariant(storageSource.includes('session.v1'), 'Offline mất migration v1.')
invariant(
  /params\.get\('screen'\) === 'offline'[\s\S]*?\? null[\s\S]*?: createConfiguredRoomTransport/.test(mainSource),
  'Offline route vẫn khởi tạo Online transport.',
)
invariant(
  /if \(screen === 'offline'\) return <OfflineModeratorView \/>/.test(appSource),
  'App không tách Offline authority route.',
)

const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .filter((entry) => entry.endsWith('.sql'))
invariant(migrations.length === 13, `Local migrations là ${migrations.length}/13.`)
const migrationDiff = run('git', ['diff', '--name-only', baseline, '--', 'supabase'])
invariant(migrationDiff.trim() === '', `Offline candidate đổi migration: ${migrationDiff}`)

const vitestBinary = process.platform === 'win32'
  ? path.join(root, 'node_modules/.bin/vitest.cmd')
  : path.join(root, 'node_modules/.bin/vitest')
run(vitestBinary, [
  'run',
  'src/domain/offline/offline-session.test.ts',
  'src/domain/offline/offline-authority.test.ts',
  'src/domain/offline/offline-storage.test.ts',
  'src/domain/gameplay/moderator-journal.test.ts',
], { inherit: true, shell: process.platform === 'win32' })

console.log('PASS Golden A — Village/Wolf + Protector/Seer/Witch + Day/Next Night')
console.log('PASS Golden B — Cupid/Lovers death fixpoint + Half-Wolf/Traitor Night 2')
console.log('PASS Golden C — Serial Killer/Fool/Mayor/Hunter + FINISHED outcome')
console.log('PASS schema v1/v2/v3→v4 + discovery/Journal durability contracts')
console.log('PASS Offline authority isolation + shared RoomCommand/RoomState engine reuse')
console.log('PASS no Supabase/Auth/Realtime/LocalRoomTransport/card art/Play Again + migrations 13/13')
