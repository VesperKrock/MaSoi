begin;

create table private.day_vote_rounds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  day_number integer not null check (day_number >= 1),
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED')),
  opened_by_user_id uuid not null references auth.users(id),
  opened_at timestamptz not null default statement_timestamp(),
  deadline_at timestamptz not null,
  resolved_at timestamptz,
  outcome text check (outcome in ('HANGED', 'TIE', 'NO_VOTES')),
  hanged_player_id uuid,
  hunter_revealed boolean not null default false,
  unique (room_id, day_number),
  unique (id, room_id, day_number),
  foreign key (room_id, hanged_player_id)
    references public.room_players(room_id, id),
  check (deadline_at = opened_at + interval '30 seconds'),
  check (
    (status = 'OPEN' and resolved_at is null and outcome is null and hanged_player_id is null)
    or
    (status = 'RESOLVED' and resolved_at is not null and outcome is not null
      and ((outcome = 'HANGED' and hanged_player_id is not null)
        or (outcome in ('TIE', 'NO_VOTES') and hanged_player_id is null)))
  ),
  check (not hunter_revealed or hanged_player_id is not null)
);

create table private.day_ballots (
  vote_id uuid not null,
  room_id uuid not null,
  day_number integer not null,
  voter_player_id uuid not null,
  target_player_id uuid,
  submitted_at timestamptz not null default statement_timestamp(),
  primary key (vote_id, voter_player_id),
  foreign key (vote_id, room_id, day_number)
    references private.day_vote_rounds(id, room_id, day_number) on delete cascade,
  foreign key (room_id, voter_player_id)
    references public.room_players(room_id, id),
  foreign key (room_id, target_player_id)
    references public.room_players(room_id, id),
  check (target_player_id is null or target_player_id <> voter_player_id)
);

create table private.day_vote_result_totals (
  vote_id uuid not null references private.day_vote_rounds(id) on delete cascade,
  target_player_id uuid not null references public.room_players(id),
  weighted_total integer not null check (weighted_total > 0),
  primary key (vote_id, target_player_id)
);

create table private.day_effects (
  id uuid primary key default gen_random_uuid(),
  vote_id uuid not null,
  room_id uuid not null,
  day_number integer not null,
  source_type text not null check (source_type in ('DAY_HANGING', 'HUNTER_REVENGE_SHOT')),
  source_role_id text references public.classic_roles(id),
  actor_player_id uuid,
  target_player_id uuid not null,
  effect_category text not null check (
    effect_category in ('DAY_LETHAL_EFFECT', 'NON_VILLAIN_LETHAL_EFFECT')
  ),
  lethal boolean not null default true check (lethal),
  protector_blockable boolean not null default false check (not protector_blockable),
  finalized_at timestamptz not null default statement_timestamp(),
  unique (vote_id, source_type),
  foreign key (vote_id, room_id, day_number)
    references private.day_vote_rounds(id, room_id, day_number) on delete cascade,
  foreign key (room_id, actor_player_id)
    references public.room_players(room_id, id),
  foreign key (room_id, target_player_id)
    references public.room_players(room_id, id),
  check (
    (source_type = 'DAY_HANGING'
      and source_role_id is null
      and actor_player_id is null
      and effect_category = 'DAY_LETHAL_EFFECT')
    or
    (source_type = 'HUNTER_REVENGE_SHOT'
      and source_role_id = 'hunter'
      and actor_player_id is not null
      and effect_category = 'NON_VILLAIN_LETHAL_EFFECT')
  )
);

create table private.hunter_day_revenge (
  vote_id uuid primary key,
  room_id uuid not null,
  day_number integer not null,
  hunter_player_id uuid not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'RESOLVED')),
  target_player_id uuid,
  resolved_at timestamptz,
  foreign key (vote_id, room_id, day_number)
    references private.day_vote_rounds(id, room_id, day_number) on delete cascade,
  foreign key (room_id, hunter_player_id)
    references public.room_players(room_id, id),
  foreign key (room_id, target_player_id)
    references public.room_players(room_id, id),
  check (target_player_id is null or target_player_id <> hunter_player_id),
  check (
    (status = 'PENDING' and resolved_at is null and target_player_id is null)
    or (status = 'RESOLVED' and resolved_at is not null)
  )
);

