begin;

alter table private.night_role_calls
  drop constraint if exists night_role_calls_role_id_check;
alter table private.night_role_calls
  add constraint night_role_calls_role_id_check
  check (role_id in ('werewolf', 'seer', 'protector', 'hunter', 'witch'));

update private.night_role_stages
set stage_order = 50
where role_id = 'witch';
insert into private.night_role_stages (role_id, stage, stage_order)
values ('hunter', 'PRE_WITCH', 40);

alter table private.night_effects
  add column activation_condition text,
  add column condition_player_id uuid,
  add column activation_status text;
alter table private.night_effects
  add constraint night_effects_condition_player_fk
  foreign key (room_id, condition_player_id)
    references public.room_players(room_id, id);
alter table private.night_effects
  add constraint night_effects_activation_check check (
    (
      activation_condition is null
      and condition_player_id is null
      and activation_status is null
    ) or (
      activation_condition = 'SOURCE_PLAYER_FINAL_NIGHT_DEATH'
      and condition_player_id is not null
      and activation_status in (
        'CONDITIONAL',
        'ACTIVATED',
        'CANCELED_SOURCE_SURVIVED'
      )
    )
  );

create table private.hunter_night_intents (
  call_id uuid primary key references private.night_role_calls(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number integer not null check (night_number >= 1),
  hunter_player_id uuid not null,
  target_player_id uuid,
  confirmed boolean not null default false,
  selected_at timestamptz not null default statement_timestamp(),
  confirmed_at timestamptz,
  unique (room_id, night_number),
  foreign key (room_id, hunter_player_id)
    references public.room_players(room_id, id),
  foreign key (room_id, target_player_id)
    references public.room_players(room_id, id),
  check (target_player_id is null or target_player_id <> hunter_player_id),
  check ((confirmed and confirmed_at is not null) or (not confirmed and confirmed_at is null))
);

create table private.morning_transitions (
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number integer not null check (night_number >= 1),
  transitioned_by_user_id uuid not null references auth.users(id),
  transitioned_at timestamptz not null default statement_timestamp(),
  primary key (room_id, night_number)
);

create index hunter_night_intents_room_night_idx
  on private.hunter_night_intents(room_id, night_number);

alter table private.gameplay_events
  drop constraint if exists gameplay_events_event_type_check;
alter table private.gameplay_events
  alter column role_id drop not null;
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
    'MORNING_STARTED'
  ));

