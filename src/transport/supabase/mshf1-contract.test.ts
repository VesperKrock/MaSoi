import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { playerSnapshotFromPayload } from './supabase-room-transport'

const migrationPath =
  'supabase/migrations/20260828010000_mshf1_mandatory_wolf_live_pack.sql'
const migration = readFileSync(migrationPath, 'utf8')
const journalReadModel = readFileSync(
  'src/domain/gameplay/moderator-journal.ts',
  'utf8',
)

function functionBody(name: string): string {
  const start = migration.indexOf(`function ${name}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = migration.indexOf('$$;', start)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end + 3)
}

describe('MS-HF1 Supabase Wolf authority contract', () => {
  it('uses exactly one forward HF1 migration and leaves generic Realtime secret-free', () => {
    const files = readdirSync('supabase/migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort()
    expect(files).toHaveLength(13)
    expect(files.at(-1)).toBe(
      '20260828010000_mshf1_mandatory_wolf_live_pack.sql',
    )
    expect(migration).toContain('begin;')
    expect(migration).toContain('commit;')
    expect(migration).not.toMatch(/alter publication|realtime\.send/i)
    expect(migration.match(/create or replace function/g)).toHaveLength(4)
  })

  it('rejects null submission, confirmation without a legal target, and zero-target finalization', () => {
    const submit = functionBody('public.ms1b1_submit_wolf_ballot')
    const confirm = functionBody('public.ms1b1_confirm_wolf_ballot')
    const finalize = functionBody('public.ms1b1_finalize_wolf_round')
    expect(submit).toContain(
      "p_target_player_id is null then perform private.raise_ms1b1('WOLF_TARGET_REQUIRED')",
    )
    expect(confirm).toContain('ballot.target_player_id is not null')
    expect(confirm).toContain("private.raise_ms1b1('WOLF_TARGET_REQUIRED')")
    expect(finalize).toContain('v_confirmed_count = 0')
    expect(finalize).toContain("private.raise_ms1b1('WOLF_TARGET_REQUIRED')")
    expect(finalize).not.toContain('ALL_ABSTAIN_RANDOM')
    expect(finalize).not.toContain('REVOTE_ALL_ABSTAIN_RANDOM')
    expect(journalReadModel).not.toContain('Ma Sói không chọn mục tiêu.')
  })

  it('resolves from confirmed valid ballots while preserving both tie policies and revote timing', () => {
    const finalize = functionBody('public.ms1b1_finalize_wolf_round')
    expect(finalize).toContain('ballot.confirmed')
    expect(finalize).toContain("v_room.wolf_policy = 'REVOTE_10S'")
    expect(finalize).toContain("'TIED_TOP_RANDOM'")
    expect(finalize).toContain("'REVOTE_TIED_RANDOM'")
    expect(finalize).toContain("interval '10 seconds'")
    expect(finalize).not.toContain('v_confirmed_count <> v_actor_count')
  })

  it('projects only confirmed, current-call/current-round ballots to an eligible peer', () => {
    const projection = functionBody('private.player_night_action_payload')
    expect(projection).toContain('v_player.id = any(v_call.eligible_actor_ids)')
    expect(projection).toContain('ballot.call_id = v_call.id')
    expect(projection).toContain('ballot.round = v_call.wolf_round')
    expect(projection).toContain('ballot.confirmed')
    expect(projection).toContain('ballot.voter_player_id <> v_player.id')
    expect(projection).toContain(
      'ballot.voter_player_id = any(v_call.eligible_actor_ids)',
    )
    expect(projection).toContain("'wolfTeammateBallots', v_peer_ballots")
  })

  it('keeps helpers and legacy bypass RPCs unavailable to browser roles', () => {
    expect(migration).toContain(
      'revoke execute on function private.player_night_action_payload(uuid, uuid)',
    )
    for (const signature of [
      'public.ms1b1_submit_wolf_ballot(uuid, uuid)',
      'public.ms1b1_confirm_wolf_ballot(uuid)',
      'public.ms1b1_finalize_wolf_round(uuid)',
    ]) {
      expect(migration).toContain(
        `revoke execute on function ${signature}\n  from public, anon, authenticated`,
      )
    }
  })
})

describe('MS-HF1 transport projection', () => {
  it('hydrates compact authoritative teammate ballot markers', () => {
    const now = '2026-08-28T00:00:00.000Z'
    const snapshot = playerSnapshotFromPayload({
      room: {
        id: 'room', code: '123456', seatCount: 7, status: 'IN_GAME',
        phase: 'NIGHT', dayNumber: 1, revision: 1, createdAt: now,
        updatedAt: now, lockedAt: now, startedAt: now,
      },
      self: { id: 'wolf-b', seat: 2, displayName: 'Wolf B', alive: true, revealConfirmed: true, joinedAt: now },
      players: [
        { id: 'wolf-a', seat: 1, displayName: 'Wolf A', alive: true, revealConfirmed: true, joinedAt: now },
        { id: 'wolf-b', seat: 2, displayName: 'Wolf B', alive: true, revealConfirmed: true, joinedAt: now },
        { id: 'target', seat: 3, displayName: 'Long', alive: true, revealConfirmed: true, joinedAt: now },
      ],
      alivePlayerIds: ['wolf-a', 'wolf-b', 'target'],
      assignment: { playerId: 'wolf-b', roleId: 'werewolf', assignedAt: now },
      nightAction: {
        id: 'call', kind: 'WOLF_VOTE', roleId: 'werewolf', roleName: 'Ma Sói',
        mode: 'WOLF_BALLOT', round: 'INITIAL', candidates: [], hasSelected: false,
        wolfTeammateBallots: [{
          voter: { id: 'wolf-a', seat: 1, displayName: 'Wolf A', alive: true },
          targetId: 'target',
        }],
      },
    })
    expect(snapshot.nightAction?.wolfTeammateBallots).toEqual([
      {
        voter: { id: 'wolf-a', seat: 1, alias: 'Wolf A', alive: true },
        targetId: 'target',
      },
    ])
  })
})