create table private.day_to_night_transitions (
  room_id uuid not null references public.rooms(id) on delete cascade,
  day_number integer not null check (day_number >= 1),
  next_night_number integer not null check (next_night_number = day_number + 1),
  transitioned_by_user_id uuid not null references auth.users(id),
  transitioned_at timestamptz not null default statement_timestamp(),
  primary key (room_id, day_number),
  unique (room_id, next_night_number)
);

create index day_ballots_room_day_idx
  on private.day_ballots(room_id, day_number);
create index day_effects_room_day_idx
  on private.day_effects(room_id, day_number);

alter table private.gameplay_events
  drop constraint if exists gameplay_events_event_type_check;
alter table private.gameplay_events
  add constraint gameplay_events_event_type_check check (event_type in (
    'ROLE_CALLED',
    'CALL_COMPLETED',
    'WOLF_REVOTE_STARTED',
    'WOLF_FINAL_TARGET',
    'SEER_INSPECTION',
    'SEER_RESULT_ACKNOWLEDGED',
    'PROTECTOR_INTENT',
    'WOLF_ATTACK_CREATED',
    'WOLF_ATTACK_BLOCKED',
    'NIGHT_DEATH_CANDIDATE_CREATED',
    'NIGHT_RESOLUTION_COMPLETED',
    'HUNTER_TARGET_LOCKED',
    'HUNTER_SHOT_CREATED',
    'HUNTER_SHOT_ACTIVATED',
    'HUNTER_SHOT_CANCELED',
    'HUNTER_SHOT_VICTIM_RESCUED',
    'WITCH_DECISION_SUBMITTED',
    'WITCH_RESURRECTION_USED',
    'WITCH_POISON_USED',
    'WITCH_CHECKPOINT_COMPLETED',
    'NIGHT_DEATH_FINALIZED',
    'MORNING_STARTED',
    'DAY_VOTE_OPENED',
    'DAY_VOTE_CHANGED',
    'DAY_VOTE_RESOLVED',
    'DAY_HANGING_CREATED',
    'HUNTER_HANGING_REVEALED',
    'HUNTER_REVENGE_RESOLVED',
    'NEXT_NIGHT_STARTED'
  ));

create or replace function private.raise_ms1d2(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end;
$$;

create or replace function private.day_vote_totals_payload(p_vote_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(total.target_player_id::text, total.weighted_total), '{}'::jsonb)
  from (
    select result.target_player_id, result.weighted_total
    from private.day_vote_result_totals result
    where result.vote_id = p_vote_id
    union all
    select ballot.target_player_id,
      sum(case when assignment.role_id = 'mayor' then 2 else 1 end)::integer as weighted_total
    from private.day_ballots ballot
    join public.room_players voter
      on voter.room_id = ballot.room_id
      and voter.id = ballot.voter_player_id
      and voter.alive
    join public.room_players target
      on target.room_id = ballot.room_id
      and target.id = ballot.target_player_id
      and target.alive
    join public.room_role_assignments assignment
      on assignment.room_id = ballot.room_id
      and assignment.player_id = ballot.voter_player_id
    where ballot.vote_id = p_vote_id
      and ballot.target_player_id is not null
      and not exists (
        select 1 from private.day_vote_result_totals result
        where result.vote_id = p_vote_id
      )
    group by ballot.target_player_id
  ) total;
$$;

create or replace function private.day_player_object(p_player_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', player.id,
    'seat', player.seat_number,
    'displayName', player.display_name,
    'alive', player.alive
  )
  from public.room_players player
  where player.id = p_player_id;
$$;

create or replace function private.day_effect_payload(
  p_vote_id uuid,
  p_source_type text
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', effect.id,
    'sourceType', effect.source_type,
    'sourceRoleId', effect.source_role_id,
    'actorPlayerId', effect.actor_player_id,
    'category', effect.effect_category,
    'targetPlayerId', effect.target_player_id,
    'lethal', effect.lethal,
    'protectorBlockable', effect.protector_blockable,
    'finalized', true,
    'finalizedAt', effect.finalized_at
  ))
  from private.day_effects effect
  where effect.vote_id = p_vote_id
    and effect.source_type = p_source_type;