create or replace function private.raise_ms1d1(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end;
$$;

create or replace function public.ms1d1_open_hunter_call(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_call private.night_role_calls%rowtype;
  v_hunter_player_id uuid;
  v_actor_ids uuid[] := '{}'::uuid[];
  v_target_ids uuid[] := '{}'::uuid[];
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1d1('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1d1('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1d1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1d1('NOT_NIGHT'); end if;
  if not exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id
      and config.role_id = 'hunter'
      and config.quantity = 1
  ) then perform private.raise_ms1d1('ROLE_NOT_CONFIGURED'); end if;
  if exists (
    select 1 from private.night_role_calls call
    where call.room_id = p_room_id and call.status = 'ACTIVE'
  ) then perform private.raise_ms1d1('CALL_ALREADY_ACTIVE'); end if;

  insert into private.night_role_calls (room_id, night_number, role_id)
  values (p_room_id, v_room.day_number, 'hunter')
  on conflict (room_id, night_number, role_id) do nothing;
  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = 'hunter'
  for update;
  if v_call.status = 'COMPLETED' then
    perform private.raise_ms1d1('CALL_ALREADY_COMPLETED');
  end if;

  select assignment.player_id into v_hunter_player_id
  from public.room_role_assignments assignment
  where assignment.room_id = p_room_id and assignment.role_id = 'hunter';
  if exists (
    select 1 from public.room_players player
    where player.room_id = p_room_id
      and player.id = v_hunter_player_id
      and player.alive
  ) then
    v_actor_ids := array[v_hunter_player_id];
    select coalesce(array_agg(player.id order by player.seat_number), '{}'::uuid[])
    into v_target_ids
    from public.room_players player
    where player.room_id = p_room_id
      and player.alive
      and player.id <> v_hunter_player_id;
  end if;

  update private.night_role_calls
  set status = 'ACTIVE',
      eligible_actor_ids = v_actor_ids,
      eligible_target_ids = v_target_ids,
      called_at = statement_timestamp()
  where id = v_call.id;
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id, metadata
  ) values (
    p_room_id, v_room.day_number, 'ROLE_CALLED', 'hunter',
    jsonb_build_object('eligibleActorCount', cardinality(v_actor_ids))
  );
  perform private.touch_gameplay_room(p_room_id);
  return private.moderator_night_payload(p_room_id);
end;
$$;

create or replace function public.ms1d1_submit_hunter_prelock(
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
  v_confirmed boolean := false;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1d1('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1d1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1d1('NOT_NIGHT'); end if;

  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  join public.room_role_assignments assignment
    on assignment.room_id = player.room_id and assignment.player_id = player.id
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id
    and player.alive
    and assignment.role_id = 'hunter';
  if v_player_id is null then perform private.raise_ms1d1('WRONG_ROLE'); end if;

  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = 'hunter'
    and call.status = 'ACTIVE'
  for update;
  if not found then perform private.raise_ms1d1('CALL_NOT_ACTIVE'); end if;
  if not (v_player_id = any(v_call.eligible_actor_ids)) then
    perform private.raise_ms1d1('WRONG_ROLE');
  end if;
  if p_target_player_id is not null
    and not (p_target_player_id = any(v_call.eligible_target_ids)) then
    perform private.raise_ms1d1('INVALID_TARGET');
  end if;

  select intent.confirmed into v_confirmed
  from private.hunter_night_intents intent
  where intent.call_id = v_call.id;
  if coalesce(v_confirmed, false) then
    perform private.raise_ms1d1('HUNTER_PRELOCK_ALREADY_CONFIRMED');
  end if;

  insert into private.hunter_night_intents (
    call_id, room_id, night_number, hunter_player_id, target_player_id
  ) values (
    v_call.id, p_room_id, v_room.day_number, v_player_id, p_target_player_id
  )
  on conflict (call_id) do update
  set target_player_id = excluded.target_player_id,
      selected_at = statement_timestamp()
  where not private.hunter_night_intents.confirmed;
  perform private.touch_gameplay_room(p_room_id);
  return private.player_night_action_payload(p_room_id, v_user_id);
end;
$$;

create or replace function public.ms1d1_confirm_hunter_prelock(p_room_id uuid)
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
  v_intent private.hunter_night_intents%rowtype;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1d1('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1d1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1d1('NOT_NIGHT'); end if;

  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  join public.room_role_assignments assignment
    on assignment.room_id = player.room_id and assignment.player_id = player.id
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id
    and player.alive
    and assignment.role_id = 'hunter';
  if v_player_id is null then perform private.raise_ms1d1('WRONG_ROLE'); end if;

  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = 'hunter'
  for update;
  if not found then perform private.raise_ms1d1('CALL_NOT_ACTIVE'); end if;

  select * into v_intent
  from private.hunter_night_intents intent
  where intent.call_id = v_call.id
    and intent.hunter_player_id = v_player_id
  for update;
  if v_call.status = 'COMPLETED' and found and v_intent.confirmed then
    return null;
  end if;
  if v_call.status <> 'ACTIVE' then perform private.raise_ms1d1('CALL_NOT_ACTIVE'); end if;
  if not (v_player_id = any(v_call.eligible_actor_ids)) then
    perform private.raise_ms1d1('WRONG_ROLE');
  end if;
  if not found then perform private.raise_ms1d1('HUNTER_PRELOCK_REQUIRED'); end if;

  update private.hunter_night_intents
  set confirmed = true, confirmed_at = statement_timestamp()
  where call_id = v_call.id and not confirmed;
  update private.night_role_calls
  set status = 'COMPLETED', completed_at = statement_timestamp()
  where id = v_call.id;
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id, actor_player_id,
    target_player_id, resolution, metadata
  ) values (
    p_room_id, v_room.day_number, 'HUNTER_TARGET_LOCKED', 'hunter',
    v_player_id, v_intent.target_player_id,
    case when v_intent.target_player_id is null then 'NOBODY' else 'TARGET_LOCKED' end,
    jsonb_build_object('prelockOnly', true)
  );
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id, actor_player_id, metadata
  ) values (
    p_room_id, v_room.day_number, 'CALL_COMPLETED', 'hunter', v_player_id,
    jsonb_build_object('prelockConfirmed', true)
  );
  perform private.touch_gameplay_room(p_room_id);
  return null;
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
  elsif v_call.role_id = 'hunter' then
    select
      jsonb_build_object(intent.hunter_player_id::text, intent.target_player_id),
      case when intent.confirmed
        then jsonb_build_array(intent.hunter_player_id)
        else '[]'::jsonb
      end
    into v_selections, v_confirmed
    from private.hunter_night_intents intent
    where intent.call_id = v_call.id;
    v_selections := coalesce(v_selections, '{}'::jsonb);
    v_confirmed := coalesce(v_confirmed, '[]'::jsonb);
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'id', v_call.id,
    'roleId', v_call.role_id,
    'kind', case
      when v_call.role_id = 'werewolf' then 'WOLF_VOTE'
      when v_call.role_id = 'hunter' then 'HUNTER_PRELOCK'
      else 'SELECT_TARGET'
    end,
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
  if not found or not v_player.alive then return null; end if;

  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id and call.status = 'ACTIVE';
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

  if v_call.role_id = 'hunter' then
    select intent.target_player_id, intent.confirmed
    into v_target_id, v_confirmed
    from private.hunter_night_intents intent
    where intent.call_id = v_call.id
      and intent.hunter_player_id = v_player.id;
    v_has_selection := found;
    if v_confirmed then return null; end if;
    return jsonb_build_object(
      'id', v_call.id,
      'kind', 'HUNTER_PRELOCK',
      'roleId', 'hunter',
      'roleName', 'Thợ Săn',
      'instructions', 'Khóa trước một người còn sống hoặc chọn Không ai. Đây chưa phải phát bắn.',
      'mode', 'HUNTER_PRELOCK',
      'candidates', v_candidates,
      'currentTargetId', v_target_id,
      'hasSelected', v_has_selection
    );
  end if;

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

create or replace function private.moderator_night_resolution_payload(
  p_room_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_resolution private.night_resolutions%rowtype;
  v_effects jsonb;
  v_candidates jsonb;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id;
  if not found then return null; end if;

  select * into v_resolution
  from private.night_resolutions resolution
  where resolution.room_id = p_room_id
    and resolution.night_number = v_room.day_number;
  if not found then return null; end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', effect.id,
    'sourceType', effect.source_type,
    'sourceRoleId', effect.source_role_id,
    'category', effect.effect_category,
    'targetPlayerId', effect.target_player_id,
    'lethal', effect.lethal,
    'protectorBlockable', effect.protector_blockable,
    'outcome', effect.outcome,
    'activationCondition', case when effect.activation_condition is null
      then null else jsonb_build_object(
        'kind', effect.activation_condition,
        'sourcePlayerId', effect.condition_player_id
      ) end,
    'activationStatus', effect.activation_status,
    'blockSourceType', effect.block_source_type,
    'blockSourceRoleId', effect.block_source_role_id
  )) order by effect.created_at, effect.id), '[]'::jsonb)
  into v_effects
  from private.night_effects effect
  where effect.resolution_id = v_resolution.id;

  select coalesce(jsonb_agg(candidate.player_id order by player.seat_number), '[]'::jsonb)
  into v_candidates
  from (
    select distinct death.player_id
    from private.provisional_night_death_candidates death
    where death.room_id = p_room_id
      and death.night_number = v_resolution.night_number
  ) candidate
  join public.room_players player on player.id = candidate.player_id;

  return jsonb_build_object(
    'id', v_resolution.id,
    'nightNumber', v_resolution.night_number,
    'outcome', v_resolution.outcome,
    'effects', v_effects,
    'provisionalDeathCandidateIds', v_candidates,
    'resolvedAt', v_resolution.resolved_at
  );
