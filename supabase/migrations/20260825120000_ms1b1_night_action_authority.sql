begin;

alter table public.room_players
  add column alive boolean not null default true;

create table private.night_role_calls (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number integer not null check (night_number >= 1),
  role_id text not null references public.classic_roles(id)
    check (role_id in ('werewolf', 'seer', 'protector')),
  status text not null default 'NOT_CALLED'
    check (status in ('NOT_CALLED', 'ACTIVE', 'COMPLETED')),
  eligible_actor_ids uuid[] not null default '{}'::uuid[],
  eligible_target_ids uuid[] not null default '{}'::uuid[],
  wolf_round text check (wolf_round in ('INITIAL', 'REVOTE')),
  initial_tied_target_ids uuid[] not null default '{}'::uuid[],
  revote_deadline timestamptz,
  final_target_id uuid,
  final_random boolean,
  final_reason text,
  called_at timestamptz,
  completed_at timestamptz,
  unique (room_id, night_number, role_id),
  foreign key (room_id, final_target_id)
    references public.room_players(room_id, id)
);

create unique index night_role_calls_one_active_room_idx
  on private.night_role_calls(room_id)
  where status = 'ACTIVE';

create index night_role_calls_room_night_idx
  on private.night_role_calls(room_id, night_number);

create table private.wolf_ballots (
  call_id uuid not null references private.night_role_calls(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  round text not null check (round in ('INITIAL', 'REVOTE')),
  voter_player_id uuid not null,
  target_player_id uuid,
  confirmed boolean not null default false,
  submitted_at timestamptz not null default statement_timestamp(),
  confirmed_at timestamptz,
  primary key (call_id, round, voter_player_id),
  foreign key (room_id, voter_player_id)
    references public.room_players(room_id, id) on delete cascade,
  foreign key (room_id, target_player_id)
    references public.room_players(room_id, id)
);

create index wolf_ballots_call_round_idx
  on private.wolf_ballots(call_id, round);

create table private.seer_inspections (
  call_id uuid primary key references private.night_role_calls(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number integer not null check (night_number >= 1),
  seer_player_id uuid not null,
  target_player_id uuid not null,
  result text not null check (result in ('WOLF', 'NON_WOLF')),
  inspected_at timestamptz not null default statement_timestamp(),
  acknowledged_at timestamptz,
  unique (room_id, night_number),
  foreign key (room_id, seer_player_id)
    references public.room_players(room_id, id) on delete cascade,
  foreign key (room_id, target_player_id)
    references public.room_players(room_id, id)
);

create table private.protector_intents (
  call_id uuid primary key references private.night_role_calls(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number integer not null check (night_number >= 1),
  protector_player_id uuid not null,
  target_player_id uuid not null,
  submitted_at timestamptz not null default statement_timestamp(),
  unique (room_id, night_number),
  foreign key (room_id, protector_player_id)
    references public.room_players(room_id, id) on delete cascade,
  foreign key (room_id, target_player_id)
    references public.room_players(room_id, id)
);

create index protector_intents_previous_night_idx
  on private.protector_intents(room_id, night_number desc);

create table private.gameplay_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number integer not null check (night_number >= 1),
  event_type text not null check (event_type in (
    'ROLE_CALLED',
    'CALL_COMPLETED',
    'WOLF_REVOTE_STARTED',
    'WOLF_FINAL_TARGET',
    'SEER_INSPECTION',
    'SEER_RESULT_ACKNOWLEDGED',
    'PROTECTOR_INTENT'
  )),
  role_id text not null references public.classic_roles(id),
  actor_player_id uuid,
  target_player_id uuid,
  resolution text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  foreign key (room_id, actor_player_id)
    references public.room_players(room_id, id),
  foreign key (room_id, target_player_id)
    references public.room_players(room_id, id)
);

create index gameplay_events_room_night_created_idx
  on private.gameplay_events(room_id, night_number, created_at);

create or replace function private.raise_ms1b1(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end;
$$;

create or replace function private.touch_gameplay_room(p_room_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.rooms
  set revision = revision + 1,
      updated_at = statement_timestamp()
  where id = p_room_id;
$$;

create or replace function private.complete_wolf_call(
  p_call_id uuid,
  p_target_id uuid,
  p_random boolean,
  p_reason text,
  p_random_candidate_ids uuid[]
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_call private.night_role_calls%rowtype;
begin
  select * into v_call
  from private.night_role_calls call
  where call.id = p_call_id;

  update private.night_role_calls
  set status = 'COMPLETED',
      final_target_id = p_target_id,
      final_random = p_random,
      final_reason = p_reason,
      completed_at = statement_timestamp()
  where id = p_call_id;

  insert into private.gameplay_events (
    room_id,
    night_number,
    event_type,
    role_id,
    target_player_id,
    resolution,
    metadata
  ) values (
    v_call.room_id,
    v_call.night_number,
    'WOLF_FINAL_TARGET',
    'werewolf',
    p_target_id,
    p_reason,
    jsonb_build_object(
      'random', p_random,
      'randomCandidateIds', to_jsonb(coalesce(p_random_candidate_ids, '{}'::uuid[])),
      'intentOnly', true
    )
  );

  insert into private.gameplay_events (
    room_id,
    night_number,
    event_type,
    role_id,
    target_player_id,
    resolution
  ) values (
    v_call.room_id,
    v_call.night_number,
    'CALL_COMPLETED',
    'werewolf',
    p_target_id,
    p_reason
  );
end;
$$;

create or replace function private.moderator_night_action_payload(p_call_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_call private.night_role_calls%rowtype;
  v_selections jsonb := '{}'::jsonb;
  v_confirmed jsonb := '[]'::jsonb;
  v_seer jsonb;
begin
  select * into v_call
  from private.night_role_calls call
  where call.id = p_call_id;
  if not found or cardinality(v_call.eligible_actor_ids) = 0 then
    return null;
  end if;

  if v_call.role_id = 'werewolf' then
    select
      coalesce(jsonb_object_agg(
        ballot.voter_player_id::text,
        to_jsonb(ballot.target_player_id)
      ), '{}'::jsonb),
      coalesce(jsonb_agg(ballot.voter_player_id order by player.seat_number)
        filter (where ballot.confirmed), '[]'::jsonb)
    into v_selections, v_confirmed
    from private.wolf_ballots ballot
    join public.room_players player on player.id = ballot.voter_player_id
    where ballot.call_id = v_call.id
      and ballot.round = coalesce(v_call.wolf_round, 'INITIAL');
  elsif v_call.role_id = 'seer' then
    select
      jsonb_build_object(inspection.seer_player_id::text, inspection.target_player_id),
      case when inspection.acknowledged_at is null
        then '[]'::jsonb
        else jsonb_build_array(inspection.seer_player_id)
      end,
      jsonb_build_object(
        'targetId', inspection.target_player_id,
        'result', inspection.result,
        'acknowledged', inspection.acknowledged_at is not null
      )
    into v_selections, v_confirmed, v_seer
    from private.seer_inspections inspection
    where inspection.call_id = v_call.id;
    v_selections := coalesce(v_selections, '{}'::jsonb);
    v_confirmed := coalesce(v_confirmed, '[]'::jsonb);
  elsif v_call.role_id = 'protector' then
    select
      jsonb_build_object(intent.protector_player_id::text, intent.target_player_id),
      jsonb_build_array(intent.protector_player_id)
    into v_selections, v_confirmed
    from private.protector_intents intent
    where intent.call_id = v_call.id;
    v_selections := coalesce(v_selections, '{}'::jsonb);
    v_confirmed := coalesce(v_confirmed, '[]'::jsonb);
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'id', v_call.id,
    'roleId', v_call.role_id,
    'kind', case when v_call.role_id = 'werewolf'
      then 'WOLF_VOTE' else 'SELECT_TARGET' end,
    'status', case when v_call.status = 'ACTIVE'
      then 'OPEN' else 'COMPLETED' end,
    'eligibleActorIds', to_jsonb(v_call.eligible_actor_ids),
    'eligibleTargetIds', to_jsonb(v_call.eligible_target_ids),
    'selections', v_selections,
    'confirmedActorIds', v_confirmed,
    'wolf', case when v_call.role_id = 'werewolf' then jsonb_build_object(
      'round', coalesce(v_call.wolf_round, 'INITIAL'),
      'initialTiedTargetIds', to_jsonb(v_call.initial_tied_target_ids),
      'deadlineAt', v_call.revote_deadline
    ) end,
    'seer', v_seer,
    'result', case when v_call.final_reason is not null then jsonb_build_object(
      'targetId', v_call.final_target_id,
      'random', v_call.final_random,
      'reason', v_call.final_reason
    ) end,
    'openedAt', v_call.called_at,
    'completedAt', v_call.completed_at
  ));
end;
$$;

create or replace function private.moderator_night_payload(p_room_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_calls jsonb;
  v_actions jsonb;
  v_events jsonb;
  v_active_role text;
begin
  select * into v_room from public.rooms room where room.id = p_room_id;
  if not found or v_room.phase <> 'NIGHT' then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'roleId', config.role_id,
    'status', case
      when call.status = 'ACTIVE' then 'CALLED'
      when call.status = 'COMPLETED' then 'COMPLETED'
      else 'NOT_CALLED'
    end,
    'calledAt', call.called_at,
    'completedAt', call.completed_at
  ) order by case config.role_id
    when 'werewolf' then 10
    when 'seer' then 20
    when 'protector' then 30
  end), '[]'::jsonb)
  into v_calls
  from public.room_role_config config
  left join private.night_role_calls call
    on call.room_id = config.room_id
    and call.night_number = v_room.day_number
    and call.role_id = config.role_id
  where config.room_id = p_room_id
    and config.role_id in ('werewolf', 'seer', 'protector');

  select
    coalesce(jsonb_object_agg(
      call.role_id,
      private.moderator_night_action_payload(call.id)
    ) filter (where cardinality(call.eligible_actor_ids) > 0), '{}'::jsonb),
    max(call.role_id) filter (where call.status = 'ACTIVE')
  into v_actions, v_active_role
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.status <> 'NOT_CALLED';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', event.id,
    'type', event.event_type,
    'timestamp', event.created_at,
    'dayNumber', event.night_number,
    'phase', 'NIGHT',
    'actorPlayerId', event.actor_player_id,
    'actorRoleId', event.role_id,
    'targetPlayerId', event.target_player_id,
    'resolution', event.resolution,
    'metadata', event.metadata
  ) order by event.created_at), '[]'::jsonb)
  into v_events
  from private.gameplay_events event
  where event.room_id = p_room_id;

  return jsonb_build_object(
    'number', v_room.day_number,
    'calls', v_calls,
    'activeRoleId', v_active_role,
    'actionsByRole', v_actions,
    'events', v_events
  );