$$;

create or replace function private.moderator_day_vote_payload(p_room_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_vote private.day_vote_rounds%rowtype;
  v_revenge private.hunter_day_revenge%rowtype;
  v_totals jsonb;
begin
  select * into v_room from public.rooms room where room.id = p_room_id;
  if not found or v_room.phase <> 'DAY' then return null; end if;
  select * into v_vote
  from private.day_vote_rounds vote
  where vote.room_id = p_room_id and vote.day_number = v_room.day_number;
  if not found then return null; end if;
  v_totals := private.day_vote_totals_payload(v_vote.id);
  select * into v_revenge
  from private.hunter_day_revenge revenge
  where revenge.vote_id = v_vote.id;
  return jsonb_strip_nulls(jsonb_build_object(
    'id', v_vote.id,
    'dayNumber', v_vote.day_number,
    'status', v_vote.status,
    'openedAt', v_vote.opened_at,
    'deadlineAt', v_vote.deadline_at,
    'resolvedAt', v_vote.resolved_at,
    'totals', v_totals,
    'result', case when v_vote.status = 'RESOLVED' then jsonb_build_object(
      'kind', case v_vote.outcome
        when 'HANGED' then 'UNIQUE'
        when 'TIE' then 'TIE'
        else 'NO_VOTES' end,
      'hangedPlayerId', v_vote.hanged_player_id,
      'hunterRevealed', v_vote.hunter_revealed
    ) end,
    'hangingEffect', private.day_effect_payload(v_vote.id, 'DAY_HANGING'),
    'hunterRevenge', case when v_revenge.vote_id is not null then jsonb_strip_nulls(jsonb_build_object(
      'hunterPlayerId', v_revenge.hunter_player_id,
      'status', v_revenge.status,
      'targetPlayerId', case when v_revenge.status = 'RESOLVED' then v_revenge.target_player_id end,
      'resolvedAt', v_revenge.resolved_at,
      'effect', private.day_effect_payload(v_vote.id, 'HUNTER_REVENGE_SHOT')
    )) end
  ));
end;
$$;

create or replace function private.player_day_vote_payload(
  p_room_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_player public.room_players%rowtype;
  v_vote private.day_vote_rounds%rowtype;
  v_revenge private.hunter_day_revenge%rowtype;
  v_current_target_id uuid;
  v_candidates jsonb := '[]'::jsonb;
  v_revenge_candidates jsonb := '[]'::jsonb;
begin
  select * into v_room from public.rooms room where room.id = p_room_id;
  if not found or v_room.phase <> 'DAY' then return null; end if;
  select player.* into v_player
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  where membership.room_id = p_room_id and membership.user_id = p_user_id;
  if not found then return null; end if;
  select * into v_vote
  from private.day_vote_rounds vote
  where vote.room_id = p_room_id and vote.day_number = v_room.day_number;
  if not found then return null; end if;
  select ballot.target_player_id into v_current_target_id
  from private.day_ballots ballot
  where ballot.vote_id = v_vote.id and ballot.voter_player_id = v_player.id;
  if v_vote.status = 'OPEN'
    and statement_timestamp() < v_vote.deadline_at
    and v_player.alive then
    select coalesce(jsonb_agg(private.day_player_object(candidate.id)
      order by candidate.seat_number), '[]'::jsonb)
    into v_candidates
    from public.room_players candidate
    where candidate.room_id = p_room_id
      and candidate.alive
      and candidate.id <> v_player.id;
  end if;
  select * into v_revenge
  from private.hunter_day_revenge revenge
  where revenge.vote_id = v_vote.id;
  if v_revenge.status = 'PENDING' and v_revenge.hunter_player_id = v_player.id then
    select coalesce(jsonb_agg(private.day_player_object(candidate.id)
      order by candidate.seat_number), '[]'::jsonb)
    into v_revenge_candidates
    from public.room_players candidate
    where candidate.room_id = p_room_id
      and candidate.alive
      and candidate.id <> v_player.id;
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'status', v_vote.status,
    'openedAt', v_vote.opened_at,
    'deadlineAt', v_vote.deadline_at,
    'candidates', v_candidates,
    'currentTargetId', v_current_target_id,
    'totals', private.day_vote_totals_payload(v_vote.id),
    'result', case when v_vote.status = 'RESOLVED' then jsonb_strip_nulls(jsonb_build_object(
      'kind', case v_vote.outcome
        when 'HANGED' then 'UNIQUE'
        when 'TIE' then 'TIE'
        else 'NO_VOTES' end,
      'hangedPlayer', private.day_player_object(v_vote.hanged_player_id),
      'hunterRevealed', v_vote.hunter_revealed,
      'hunterRevengeStatus', v_revenge.status,
      'hunterRevengeTarget', case when v_revenge.status = 'RESOLVED'
        then private.day_player_object(v_revenge.target_player_id) end
    )) end,
    'hunterRevengeAction', case
      when v_revenge.status = 'PENDING' and v_revenge.hunter_player_id = v_player.id
      then jsonb_build_object('candidates', v_revenge_candidates)
    end
  ));