end;
$$;

create or replace function public.ms1b2_resolve_night_effects(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_wolf_call private.night_role_calls%rowtype;
  v_protector_call private.night_role_calls%rowtype;
  v_hunter_call private.night_role_calls%rowtype;
  v_wolf_configured boolean := false;
  v_protector_configured boolean := false;
  v_hunter_configured boolean := false;
  v_protector_target_id uuid;
  v_hunter_player_id uuid;
  v_hunter_target_id uuid;
  v_resolution_id uuid;
  v_effect_id uuid;
  v_resolution_outcome text;
  v_effect_outcome text;
  v_blocked boolean := false;
  v_hunter_provisional boolean := false;
  v_effect_count integer := 0;
  v_candidate_count integer := 0;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1d1('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1d1('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1d1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1d1('NOT_NIGHT'); end if;

  if exists (
    select 1 from private.night_resolutions resolution
    where resolution.room_id = p_room_id
      and resolution.night_number = v_room.day_number
  ) then return private.moderator_night_resolution_payload(p_room_id); end if;

  select exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id and config.role_id = 'werewolf' and config.quantity > 0
  ) into v_wolf_configured;
  select exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id and config.role_id = 'protector' and config.quantity > 0
  ) into v_protector_configured;
  select exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id and config.role_id = 'hunter' and config.quantity = 1
  ) into v_hunter_configured;

  if v_wolf_configured then
    select * into v_wolf_call
    from private.night_role_calls call
    where call.room_id = p_room_id
      and call.night_number = v_room.day_number
      and call.role_id = 'werewolf';
    if not found or v_wolf_call.status <> 'COMPLETED' then
      perform private.raise_ms1d1('NIGHT_RESOLUTION_NOT_READY');
    end if;
  end if;
  if v_protector_configured then
    select * into v_protector_call
    from private.night_role_calls call
    where call.room_id = p_room_id
      and call.night_number = v_room.day_number
      and call.role_id = 'protector';
    if not found or v_protector_call.status <> 'COMPLETED' then
      perform private.raise_ms1d1('NIGHT_RESOLUTION_NOT_READY');
    end if;
    select intent.target_player_id into v_protector_target_id
    from private.protector_intents intent
    where intent.room_id = p_room_id
      and intent.night_number = v_room.day_number;
  end if;
  if v_hunter_configured then
    select * into v_hunter_call
    from private.night_role_calls call
    where call.room_id = p_room_id
      and call.night_number = v_room.day_number
      and call.role_id = 'hunter';
    if not found or v_hunter_call.status <> 'COMPLETED' then
      perform private.raise_ms1d1('NIGHT_RESOLUTION_NOT_READY');
    end if;
    select intent.hunter_player_id, intent.target_player_id
    into v_hunter_player_id, v_hunter_target_id
    from private.hunter_night_intents intent
    where intent.call_id = v_hunter_call.id and intent.confirmed;
  end if;

  if not v_wolf_configured or v_wolf_call.final_target_id is null then
    v_resolution_outcome := 'NO_ATTACK';
  else
    v_blocked := v_protector_target_id is not null
      and v_protector_target_id = v_wolf_call.final_target_id;
    v_resolution_outcome := case when v_blocked then 'BLOCKED' else 'UNBLOCKED' end;
    v_effect_outcome := case when v_blocked
      then 'BLOCKED_BY_PROTECTOR' else 'UNBLOCKED' end;
  end if;

  insert into private.night_resolutions (
    room_id, night_number, outcome, resolved_by_user_id
  ) values (
    p_room_id, v_room.day_number, v_resolution_outcome, v_user_id
  ) returning id into v_resolution_id;

  if v_resolution_outcome <> 'NO_ATTACK' then
    insert into private.night_effects (
      resolution_id, room_id, night_number, source_call_id, source_type,
      source_role_id, effect_category, target_player_id, lethal,
      protector_blockable, outcome, block_source_type, block_source_role_id
    ) values (
      v_resolution_id, p_room_id, v_room.day_number, v_wolf_call.id,
      'WOLF_ATTACK', 'werewolf', 'HOSTILE_VILLAIN_ATTACK',
      v_wolf_call.final_target_id, true, true, v_effect_outcome,
      case when v_blocked then 'PROTECTOR_SHIELD' end,
      case when v_blocked then 'protector' end
    ) returning id into v_effect_id;
    insert into private.gameplay_events (
      room_id, night_number, event_type, role_id, target_player_id,
      resolution, metadata
    ) values (
      p_room_id, v_room.day_number, 'WOLF_ATTACK_CREATED', 'werewolf',
      v_wolf_call.final_target_id, v_effect_outcome,
      jsonb_build_object(
        'effectId', v_effect_id,
        'sourceType', 'WOLF_ATTACK',
        'effectCategory', 'HOSTILE_VILLAIN_ATTACK',
        'lethal', true,
        'protectorBlockable', true
      )
    );
    if v_blocked then
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, target_player_id,
        resolution, metadata
      ) values (
        p_room_id, v_room.day_number, 'WOLF_ATTACK_BLOCKED', 'werewolf',
        v_wolf_call.final_target_id, 'BLOCKED_BY_PROTECTOR',
        jsonb_build_object(
          'effectId', v_effect_id,
          'blockSourceType', 'PROTECTOR_SHIELD',
          'blockSourceRoleId', 'protector'
        )
      );
    else
      insert into private.provisional_night_death_candidates (
        room_id, night_number, player_id, source_effect_id
      ) values (
        p_room_id, v_room.day_number, v_wolf_call.final_target_id, v_effect_id
      );
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, target_player_id,
        resolution, metadata
      ) values (
        p_room_id, v_room.day_number, 'NIGHT_DEATH_CANDIDATE_CREATED',
        'werewolf', v_wolf_call.final_target_id, 'PROVISIONAL_PRE_WITCH',
        jsonb_build_object('sourceEffectId', v_effect_id, 'finalDeathApplied', false)
      );
    end if;
  end if;

  if v_hunter_target_id is not null then
    select exists (
      select 1 from private.provisional_night_death_candidates candidate
      where candidate.room_id = p_room_id
        and candidate.night_number = v_room.day_number
        and candidate.player_id = v_hunter_player_id
    ) into v_hunter_provisional;
    insert into private.night_effects (
      resolution_id, room_id, night_number, source_call_id, source_type,
      source_role_id, effect_category, target_player_id, lethal,
      protector_blockable, outcome, activation_condition,
      condition_player_id, activation_status
    ) values (
      v_resolution_id, p_room_id, v_room.day_number, v_hunter_call.id,
      'HUNTER_SHOT', 'hunter', 'NON_VILLAIN_LETHAL_EFFECT',
      v_hunter_target_id, true, false, 'UNBLOCKED',
      'SOURCE_PLAYER_FINAL_NIGHT_DEATH', v_hunter_player_id, 'CONDITIONAL'
    ) returning id into v_effect_id;
    insert into private.gameplay_events (
      room_id, night_number, event_type, role_id, actor_player_id,
      target_player_id, resolution, metadata
    ) values (
      p_room_id, v_room.day_number, 'HUNTER_SHOT_CREATED', 'hunter',
      v_hunter_player_id, v_hunter_target_id, 'CONDITIONAL',
      jsonb_build_object(
        'effectId', v_effect_id,
        'activationCondition', 'SOURCE_PLAYER_FINAL_NIGHT_DEATH',
        'protectorBlockable', false
      )
    );
    if v_hunter_provisional then
      insert into private.provisional_night_death_candidates (
        room_id, night_number, player_id, source_effect_id
      ) values (
        p_room_id, v_room.day_number, v_hunter_target_id, v_effect_id
      );
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, target_player_id,
        resolution, metadata
      ) values (
        p_room_id, v_room.day_number, 'NIGHT_DEATH_CANDIDATE_CREATED',
        'hunter', v_hunter_target_id, 'PROVISIONAL_PRE_WITCH',
        jsonb_build_object(
          'sourceEffectId', v_effect_id,
          'conditionalOnPlayerId', v_hunter_player_id,
          'finalDeathApplied', false
        )
      );
    end if;
  end if;

  select count(*) into v_effect_count
  from private.night_effects effect where effect.resolution_id = v_resolution_id;
  select count(distinct candidate.player_id) into v_candidate_count
  from private.provisional_night_death_candidates candidate
  where candidate.room_id = p_room_id
    and candidate.night_number = v_room.day_number;
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id, target_player_id,
    resolution, metadata
  ) values (
    p_room_id, v_room.day_number, 'NIGHT_RESOLUTION_COMPLETED', 'werewolf',
    case when v_resolution_outcome = 'NO_ATTACK'
      then null else v_wolf_call.final_target_id end,
    v_resolution_outcome,
    jsonb_build_object(
      'resolutionId', v_resolution_id,
      'effectCount', v_effect_count,
      'provisionalDeathCandidateCount', v_candidate_count,
      'finalDeathsApplied', false
    )
  );
  perform private.touch_gameplay_room(p_room_id);
  return private.moderator_night_resolution_payload(p_room_id);