end;
$$;

create or replace function private.player_night_action_payload(
  p_room_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_player public.room_players%rowtype;
  v_call private.night_role_calls%rowtype;
  v_candidates jsonb;
  v_target_id uuid;
  v_has_selection boolean := false;
  v_confirmed boolean := false;
  v_inspection private.seer_inspections%rowtype;
begin
  select player.* into v_player
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  where membership.room_id = p_room_id
    and membership.user_id = p_user_id;
  if not found or not v_player.alive then
    return null;
  end if;

  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.status = 'ACTIVE';
  if not found or not (v_player.id = any(v_call.eligible_actor_ids)) then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', player.id,
    'seat', player.seat_number,
    'displayName', player.display_name,
    'alive', player.alive
  ) order by player.seat_number), '[]'::jsonb)
  into v_candidates
  from public.room_players player
  where player.room_id = p_room_id
    and player.id = any(v_call.eligible_target_ids);

  if v_call.role_id = 'werewolf' then
    select ballot.target_player_id, ballot.confirmed
    into v_target_id, v_confirmed
    from private.wolf_ballots ballot
    where ballot.call_id = v_call.id
      and ballot.round = v_call.wolf_round
      and ballot.voter_player_id = v_player.id;
    v_has_selection := found;
    if v_confirmed then return null; end if;

    return jsonb_build_object(
      'id', v_call.id,
      'kind', 'WOLF_VOTE',
      'roleId', 'werewolf',
      'roleName', 'Ma Sói',
      'instructions', 'Chọn một người hoặc không chọn. Phiếu trắng là trung lập.',
      'mode', case when v_call.wolf_round = 'REVOTE'
        then 'WOLF_REVOTE' else 'WOLF_BALLOT' end,
      'round', v_call.wolf_round,
      'deadlineAt', v_call.revote_deadline,
      'candidates', v_candidates,
      'currentTargetId', v_target_id,
      'hasSelected', v_has_selection
    );
  end if;

  if v_call.role_id = 'seer' then
    select * into v_inspection
    from private.seer_inspections inspection
    where inspection.call_id = v_call.id;
    if found then
      if v_inspection.acknowledged_at is not null then return null; end if;
      return jsonb_build_object(
        'id', v_call.id,
        'kind', 'SELECT_TARGET',
        'roleId', 'seer',
        'roleName', 'Tiên Tri',
        'instructions', 'Ghi nhớ kết quả rồi úp điện thoại xuống.',
        'mode', 'SEER_RESULT',
        'candidates', '[]'::jsonb,
        'hasSelected', true,
        'inspectedTarget', (
          select jsonb_build_object(
            'id', player.id,
            'seat', player.seat_number,
            'displayName', player.display_name,
            'alive', player.alive
          )
          from public.room_players player
          where player.id = v_inspection.target_player_id
        ),
        'seerResult', v_inspection.result
      );
    end if;
    return jsonb_build_object(
      'id', v_call.id,
      'kind', 'SELECT_TARGET',
      'roleId', 'seer',
      'roleName', 'Tiên Tri',
      'instructions', 'Chọn một người để kiểm tra.',
      'mode', 'SEER_SELECT',
      'candidates', v_candidates,
      'hasSelected', false
    );
  end if;

  return jsonb_build_object(
    'id', v_call.id,
    'kind', 'SELECT_TARGET',
    'roleId', 'protector',
    'roleName', 'Bảo Vệ',
    'instructions', 'Chọn một người để bảo vệ đêm nay.',
    'mode', 'PROTECTOR_SELECT',
    'candidates', v_candidates,
    'hasSelected', false
  );
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
  ) then
    perform private.raise_ms1a('NOT_MODERATOR');
  end if;
  v_payload := private.moderator_room_payload(p_room_id);
  select coalesce(jsonb_agg(player.id order by player.seat_number)
    filter (where player.alive), '[]'::jsonb)
  into v_alive_player_ids
  from public.room_players player
  where player.room_id = p_room_id;
  return v_payload || jsonb_build_object(
    'alivePlayerIds', v_alive_player_ids,
    'night', private.moderator_night_payload(p_room_id)
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
begin
  v_payload := private.player_room_payload(p_room_id, v_user_id);
  if v_payload is null then
    perform private.raise_ms1a('UNAUTHORIZED');
  end if;
  select coalesce(jsonb_agg(player.id order by player.seat_number)
    filter (where player.alive), '[]'::jsonb)
  into v_alive_player_ids
  from public.room_players player
  where player.room_id = p_room_id;
  return v_payload || jsonb_build_object(
    'alivePlayerIds', v_alive_player_ids,
    'nightAction', private.player_night_action_payload(p_room_id, v_user_id)
  );
end;
$$;

create or replace function public.ms1b1_open_night_role_call(
  p_room_id uuid,
  p_role_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_call private.night_role_calls%rowtype;
  v_actor_ids uuid[] := '{}'::uuid[];
  v_target_ids uuid[] := '{}'::uuid[];
  v_has_living_wolf boolean := false;
  v_previous_target_id uuid;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1b1('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1b1('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1b1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1b1('NOT_NIGHT'); end if;
  if p_role_id not in ('werewolf', 'seer', 'protector') or not exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id and config.role_id = p_role_id
  ) then perform private.raise_ms1b1('ROLE_NOT_CONFIGURED'); end if;
  if exists (
    select 1 from private.night_role_calls call
    where call.room_id = p_room_id and call.status = 'ACTIVE'
  ) then perform private.raise_ms1b1('CALL_ALREADY_ACTIVE'); end if;

  insert into private.night_role_calls (room_id, night_number, role_id)
  values (p_room_id, v_room.day_number, p_role_id)
  on conflict (room_id, night_number, role_id) do nothing;

  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = p_role_id
  for update;
  if v_call.status = 'COMPLETED' then
    perform private.raise_ms1b1('CALL_ALREADY_COMPLETED');
  end if;

  if p_role_id = 'werewolf' then
    select exists (
      select 1
      from public.room_role_assignments assignment
      join public.room_players player on player.id = assignment.player_id
      where assignment.room_id = p_room_id
        and assignment.role_id = 'werewolf'
        and player.alive
    ) into v_has_living_wolf;
    if v_has_living_wolf then
      select coalesce(array_agg(player.id order by player.seat_number), '{}'::uuid[])
      into v_actor_ids
      from public.room_players player
      join public.room_role_assignments assignment
        on assignment.room_id = player.room_id and assignment.player_id = player.id
      where player.room_id = p_room_id
        and player.alive
        and assignment.role_id in ('werewolf', 'traitor');
      select coalesce(array_agg(player.id order by player.seat_number), '{}'::uuid[])
      into v_target_ids
      from public.room_players player
      where player.room_id = p_room_id
        and player.alive
        and not (player.id = any(v_actor_ids));
    end if;
  else
    select coalesce(array_agg(player.id order by player.seat_number), '{}'::uuid[])
    into v_actor_ids
    from public.room_players player
    join public.room_role_assignments assignment
      on assignment.room_id = player.room_id and assignment.player_id = player.id
    where player.room_id = p_room_id
      and player.alive
      and assignment.role_id = p_role_id;

    if cardinality(v_actor_ids) > 0 then
      if p_role_id = 'protector' and v_room.day_number > 1 then
        select intent.target_player_id into v_previous_target_id
        from private.protector_intents intent
        where intent.room_id = p_room_id
          and intent.night_number = v_room.day_number - 1;
      end if;
      select coalesce(array_agg(player.id order by player.seat_number), '{}'::uuid[])
      into v_target_ids
      from public.room_players player
      where player.room_id = p_room_id
        and player.alive
        and (p_role_id = 'protector' or not (player.id = any(v_actor_ids)))
        and (v_previous_target_id is null or player.id <> v_previous_target_id);
    end if;
  end if;

  update private.night_role_calls
  set status = 'ACTIVE',
      eligible_actor_ids = v_actor_ids,
      eligible_target_ids = v_target_ids,
      wolf_round = case when p_role_id = 'werewolf' then 'INITIAL' end,
      called_at = statement_timestamp()
  where id = v_call.id;

  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id, metadata
  ) values (
    p_room_id,
    v_room.day_number,
    'ROLE_CALLED',
    p_role_id,
    jsonb_build_object('eligibleActorCount', cardinality(v_actor_ids))
  );
  perform private.touch_gameplay_room(p_room_id);
  return private.moderator_night_payload(p_room_id);
end;
$$;

create or replace function public.ms1b1_complete_empty_night_role_call(
  p_room_id uuid,
  p_role_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_call private.night_role_calls%rowtype;
begin
  select * into v_room from public.rooms room
  where room.id = p_room_id for update;
  if not found then perform private.raise_ms1b1('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1b1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1b1('NOT_NIGHT'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1b1('NOT_MODERATOR'); end if;
  select * into v_call from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = p_role_id
    and call.status = 'ACTIVE'
  for update;
  if not found then perform private.raise_ms1b1('CALL_NOT_ACTIVE'); end if;
  if cardinality(v_call.eligible_actor_ids) > 0 then
    perform private.raise_ms1b1('CALL_HAS_ELIGIBLE_ACTOR');
  end if;
  update private.night_role_calls
  set status = 'COMPLETED', completed_at = statement_timestamp()
  where id = v_call.id;
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id,
    metadata
  ) values (
    p_room_id, v_room.day_number, 'CALL_COMPLETED', p_role_id,
    jsonb_build_object('emptyRitualCall', true)
  );
  perform private.touch_gameplay_room(p_room_id);
  return private.moderator_night_payload(p_room_id);
end;
$$;

create or replace function public.ms1b1_submit_wolf_ballot(
  p_room_id uuid,
  p_target_player_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_call private.night_role_calls%rowtype;
  v_player_id uuid;
  v_existing_confirmed boolean;
begin
  select * into v_room from public.rooms room
  where room.id = p_room_id for update;
  if not found then perform private.raise_ms1b1('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1b1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1b1('NOT_NIGHT'); end if;
  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id
    and player.alive;
  if v_player_id is null then perform private.raise_ms1b1('NOT_PLAYER'); end if;
  select * into v_call from private.night_role_calls call
  where call.room_id = p_room_id and call.status = 'ACTIVE'
    and call.role_id = 'werewolf'
  for update;
  if not found then perform private.raise_ms1b1('CALL_NOT_ACTIVE'); end if;
  if not (v_player_id = any(v_call.eligible_actor_ids)) then
    perform private.raise_ms1b1('WRONG_ROLE');
  end if;
  if v_call.wolf_round = 'REVOTE'
    and statement_timestamp() >= v_call.revote_deadline then
    perform private.raise_ms1b1('REVOTE_EXPIRED');
  end if;
  if p_target_player_id is not null
    and not (p_target_player_id = any(v_call.eligible_target_ids)) then
    perform private.raise_ms1b1('INVALID_TARGET');
  end if;
  select ballot.confirmed into v_existing_confirmed
  from private.wolf_ballots ballot
  where ballot.call_id = v_call.id
    and ballot.round = v_call.wolf_round
    and ballot.voter_player_id = v_player_id;
  if coalesce(v_existing_confirmed, false) then
    perform private.raise_ms1b1('CALL_ALREADY_COMPLETED');
  end if;
  insert into private.wolf_ballots (
    call_id, room_id, round, voter_player_id, target_player_id,
    confirmed, submitted_at, confirmed_at
  ) values (
    v_call.id, p_room_id, v_call.wolf_round, v_player_id,
    p_target_player_id, false, statement_timestamp(), null
  ) on conflict (call_id, round, voter_player_id) do update
  set target_player_id = excluded.target_player_id,
      submitted_at = statement_timestamp();
  perform private.touch_gameplay_room(p_room_id);
  return private.player_night_action_payload(p_room_id, v_user_id);
end;
$$;

create or replace function public.ms1b1_confirm_wolf_ballot(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_call private.night_role_calls%rowtype;
  v_player_id uuid;
begin
  select * into v_room from public.rooms room
  where room.id = p_room_id for update;
  if not found then perform private.raise_ms1b1('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1b1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1b1('NOT_NIGHT'); end if;
  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id
    and player.alive;
  if v_player_id is null then perform private.raise_ms1b1('NOT_PLAYER'); end if;
  select * into v_call from private.night_role_calls call
  where call.room_id = p_room_id and call.status = 'ACTIVE'
    and call.role_id = 'werewolf'
  for update;
  if not found then perform private.raise_ms1b1('CALL_NOT_ACTIVE'); end if;
  if not (v_player_id = any(v_call.eligible_actor_ids)) then
    perform private.raise_ms1b1('WRONG_ROLE');
  end if;
  if not exists (
    select 1 from private.wolf_ballots ballot
    where ballot.call_id = v_call.id
      and ballot.round = v_call.wolf_round
      and ballot.voter_player_id = v_player_id
  ) then perform private.raise_ms1b1('WOLF_ROUND_NOT_READY'); end if;
  update private.wolf_ballots
  set confirmed = true,
      confirmed_at = coalesce(confirmed_at, statement_timestamp())
  where call_id = v_call.id
    and round = v_call.wolf_round
    and voter_player_id = v_player_id;
  perform private.touch_gameplay_room(p_room_id);
  return private.player_night_action_payload(p_room_id, v_user_id);
end;
$$;

create or replace function public.ms1b1_finalize_wolf_round(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_call private.night_role_calls%rowtype;
  v_actor_count integer;
  v_confirmed_count integer;
  v_top_count integer := 0;
  v_leaders uuid[] := '{}'::uuid[];
  v_candidates uuid[] := '{}'::uuid[];
  v_target_id uuid;
  v_now timestamptz := statement_timestamp();
begin
  select * into v_room from public.rooms room
  where room.id = p_room_id for update;
  if not found then perform private.raise_ms1b1('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1b1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1b1('NOT_NIGHT'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1b1('NOT_MODERATOR'); end if;
  select * into v_call from private.night_role_calls call
  where call.room_id = p_room_id and call.status = 'ACTIVE'
    and call.role_id = 'werewolf'
  for update;
  if not found then perform private.raise_ms1b1('CALL_NOT_ACTIVE'); end if;
  v_actor_count := cardinality(v_call.eligible_actor_ids);
  if v_actor_count = 0 then
    perform private.raise_ms1b1('WOLF_NO_BITE_CAPABLE_MEMBER');
  end if;
  select count(*)::integer into v_confirmed_count
  from private.wolf_ballots ballot
  where ballot.call_id = v_call.id
    and ballot.round = v_call.wolf_round
    and ballot.confirmed;

  if v_call.wolf_round = 'INITIAL' and v_confirmed_count <> v_actor_count then
    perform private.raise_ms1b1('WOLF_ROUND_NOT_READY');
  end if;

  if v_call.wolf_round = 'REVOTE'
    and v_now < v_call.revote_deadline
    and v_confirmed_count <> v_actor_count then
    perform private.raise_ms1b1('REVOTE_NOT_READY');
  end if;

  select coalesce(max(vote_count), 0) into v_top_count
  from (
    select count(*)::integer as vote_count
    from private.wolf_ballots ballot
    where ballot.call_id = v_call.id
      and ballot.round = v_call.wolf_round
      and ballot.target_player_id is not null
    group by ballot.target_player_id
  ) counts;

  if v_top_count > 0 then
    select coalesce(array_agg(target_player_id order by target_player_id), '{}'::uuid[])
    into v_leaders
    from (
      select ballot.target_player_id
      from private.wolf_ballots ballot
      where ballot.call_id = v_call.id
        and ballot.round = v_call.wolf_round
        and ballot.target_player_id is not null
      group by ballot.target_player_id
      having count(*) = v_top_count
    ) leaders;
  end if;

  if v_call.wolf_round = 'INITIAL' then
    if cardinality(v_leaders) = 1 then
      perform private.complete_wolf_call(
        v_call.id, v_leaders[1], false, 'UNIQUE_TOP', '{}'::uuid[]
      );
    elsif cardinality(v_leaders) = 0 then
      v_candidates := v_call.eligible_target_ids;
      select candidate into v_target_id
      from unnest(v_candidates) candidate
      order by pg_catalog.random() limit 1;
      perform private.complete_wolf_call(
        v_call.id, v_target_id, true, 'ALL_ABSTAIN_RANDOM', v_candidates
      );
    elsif v_room.wolf_policy = 'REVOTE_10S' then
      update private.night_role_calls
      set wolf_round = 'REVOTE',
          initial_tied_target_ids = v_leaders,
          eligible_target_ids = v_leaders,
          revote_deadline = statement_timestamp() + interval '10 seconds'
      where id = v_call.id;
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, metadata
      ) values (
        p_room_id, v_room.day_number, 'WOLF_REVOTE_STARTED', 'werewolf',
        jsonb_build_object(
          'candidateIds', to_jsonb(v_leaders),
          'deadlineAt', statement_timestamp() + interval '10 seconds'
        )
      );
    else
      v_candidates := v_leaders;
      select candidate into v_target_id
      from unnest(v_candidates) candidate
      order by pg_catalog.random() limit 1;
      perform private.complete_wolf_call(
        v_call.id, v_target_id, true, 'TIED_TOP_RANDOM', v_candidates
      );
    end if;
  else
    if cardinality(v_leaders) = 1 then
      perform private.complete_wolf_call(
        v_call.id, v_leaders[1], false, 'REVOTE_UNIQUE_TOP', '{}'::uuid[]
      );
    elsif v_now < v_call.revote_deadline then
      perform private.raise_ms1b1('REVOTE_NOT_READY');
    elsif cardinality(v_leaders) = 0 then
      v_candidates := v_call.initial_tied_target_ids;
      select candidate into v_target_id
      from unnest(v_candidates) candidate
      order by pg_catalog.random() limit 1;
      perform private.complete_wolf_call(
        v_call.id, v_target_id, true, 'REVOTE_ALL_ABSTAIN_RANDOM', v_candidates
      );
    else
      v_candidates := v_leaders;
      select candidate into v_target_id
      from unnest(v_candidates) candidate
      order by pg_catalog.random() limit 1;
      perform private.complete_wolf_call(
        v_call.id, v_target_id, true, 'REVOTE_TIED_RANDOM', v_candidates
      );
    end if;
  end if;

  perform private.touch_gameplay_room(p_room_id);
  return private.moderator_night_payload(p_room_id);
end;
$$;

create or replace function public.ms1b1_submit_seer_inspection(
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
  v_call private.night_role_calls%rowtype;
  v_player_id uuid;
  v_target_role_id text;
  v_result text;
begin
  select * into v_room from public.rooms room
  where room.id = p_room_id for update;
  if not found then perform private.raise_ms1b1('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1b1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1b1('NOT_NIGHT'); end if;
  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id
    and player.alive;
  if v_player_id is null then perform private.raise_ms1b1('NOT_PLAYER'); end if;
  select * into v_call from private.night_role_calls call
  where call.room_id = p_room_id and call.status = 'ACTIVE'
    and call.role_id = 'seer'
  for update;
  if not found then perform private.raise_ms1b1('CALL_NOT_ACTIVE'); end if;
  if not (v_player_id = any(v_call.eligible_actor_ids)) then
    perform private.raise_ms1b1('WRONG_ROLE');
  end if;
  if not (p_target_player_id = any(v_call.eligible_target_ids)) then
    perform private.raise_ms1b1('INVALID_TARGET');
  end if;
  if exists (
    select 1 from private.seer_inspections inspection
    where inspection.call_id = v_call.id
  ) then perform private.raise_ms1b1('CALL_ALREADY_COMPLETED'); end if;
  select assignment.role_id into v_target_role_id
  from public.room_role_assignments assignment
  where assignment.room_id = p_room_id
    and assignment.player_id = p_target_player_id;
  if v_target_role_id is null then perform private.raise_ms1b1('INVALID_TARGET'); end if;
  v_result := case when v_target_role_id = 'werewolf'
    then 'WOLF' else 'NON_WOLF' end;
  insert into private.seer_inspections (
    call_id, room_id, night_number, seer_player_id,
    target_player_id, result
  ) values (
    v_call.id, p_room_id, v_room.day_number, v_player_id,
    p_target_player_id, v_result
  );
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id,
    actor_player_id, target_player_id, resolution
  ) values (
    p_room_id, v_room.day_number, 'SEER_INSPECTION', 'seer',
    v_player_id, p_target_player_id, v_result
  );
  perform private.touch_gameplay_room(p_room_id);
  return private.player_night_action_payload(p_room_id, v_user_id);
end;
$$;

create or replace function public.ms1b1_acknowledge_seer_result(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_call private.night_role_calls%rowtype;
  v_player_id uuid;
  v_target_id uuid;
  v_result text;
begin
  select * into v_room from public.rooms room
  where room.id = p_room_id for update;
  if not found then perform private.raise_ms1b1('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1b1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1b1('NOT_NIGHT'); end if;
  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id
    and player.alive;
  if v_player_id is null then perform private.raise_ms1b1('NOT_PLAYER'); end if;
  select * into v_call from private.night_role_calls call
  where call.room_id = p_room_id and call.status = 'ACTIVE'
    and call.role_id = 'seer'
  for update;
  if not found then perform private.raise_ms1b1('CALL_NOT_ACTIVE'); end if;
  if not (v_player_id = any(v_call.eligible_actor_ids)) then
    perform private.raise_ms1b1('WRONG_ROLE');
  end if;
  select inspection.target_player_id, inspection.result
  into v_target_id, v_result
  from private.seer_inspections inspection
  where inspection.call_id = v_call.id
    and inspection.seer_player_id = v_player_id
    and inspection.acknowledged_at is null;
  if not found then perform private.raise_ms1b1('CALL_NOT_ACTIVE'); end if;
  update private.seer_inspections
  set acknowledged_at = statement_timestamp()
  where call_id = v_call.id;
  update private.night_role_calls
  set status = 'COMPLETED', completed_at = statement_timestamp()
  where id = v_call.id;
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id,
    actor_player_id, target_player_id, resolution
  ) values
    (p_room_id, v_room.day_number, 'SEER_RESULT_ACKNOWLEDGED', 'seer',
      v_player_id, v_target_id, v_result),
    (p_room_id, v_room.day_number, 'CALL_COMPLETED', 'seer',
      v_player_id, v_target_id, v_result);
  perform private.touch_gameplay_room(p_room_id);
  return private.player_night_action_payload(p_room_id, v_user_id);
end;
$$;

create or replace function public.ms1b1_submit_protector_target(
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
  v_call private.night_role_calls%rowtype;
  v_player_id uuid;
  v_previous_target_id uuid;
begin
  select * into v_room from public.rooms room
  where room.id = p_room_id for update;
  if not found then perform private.raise_ms1b1('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1b1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1b1('NOT_NIGHT'); end if;
  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id
    and player.alive;
  if v_player_id is null then perform private.raise_ms1b1('NOT_PLAYER'); end if;
  select * into v_call from private.night_role_calls call
  where call.room_id = p_room_id and call.status = 'ACTIVE'
    and call.role_id = 'protector'
  for update;
  if not found then perform private.raise_ms1b1('CALL_NOT_ACTIVE'); end if;
  if not (v_player_id = any(v_call.eligible_actor_ids)) then
    perform private.raise_ms1b1('WRONG_ROLE');
  end if;
  if v_room.day_number > 1 then
    select intent.target_player_id into v_previous_target_id
    from private.protector_intents intent
    where intent.room_id = p_room_id
      and intent.night_number = v_room.day_number - 1;
    if v_previous_target_id = p_target_player_id then
      perform private.raise_ms1b1('SAME_PROTECTOR_TARGET');
    end if;
  end if;
  if not (p_target_player_id = any(v_call.eligible_target_ids)) then
    perform private.raise_ms1b1('INVALID_TARGET');
  end if;
  if exists (
    select 1 from private.protector_intents intent
    where intent.call_id = v_call.id
  ) then perform private.raise_ms1b1('CALL_ALREADY_COMPLETED'); end if;
  insert into private.protector_intents (
    call_id, room_id, night_number, protector_player_id, target_player_id
  ) values (
    v_call.id, p_room_id, v_room.day_number, v_player_id, p_target_player_id
  );
  update private.night_role_calls
  set status = 'COMPLETED', completed_at = statement_timestamp()
  where id = v_call.id;
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id,
    actor_player_id, target_player_id, metadata
  ) values
    (p_room_id, v_room.day_number, 'PROTECTOR_INTENT', 'protector',
      v_player_id, p_target_player_id,
      jsonb_build_object('intentOnly', true, 'sourceAware', true)),
    (p_room_id, v_room.day_number, 'CALL_COMPLETED', 'protector',
      v_player_id, p_target_player_id,
      jsonb_build_object('effectResolved', false));
  perform private.touch_gameplay_room(p_room_id);
  return private.player_night_action_payload(p_room_id, v_user_id);
end;
$$;

alter table private.night_role_calls enable row level security;
alter table private.wolf_ballots enable row level security;
alter table private.seer_inspections enable row level security;
alter table private.protector_intents enable row level security;
alter table private.gameplay_events enable row level security;

revoke all on table private.night_role_calls from public, anon, authenticated;
revoke all on table private.wolf_ballots from public, anon, authenticated;
revoke all on table private.seer_inspections from public, anon, authenticated;
revoke all on table private.protector_intents from public, anon, authenticated;
revoke all on table private.gameplay_events from public, anon, authenticated;

revoke execute on function private.raise_ms1b1(text) from public, anon, authenticated;
revoke execute on function private.touch_gameplay_room(uuid) from public, anon, authenticated;
revoke execute on function private.complete_wolf_call(uuid, uuid, boolean, text, uuid[]) from public, anon, authenticated;
revoke execute on function private.moderator_night_action_payload(uuid) from public, anon, authenticated;
revoke execute on function private.moderator_night_payload(uuid) from public, anon, authenticated;
revoke execute on function private.player_night_action_payload(uuid, uuid) from public, anon, authenticated;

revoke execute on function public.ms1b1_open_night_role_call(uuid, text) from public, anon;
revoke execute on function public.ms1b1_complete_empty_night_role_call(uuid, text) from public, anon;
revoke execute on function public.ms1b1_submit_wolf_ballot(uuid, uuid) from public, anon;
revoke execute on function public.ms1b1_confirm_wolf_ballot(uuid) from public, anon;
revoke execute on function public.ms1b1_finalize_wolf_round(uuid) from public, anon;
revoke execute on function public.ms1b1_submit_seer_inspection(uuid, uuid) from public, anon;
revoke execute on function public.ms1b1_acknowledge_seer_result(uuid) from public, anon;
revoke execute on function public.ms1b1_submit_protector_target(uuid, uuid) from public, anon;

grant execute on function public.ms1b1_open_night_role_call(uuid, text) to authenticated;
grant execute on function public.ms1b1_complete_empty_night_role_call(uuid, text) to authenticated;
grant execute on function public.ms1b1_submit_wolf_ballot(uuid, uuid) to authenticated;
grant execute on function public.ms1b1_confirm_wolf_ballot(uuid) to authenticated;
grant execute on function public.ms1b1_finalize_wolf_round(uuid) to authenticated;
grant execute on function public.ms1b1_submit_seer_inspection(uuid, uuid) to authenticated;
grant execute on function public.ms1b1_acknowledge_seer_result(uuid) to authenticated;
grant execute on function public.ms1b1_submit_protector_target(uuid, uuid) to authenticated;

revoke execute on function public.ms1a_get_moderator_room(uuid) from public, anon;
revoke execute on function public.ms1a_get_player_room(uuid) from public, anon;
grant execute on function public.ms1a_get_moderator_room(uuid) to authenticated;
grant execute on function public.ms1a_get_player_room(uuid) to authenticated;

commit;