end;
$$;

create or replace function public.ms1d2_start_day_vote(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_opened_at timestamptz := statement_timestamp();
begin
  select * into v_room from public.rooms room where room.id = p_room_id for update;
  if not found then perform private.raise_ms1d2('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1d2('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1d2('NOT_IN_GAME'); end if;
  if v_room.phase <> 'DAY' then perform private.raise_ms1d2('NOT_DAY'); end if;
  if exists (
    select 1 from private.day_vote_rounds vote
    where vote.room_id = p_room_id and vote.day_number = v_room.day_number
  ) then perform private.raise_ms1d2('DAY_VOTE_ALREADY_EXISTS'); end if;
  insert into private.day_vote_rounds (
    room_id, day_number, opened_by_user_id, opened_at, deadline_at
  ) values (
    p_room_id, v_room.day_number, v_user_id, v_opened_at,
    v_opened_at + interval '30 seconds'
  );
  insert into private.gameplay_events (
    room_id, night_number, event_type, resolution, metadata
  ) values (
    p_room_id, v_room.day_number, 'DAY_VOTE_OPENED', 'OPEN',
    jsonb_build_object(
      'durationSeconds', 30,
      'deadlineAt', v_opened_at + interval '30 seconds'
    )
  );
  perform private.touch_gameplay_room(p_room_id);
  return public.ms1a_get_moderator_room(p_room_id);
end;
$$;

create or replace function public.ms1d2_cast_day_vote(
  p_room_id uuid,
  p_target_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_player public.room_players%rowtype;
  v_vote private.day_vote_rounds%rowtype;
  v_previous_target_id uuid;
  v_next_target_id uuid;
  v_existing boolean := false;
begin
  select * into v_room from public.rooms room where room.id = p_room_id for update;
  if not found then perform private.raise_ms1d2('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1d2('NOT_IN_GAME'); end if;
  if v_room.phase <> 'DAY' then perform private.raise_ms1d2('NOT_DAY'); end if;
  select player.* into v_player
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  where membership.room_id = p_room_id and membership.user_id = v_user_id;
  if not found then perform private.raise_ms1d2('NOT_PLAYER'); end if;
  if not v_player.alive then perform private.raise_ms1d2('PLAYER_DEAD'); end if;
  select * into v_vote
  from private.day_vote_rounds vote
  where vote.room_id = p_room_id and vote.day_number = v_room.day_number
  for update;
  if not found or v_vote.status <> 'OPEN' then
    perform private.raise_ms1d2('DAY_VOTE_NOT_OPEN');
  end if;
  if statement_timestamp() >= v_vote.deadline_at then
    perform private.raise_ms1d2('DAY_VOTE_EXPIRED');
  end if;
  if p_target_player_id is not null then
    if p_target_player_id = v_player.id or not exists (
      select 1 from public.room_players target
      where target.room_id = p_room_id
        and target.id = p_target_player_id
        and target.alive
    ) then perform private.raise_ms1d2('INVALID_TARGET'); end if;
  end if;
  select ballot.target_player_id, true
  into v_previous_target_id, v_existing
  from private.day_ballots ballot
  where ballot.vote_id = v_vote.id and ballot.voter_player_id = v_player.id;
  v_next_target_id := case
    when v_existing and v_previous_target_id is not distinct from p_target_player_id then null
    else p_target_player_id
  end;
  insert into private.day_ballots (
    vote_id, room_id, day_number, voter_player_id, target_player_id
  ) values (
    v_vote.id, p_room_id, v_room.day_number, v_player.id, v_next_target_id
  ) on conflict (vote_id, voter_player_id) do update
  set target_player_id = excluded.target_player_id,
      submitted_at = statement_timestamp();
  insert into private.gameplay_events (
    room_id, night_number, event_type, actor_player_id,
    target_player_id, resolution, metadata
  ) values (
    p_room_id, v_room.day_number, 'DAY_VOTE_CHANGED', v_player.id,
    v_next_target_id,
    case when v_next_target_id is null then 'ABSTAIN' else 'TARGET' end,
    jsonb_build_object('previousTargetId', v_previous_target_id)
  );
  perform private.touch_gameplay_room(p_room_id);
  return public.ms1a_get_player_room(p_room_id);
end;
$$;

create or replace function public.ms1d2_resolve_day_vote(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_vote private.day_vote_rounds%rowtype;
  v_top integer;
  v_top_count integer;
  v_hanged_player_id uuid;
  v_hanged_role_id text;
  v_outcome text;
begin
  select * into v_room from public.rooms room where room.id = p_room_id for update;
  if not found then perform private.raise_ms1d2('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1d2('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1d2('NOT_IN_GAME'); end if;
  if v_room.phase <> 'DAY' then perform private.raise_ms1d2('NOT_DAY'); end if;
  select * into v_vote
  from private.day_vote_rounds vote
  where vote.room_id = p_room_id and vote.day_number = v_room.day_number
  for update;
  if not found then perform private.raise_ms1d2('DAY_VOTE_NOT_OPEN'); end if;
  if v_vote.status = 'RESOLVED' then
    return public.ms1a_get_moderator_room(p_room_id);
  end if;
  if statement_timestamp() < v_vote.deadline_at then
    perform private.raise_ms1d2('DAY_VOTE_NOT_READY');
  end if;
  insert into private.day_vote_result_totals (
    vote_id, target_player_id, weighted_total
  )
  select v_vote.id, ballot.target_player_id,
    sum(case when assignment.role_id = 'mayor' then 2 else 1 end)::integer
  from private.day_ballots ballot
  join public.room_players voter
    on voter.room_id = p_room_id
    and voter.id = ballot.voter_player_id
    and voter.alive
  join public.room_players target
    on target.room_id = p_room_id
    and target.id = ballot.target_player_id
    and target.alive
  join public.room_role_assignments assignment
    on assignment.room_id = p_room_id
    and assignment.player_id = ballot.voter_player_id
  where ballot.vote_id = v_vote.id and ballot.target_player_id is not null
  group by ballot.target_player_id
  on conflict (vote_id, target_player_id) do nothing;
  select max(total.weighted_total) into v_top
  from private.day_vote_result_totals total where total.vote_id = v_vote.id;
  if v_top is null or v_top <= 0 then
    v_outcome := 'NO_VOTES';
  else
    select count(*)
    into v_top_count
    from private.day_vote_result_totals total
    where total.vote_id = v_vote.id and total.weighted_total = v_top;
    if v_top_count = 1 then
      v_outcome := 'HANGED';
      select total.target_player_id into v_hanged_player_id
      from private.day_vote_result_totals total
      where total.vote_id = v_vote.id and total.weighted_total = v_top;
    else
      v_outcome := 'TIE';
      v_hanged_player_id := null;
    end if;
  end if;
  update private.day_vote_rounds
  set status = 'RESOLVED',
      resolved_at = statement_timestamp(),
      outcome = v_outcome,
      hanged_player_id = v_hanged_player_id
  where id = v_vote.id;
  if v_hanged_player_id is not null then
    insert into private.day_effects (
      vote_id, room_id, day_number, source_type, effect_category,
      target_player_id
    ) values (
      v_vote.id, p_room_id, v_room.day_number, 'DAY_HANGING',
      'DAY_LETHAL_EFFECT', v_hanged_player_id
    );
    update public.room_players set alive = false
    where room_id = p_room_id and id = v_hanged_player_id;
    select assignment.role_id into v_hanged_role_id
    from public.room_role_assignments assignment
    where assignment.room_id = p_room_id
      and assignment.player_id = v_hanged_player_id;
    if v_hanged_role_id = 'hunter' then
      update private.day_vote_rounds set hunter_revealed = true where id = v_vote.id;
      insert into private.hunter_day_revenge (
        vote_id, room_id, day_number, hunter_player_id
      ) values (
        v_vote.id, p_room_id, v_room.day_number, v_hanged_player_id
      );
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, actor_player_id, resolution
      ) values (
        p_room_id, v_room.day_number, 'HUNTER_HANGING_REVEALED',
        'hunter', v_hanged_player_id, 'REVENGE_PENDING'
      );
    end if;
    insert into private.gameplay_events (
      room_id, night_number, event_type, target_player_id, resolution, metadata
    ) values (
      p_room_id, v_room.day_number, 'DAY_HANGING_CREATED',
      v_hanged_player_id, 'FINAL',
      jsonb_build_object(
        'sourceType', 'DAY_HANGING',
        'protectorBlockable', false,
        'witchInteractable', false
      )
    );
  end if;
  insert into private.gameplay_events (
    room_id, night_number, event_type, target_player_id, resolution, metadata
  ) values (
    p_room_id, v_room.day_number, 'DAY_VOTE_RESOLVED',
    v_hanged_player_id, v_outcome,
    jsonb_build_object('topWeightedTotal', coalesce(v_top, 0), 'random', false)
  );
  perform private.touch_gameplay_room(p_room_id);
  return public.ms1a_get_moderator_room(p_room_id);
end;
$$;

create or replace function public.ms1d2_submit_hunter_revenge(
  p_room_id uuid,
  p_target_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_player public.room_players%rowtype;
  v_vote private.day_vote_rounds%rowtype;
  v_revenge private.hunter_day_revenge%rowtype;
begin
  select * into v_room from public.rooms room where room.id = p_room_id for update;
  if not found then perform private.raise_ms1d2('ROOM_NOT_FOUND'); end if;
  if v_room.phase <> 'DAY' then perform private.raise_ms1d2('NOT_DAY'); end if;
  select player.* into v_player
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  where membership.room_id = p_room_id and membership.user_id = v_user_id;
  if not found then perform private.raise_ms1d2('NOT_PLAYER'); end if;
  select * into v_vote
  from private.day_vote_rounds vote
  where vote.room_id = p_room_id and vote.day_number = v_room.day_number;
  if not found or v_vote.status <> 'RESOLVED' then
    perform private.raise_ms1d2('HUNTER_REVENGE_NOT_PENDING');
  end if;
  select * into v_revenge
  from private.hunter_day_revenge revenge
  where revenge.vote_id = v_vote.id
  for update;
  if not found or v_revenge.hunter_player_id <> v_player.id then
    perform private.raise_ms1d2('HUNTER_REVENGE_NOT_PENDING');
  end if;
  if v_revenge.status = 'RESOLVED' then
    if v_revenge.target_player_id is not distinct from p_target_player_id then
      return public.ms1a_get_player_room(p_room_id);
    end if;
    perform private.raise_ms1d2('HUNTER_REVENGE_ALREADY_RESOLVED');
  end if;
  if p_target_player_id is not null then
    if p_target_player_id = v_player.id or not exists (
      select 1 from public.room_players target
      where target.room_id = p_room_id
        and target.id = p_target_player_id
        and target.alive
    ) then perform private.raise_ms1d2('INVALID_TARGET'); end if;
    insert into private.day_effects (
      vote_id, room_id, day_number, source_type, source_role_id,
      actor_player_id, target_player_id, effect_category
    ) values (
      v_vote.id, p_room_id, v_room.day_number, 'HUNTER_REVENGE_SHOT',
      'hunter', v_player.id, p_target_player_id, 'NON_VILLAIN_LETHAL_EFFECT'
    );
    update public.room_players set alive = false
    where room_id = p_room_id and id = p_target_player_id;
  end if;
  update private.hunter_day_revenge
  set status = 'RESOLVED',
      target_player_id = p_target_player_id,
      resolved_at = statement_timestamp()
  where vote_id = v_vote.id;
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id, actor_player_id,
    target_player_id, resolution, metadata
  ) values (
    p_room_id, v_room.day_number, 'HUNTER_REVENGE_RESOLVED', 'hunter',
    v_player.id, p_target_player_id,
    case when p_target_player_id is null then 'NOBODY' else 'TARGET_KILLED' end,
    jsonb_build_object('protectorBlockable', false, 'witchInteractable', false)
  );
  perform private.touch_gameplay_room(p_room_id);
  return public.ms1a_get_player_room(p_room_id);
end;
$$;

create or replace function public.ms1d2_start_next_night(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_vote private.day_vote_rounds%rowtype;
begin
  select * into v_room from public.rooms room where room.id = p_room_id for update;
  if not found then perform private.raise_ms1d2('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1d2('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1d2('NOT_IN_GAME'); end if;
  if v_room.phase = 'NIGHT' and exists (
    select 1 from private.day_to_night_transitions transition
    where transition.room_id = p_room_id
      and transition.next_night_number = v_room.day_number
  ) then return public.ms1a_get_moderator_room(p_room_id); end if;
  if v_room.phase <> 'DAY' then perform private.raise_ms1d2('NOT_DAY'); end if;
  select * into v_vote
  from private.day_vote_rounds vote
  where vote.room_id = p_room_id and vote.day_number = v_room.day_number;
  if not found or v_vote.status <> 'RESOLVED' then
    perform private.raise_ms1d2('DAY_CONSEQUENCE_NOT_READY');
  end if;
  if exists (
    select 1 from private.hunter_day_revenge revenge
    where revenge.vote_id = v_vote.id and revenge.status = 'PENDING'
  ) then perform private.raise_ms1d2('DAY_CONSEQUENCE_NOT_READY'); end if;
  insert into private.day_to_night_transitions (
    room_id, day_number, next_night_number, transitioned_by_user_id
  ) values (
    p_room_id, v_room.day_number, v_room.day_number + 1, v_user_id
  );
  insert into private.gameplay_events (
    room_id, night_number, event_type, resolution, metadata
  ) values (
    p_room_id, v_room.day_number, 'NEXT_NIGHT_STARTED',
    'NIGHT_' || (v_room.day_number + 1)::text,
    jsonb_build_object('automaticRoleCall', false)
  );
  update public.rooms
  set phase = 'NIGHT',
      day_number = day_number + 1,
      revision = revision + 1,
      updated_at = statement_timestamp()
  where id = p_room_id;
  return public.ms1a_get_moderator_room(p_room_id);
end;
$$;

create or replace function public.ms1a_get_moderator_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_payload jsonb;
  v_alive_player_ids jsonb;
begin
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1a('NOT_MODERATOR'); end if;
  v_payload := private.moderator_room_payload(p_room_id);
  select coalesce(jsonb_agg(player.id order by player.seat_number)
    filter (where player.alive), '[]'::jsonb)
  into v_alive_player_ids
  from public.room_players player
  where player.room_id = p_room_id;
  return v_payload || jsonb_build_object(
    'alivePlayerIds', v_alive_player_ids,
    'night', private.moderator_night_payload(p_room_id),
    'nightResolution', private.moderator_night_resolution_payload(p_room_id),
    'witchCheckpoint', private.moderator_witch_checkpoint_payload(p_room_id),
    'dayVote', private.moderator_day_vote_payload(p_room_id)
  );
end;
$$;

create or replace function public.ms1a_get_player_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_payload jsonb;
  v_alive_player_ids jsonb;
  v_active_role_id text;
begin
  v_payload := private.player_room_payload(p_room_id, v_user_id);
  if v_payload is null then perform private.raise_ms1a('UNAUTHORIZED'); end if;
  select call.role_id into v_active_role_id
  from private.night_role_calls call
  join public.rooms room on room.id = call.room_id
  where call.room_id = p_room_id
    and call.night_number = room.day_number
    and call.status = 'ACTIVE';
  select coalesce(jsonb_agg(player.id order by player.seat_number)
    filter (where player.alive or (
      room.phase = 'NIGHT' and exists (
        select 1 from private.night_final_deaths death
        where death.room_id = p_room_id
          and death.night_number = room.day_number
          and death.player_id = player.id
      )
    )), '[]'::jsonb)
  into v_alive_player_ids
  from public.room_players player
  join public.rooms room on room.id = player.room_id
  where player.room_id = p_room_id;
  return v_payload || jsonb_build_object(
    'alivePlayerIds', v_alive_player_ids,
    'nightAction', case when v_active_role_id = 'witch'
      then private.witch_player_action_payload(p_room_id, v_user_id)
      else private.player_night_action_payload(p_room_id, v_user_id) end,
    'dayVote', private.player_day_vote_payload(p_room_id, v_user_id)
  );
end;
$$;

alter table private.day_vote_rounds enable row level security;
alter table private.day_ballots enable row level security;
alter table private.day_vote_result_totals enable row level security;
alter table private.day_effects enable row level security;
alter table private.hunter_day_revenge enable row level security;
alter table private.day_to_night_transitions enable row level security;

revoke all on table private.day_vote_rounds from public, anon, authenticated;
revoke all on table private.day_ballots from public, anon, authenticated;
revoke all on table private.day_vote_result_totals from public, anon, authenticated;
revoke all on table private.day_effects from public, anon, authenticated;
revoke all on table private.hunter_day_revenge from public, anon, authenticated;
revoke all on table private.day_to_night_transitions from public, anon, authenticated;

revoke execute on function private.raise_ms1d2(text) from public, anon, authenticated;
revoke execute on function private.day_vote_totals_payload(uuid) from public, anon, authenticated;
revoke execute on function private.day_player_object(uuid) from public, anon, authenticated;
revoke execute on function private.day_effect_payload(uuid, text) from public, anon, authenticated;
revoke execute on function private.moderator_day_vote_payload(uuid) from public, anon, authenticated;
revoke execute on function private.player_day_vote_payload(uuid, uuid) from public, anon, authenticated;

revoke execute on function public.ms1d2_start_day_vote(uuid) from public, anon;
grant execute on function public.ms1d2_start_day_vote(uuid) to authenticated;
revoke execute on function public.ms1d2_cast_day_vote(uuid, uuid) from public, anon;
grant execute on function public.ms1d2_cast_day_vote(uuid, uuid) to authenticated;
revoke execute on function public.ms1d2_resolve_day_vote(uuid) from public, anon;
grant execute on function public.ms1d2_resolve_day_vote(uuid) to authenticated;
revoke execute on function public.ms1d2_submit_hunter_revenge(uuid, uuid) from public, anon;
grant execute on function public.ms1d2_submit_hunter_revenge(uuid, uuid) to authenticated;
revoke execute on function public.ms1d2_start_next_night(uuid) from public, anon;
grant execute on function public.ms1d2_start_next_night(uuid) to authenticated;

commit;