end;
$$;

create or replace function private.moderator_witch_checkpoint_payload(
  p_room_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_finalization private.night_finalizations%rowtype;
  v_decision private.witch_decisions%rowtype;
  v_resources private.witch_resources%rowtype;
  v_rescued_ids jsonb := '[]'::jsonb;
  v_final_deaths jsonb := '[]'::jsonb;
  v_poison_effect jsonb;
  v_conditional_states jsonb := '[]'::jsonb;
begin
  select * into v_room from public.rooms room where room.id = p_room_id;
  if not found then return null; end if;
  select * into v_finalization
  from private.night_finalizations finalization
  where finalization.room_id = p_room_id
    and finalization.night_number = v_room.day_number;
  if not found then return null; end if;

  select * into v_decision
  from private.witch_decisions decision
  where decision.room_id = p_room_id
    and decision.night_number = v_room.day_number;
  select * into v_resources
  from private.witch_resources resources
  where resources.room_id = p_room_id;

  select coalesce(jsonb_agg(rescue.target_player_id order by player.seat_number), '[]'::jsonb)
  into v_rescued_ids
  from (
    select distinct rescued.target_player_id
    from private.witch_rescues rescued
    where rescued.finalization_id = v_finalization.id
  ) rescue
  join public.room_players player on player.id = rescue.target_player_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'playerId', deaths.player_id,
    'sourceEffectIds', deaths.source_effect_ids
  ) order by player.seat_number), '[]'::jsonb)
  into v_final_deaths
  from (
    select death.player_id,
      jsonb_agg(death.source_effect_id order by death.source_effect_id) source_effect_ids
    from private.night_final_deaths death
    where death.finalization_id = v_finalization.id
    group by death.player_id
  ) deaths
  join public.room_players player on player.id = deaths.player_id;

  select jsonb_build_object(
    'id', effect.id,
    'sourceType', effect.source_type,
    'sourceRoleId', effect.source_role_id,
    'category', effect.effect_category,
    'targetPlayerId', effect.target_player_id,
    'lethal', effect.lethal,
    'protectorBlockable', effect.protector_blockable,
    'outcome', effect.outcome
  ) into v_poison_effect
  from private.night_effects effect
  where effect.resolution_id = v_finalization.resolution_id
    and effect.source_type = 'WITCH_POISON';

  select coalesce(jsonb_agg(jsonb_build_object(
    'effectId', effect.id,
    'status', effect.activation_status
  ) order by effect.created_at, effect.id), '[]'::jsonb)
  into v_conditional_states
  from private.night_effects effect
  where effect.resolution_id = v_finalization.resolution_id
    and effect.activation_condition is not null;

  return jsonb_build_object(
    'id', v_finalization.id,
    'nightNumber', v_finalization.night_number,
    'finalizedAt', v_finalization.finalized_at,
    'decision', jsonb_build_object(
      'resurrectionTargetId', v_decision.resurrection_target_id,
      'poisonTargetId', v_decision.poison_target_id
    ),
    'rescuedPlayerIds', v_rescued_ids,
    'poisonEffect', v_poison_effect,
    'finalDeaths', v_final_deaths,
    'conditionalEffectStates', v_conditional_states,
    'resourcesAfter', case when v_resources.room_id is null then null else jsonb_build_object(
      'witchPlayerId', v_resources.witch_player_id,
      'resurrectionAvailable', v_resources.resurrection_available,
      'poisonAvailable', v_resources.poison_available
    ) end
  );
end;
$$;

create or replace function public.ms1c_finalize_night_checkpoint(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_resolution private.night_resolutions%rowtype;
  v_finalization_id uuid;
  v_witch_configured boolean;
  v_witch_player_id uuid;
  v_witch_alive boolean := false;
  v_call private.night_role_calls%rowtype;
  v_decision private.witch_decisions%rowtype;
  v_resources private.witch_resources%rowtype;
  v_poison_effect_id uuid;
  v_attacked boolean := false;
  v_death record;
  v_effect record;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1d1('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1d1('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1d1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1d1('NOT_NIGHT'); end if;
  if exists (
    select 1 from private.night_finalizations finalization
    where finalization.room_id = p_room_id
      and finalization.night_number = v_room.day_number
  ) then return private.moderator_witch_checkpoint_payload(p_room_id); end if;

  select * into v_resolution
  from private.night_resolutions resolution
  where resolution.room_id = p_room_id
    and resolution.night_number = v_room.day_number;
  if not found then perform private.raise_ms1d1('WITCH_CHECKPOINT_NOT_READY'); end if;
  select exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id
      and config.role_id = 'witch'
      and config.quantity = 1
  ) into v_witch_configured;

  if v_witch_configured then
    select * into v_call
    from private.night_role_calls call
    where call.room_id = p_room_id
      and call.night_number = v_room.day_number
      and call.role_id = 'witch';
    if not found or v_call.status <> 'COMPLETED' then
      perform private.raise_ms1d1('WITCH_CHECKPOINT_NOT_READY');
    end if;
    select assignment.player_id, player.alive
    into v_witch_player_id, v_witch_alive
    from public.room_role_assignments assignment
    join public.room_players player on player.id = assignment.player_id
    where assignment.room_id = p_room_id and assignment.role_id = 'witch';
    select * into v_resources
    from private.witch_resources resources
    where resources.room_id = p_room_id
    for update;
    select * into v_decision
    from private.witch_decisions decision
    where decision.call_id = v_call.id;
    if v_witch_alive and not found then
      perform private.raise_ms1d1('WITCH_DECISION_REQUIRED');
    end if;
  end if;

  insert into private.night_finalizations (
    resolution_id, room_id, night_number, finalized_by_user_id
  ) values (
    v_resolution.id, p_room_id, v_room.day_number, v_user_id
  ) returning id into v_finalization_id;

  if v_decision.resurrection_target_id is not null then
    select exists (
      select 1 from private.provisional_night_death_candidates candidate
      where candidate.room_id = p_room_id
        and candidate.night_number = v_room.day_number
        and candidate.player_id = v_witch_player_id
    ) into v_attacked;
    if v_attacked then perform private.raise_ms1d1('WITCH_ATTACKED_CANNOT_RESURRECT'); end if;
    if not v_resources.resurrection_available then
      perform private.raise_ms1d1('WITCH_RESURRECTION_UNAVAILABLE');
    end if;
    insert into private.witch_rescues (
      finalization_id, room_id, night_number, witch_player_id,
      target_player_id, source_effect_id
    )
    select v_finalization_id, candidate.room_id, candidate.night_number,
      v_witch_player_id, candidate.player_id, candidate.source_effect_id
    from private.provisional_night_death_candidates candidate
    where candidate.room_id = p_room_id
      and candidate.night_number = v_room.day_number
      and candidate.player_id = v_decision.resurrection_target_id;
    if not found then perform private.raise_ms1d1('WITCH_RESURRECTION_TARGET_INVALID'); end if;
    update private.witch_resources
    set resurrection_available = false,
        updated_at = statement_timestamp()
    where room_id = p_room_id and resurrection_available;
    insert into private.gameplay_events (
      room_id, night_number, event_type, role_id, actor_player_id,
      target_player_id, resolution
    ) values (
      p_room_id, v_room.day_number, 'WITCH_RESURRECTION_USED', 'witch',
      v_witch_player_id, v_decision.resurrection_target_id,
      'CURRENT_NIGHT_RESCUE'
    );
  end if;

  if v_decision.poison_target_id is not null then
    if v_room.day_number < 2 then
      perform private.raise_ms1d1('WITCH_POISON_FORBIDDEN_NIGHT_ONE');
    end if;
    if not v_resources.poison_available then
      perform private.raise_ms1d1('WITCH_POISON_UNAVAILABLE');
    end if;
    if v_decision.poison_target_id = v_witch_player_id then
      perform private.raise_ms1d1('WITCH_POISON_SELF_TARGET');
    end if;
    insert into private.night_effects (
      resolution_id, room_id, night_number, source_call_id, source_type,
      source_role_id, effect_category, target_player_id, lethal,
      protector_blockable, outcome
    ) values (
      v_resolution.id, p_room_id, v_room.day_number, v_call.id,
      'WITCH_POISON', 'witch', 'NON_VILLAIN_LETHAL_EFFECT',
      v_decision.poison_target_id, true, false, 'UNBLOCKED'
    ) returning id into v_poison_effect_id;
    update private.witch_resources
    set poison_available = false,
        updated_at = statement_timestamp()
    where room_id = p_room_id and poison_available;
    insert into private.gameplay_events (
      room_id, night_number, event_type, role_id, actor_player_id,
      target_player_id, resolution, metadata
    ) values (
      p_room_id, v_room.day_number, 'WITCH_POISON_USED', 'witch',
      v_witch_player_id, v_decision.poison_target_id, 'UNBLOCKED',
      jsonb_build_object(
        'effectId', v_poison_effect_id,
        'effectCategory', 'NON_VILLAIN_LETHAL_EFFECT',
        'protectorBlockable', false
      )
    );
  end if;

  update private.night_effects effect
  set activation_status = case
    when v_decision.poison_target_id = effect.condition_player_id
      then 'ACTIVATED'
    when exists (
      select 1 from private.provisional_night_death_candidates candidate
      where candidate.room_id = p_room_id
        and candidate.night_number = v_room.day_number
        and candidate.player_id = effect.condition_player_id
    ) and effect.condition_player_id is distinct from v_decision.resurrection_target_id
      then 'ACTIVATED'
    else 'CANCELED_SOURCE_SURVIVED'
  end
  where effect.resolution_id = v_resolution.id
    and effect.activation_condition = 'SOURCE_PLAYER_FINAL_NIGHT_DEATH';

  for v_effect in
    select effect.*
    from private.night_effects effect
    where effect.resolution_id = v_resolution.id
      and effect.activation_condition is not null
  loop
    insert into private.gameplay_events (
      room_id, night_number, event_type, role_id, actor_player_id,
      target_player_id, resolution, metadata
    ) values (
      p_room_id, v_room.day_number,
      case when v_effect.activation_status = 'ACTIVATED'
        then 'HUNTER_SHOT_ACTIVATED' else 'HUNTER_SHOT_CANCELED' end,
      'hunter', v_effect.condition_player_id, v_effect.target_player_id,
      v_effect.activation_status,
      jsonb_build_object('effectId', v_effect.id)
    );
    if v_effect.activation_status = 'ACTIVATED'
      and v_effect.target_player_id = v_decision.resurrection_target_id then
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, actor_player_id,
        target_player_id, resolution, metadata
      ) values (
        p_room_id, v_room.day_number, 'HUNTER_SHOT_VICTIM_RESCUED',
        'hunter', v_effect.condition_player_id, v_effect.target_player_id,
        'CURRENT_NIGHT_RESCUE', jsonb_build_object('effectId', v_effect.id)
      );
    end if;
  end loop;

  insert into private.night_final_deaths (
    finalization_id, room_id, night_number, player_id, source_effect_id
  )
  select v_finalization_id, candidate.room_id, candidate.night_number,
    candidate.player_id, candidate.source_effect_id
  from private.provisional_night_death_candidates candidate
  join private.night_effects effect on effect.id = candidate.source_effect_id
  where candidate.room_id = p_room_id
    and candidate.night_number = v_room.day_number
    and candidate.player_id is distinct from v_decision.resurrection_target_id
    and (
      effect.activation_condition is null
      or effect.activation_status = 'ACTIVATED'
    );

  insert into private.night_final_deaths (
    finalization_id, room_id, night_number, player_id, source_effect_id
  )
  select v_finalization_id, effect.room_id, effect.night_number,
    effect.target_player_id, effect.id
  from private.night_effects effect
  where effect.resolution_id = v_resolution.id
    and effect.activation_status = 'ACTIVATED'
    and effect.target_player_id is distinct from v_decision.resurrection_target_id
  on conflict do nothing;

  if v_poison_effect_id is not null then
    insert into private.night_final_deaths (
      finalization_id, room_id, night_number, player_id, source_effect_id
    ) values (
      v_finalization_id, p_room_id, v_room.day_number,
      v_decision.poison_target_id, v_poison_effect_id
    );
  end if;

  update public.room_players player
  set alive = false
  where player.room_id = p_room_id
    and exists (
      select 1 from private.night_final_deaths death
      where death.finalization_id = v_finalization_id
        and death.player_id = player.id
    );
  for v_death in
    select death.player_id,
      array_agg(death.source_effect_id order by death.source_effect_id) source_ids
    from private.night_final_deaths death
    where death.finalization_id = v_finalization_id
    group by death.player_id
  loop
    insert into private.gameplay_events (
      room_id, night_number, event_type, role_id, target_player_id,
      resolution, metadata
    ) values (
      p_room_id, v_room.day_number, 'NIGHT_DEATH_FINALIZED',
      case when v_witch_configured then 'witch' else 'werewolf' end,
      v_death.player_id, 'FINAL_NIGHT_DEATH',
      jsonb_build_object('sourceEffectIds', to_jsonb(v_death.source_ids))
    );
  end loop;
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id, resolution, metadata
  ) values (
    p_room_id, v_room.day_number, 'WITCH_CHECKPOINT_COMPLETED',
    case when v_witch_configured then 'witch' else 'werewolf' end,
    'FINALIZED', jsonb_build_object(
      'witchConfigured', v_witch_configured,
      'phaseTransitioned', false
    )
  );
  perform private.touch_gameplay_room(p_room_id);
  return private.moderator_witch_checkpoint_payload(p_room_id);
end;
$$;

create or replace function public.ms1d1_start_morning(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1d1('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1d1('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1d1('NOT_IN_GAME'); end if;

  if v_room.phase = 'DAY' and exists (
    select 1 from private.morning_transitions morning
    where morning.room_id = p_room_id
      and morning.night_number = v_room.day_number
  ) then return public.ms1a_get_moderator_room(p_room_id); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1d1('NOT_NIGHT'); end if;
  if not exists (
    select 1 from private.night_finalizations finalization
    where finalization.room_id = p_room_id
      and finalization.night_number = v_room.day_number
  ) then perform private.raise_ms1d1('MORNING_NOT_READY'); end if;
  if exists (
    select 1
    from public.room_role_config config
    join private.night_role_stages stage on stage.role_id = config.role_id
    where config.room_id = p_room_id
      and config.quantity > 0
      and not exists (
        select 1 from private.night_role_calls call
        where call.room_id = p_room_id
          and call.night_number = v_room.day_number
          and call.role_id = config.role_id
          and call.status = 'COMPLETED'
      )
  ) then perform private.raise_ms1d1('MORNING_NOT_READY'); end if;
  if exists (
    select 1 from private.night_effects effect
    where effect.room_id = p_room_id
      and effect.night_number = v_room.day_number
      and effect.activation_status = 'CONDITIONAL'
  ) then perform private.raise_ms1d1('MORNING_NOT_READY'); end if;

  insert into private.morning_transitions (
    room_id, night_number, transitioned_by_user_id
  ) values (
    p_room_id, v_room.day_number, v_user_id
  ) on conflict (room_id, night_number) do nothing;
  insert into private.gameplay_events (
    room_id, night_number, event_type, resolution, metadata
  ) values (
    p_room_id, v_room.day_number, 'MORNING_STARTED', 'DAY_DISCUSSION',
    jsonb_build_object(
      'finalDeathCount', (
        select count(distinct death.player_id)
        from private.night_final_deaths death
        where death.room_id = p_room_id
          and death.night_number = v_room.day_number
      ),
      'rolesRevealed', false,
      'dayVoteOpened', false
    )
  );
  update public.rooms
  set phase = 'DAY'
  where id = p_room_id;
  perform private.touch_gameplay_room(p_room_id);
  return public.ms1a_get_moderator_room(p_room_id);
end;
$$;

alter table private.hunter_night_intents enable row level security;
alter table private.morning_transitions enable row level security;

revoke all on table private.hunter_night_intents
  from public, anon, authenticated;
revoke all on table private.morning_transitions
  from public, anon, authenticated;

revoke execute on function private.raise_ms1d1(text)
  from public, anon, authenticated;
revoke execute on function private.moderator_night_action_payload(uuid)
  from public, anon, authenticated;
revoke execute on function private.player_night_action_payload(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function private.moderator_night_resolution_payload(uuid)
  from public, anon, authenticated;
revoke execute on function private.moderator_witch_checkpoint_payload(uuid)
  from public, anon, authenticated;

revoke execute on function public.ms1d1_open_hunter_call(uuid)
  from public, anon;
grant execute on function public.ms1d1_open_hunter_call(uuid)
  to authenticated;
revoke execute on function public.ms1d1_submit_hunter_prelock(uuid, uuid)
  from public, anon;
grant execute on function public.ms1d1_submit_hunter_prelock(uuid, uuid)
  to authenticated;
revoke execute on function public.ms1d1_confirm_hunter_prelock(uuid)
  from public, anon;
grant execute on function public.ms1d1_confirm_hunter_prelock(uuid)
  to authenticated;
revoke execute on function public.ms1b2_resolve_night_effects(uuid)
  from public, anon;
grant execute on function public.ms1b2_resolve_night_effects(uuid)
  to authenticated;
revoke execute on function public.ms1c_finalize_night_checkpoint(uuid)
  from public, anon;
grant execute on function public.ms1c_finalize_night_checkpoint(uuid)
  to authenticated;
revoke execute on function public.ms1d1_start_morning(uuid)
  from public, anon;
grant execute on function public.ms1d1_start_morning(uuid)
  to authenticated;

commit;
