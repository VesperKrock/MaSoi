begin;

create table private.night_role_stages (
  role_id text primary key references public.classic_roles(id),
  stage text not null check (stage in ('PRE_WITCH', 'FINAL_CHECKPOINT')),
  stage_order smallint not null check (stage_order > 0),
  unique (stage_order)
);

insert into private.night_role_stages (role_id, stage, stage_order) values
  ('werewolf', 'PRE_WITCH', 10),
  ('seer', 'PRE_WITCH', 20),
  ('protector', 'PRE_WITCH', 30),
  ('witch', 'FINAL_CHECKPOINT', 40);

alter table private.night_role_calls
  drop constraint if exists night_role_calls_role_id_check;
alter table private.night_role_calls
  add constraint night_role_calls_role_id_check
  check (role_id in ('werewolf', 'seer', 'protector', 'witch'));

create table private.witch_resources (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  witch_player_id uuid not null,
  resurrection_available boolean not null default true,
  poison_available boolean not null default true,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  foreign key (room_id, witch_player_id)
    references public.room_players(room_id, id)
);

create table private.witch_decisions (
  call_id uuid primary key references private.night_role_calls(id) on delete cascade,
  resolution_id uuid not null references private.night_resolutions(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number integer not null check (night_number >= 1),
  witch_player_id uuid not null,
  resurrection_target_id uuid,
  poison_target_id uuid,
  submitted_at timestamptz not null default statement_timestamp(),
  unique (room_id, night_number),
  foreign key (room_id, witch_player_id)
    references public.room_players(room_id, id),
  foreign key (room_id, resurrection_target_id)
    references public.room_players(room_id, id),
  foreign key (room_id, poison_target_id)
    references public.room_players(room_id, id),
  check (poison_target_id is null or poison_target_id <> witch_player_id)
);

create table private.night_finalizations (
  id uuid primary key default gen_random_uuid(),
  resolution_id uuid not null unique references private.night_resolutions(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number integer not null check (night_number >= 1),
  finalized_by_user_id uuid not null references auth.users(id),
  finalized_at timestamptz not null default statement_timestamp(),
  unique (room_id, night_number),
  unique (id, room_id, night_number)
);

create table private.witch_rescues (
  finalization_id uuid not null,
  room_id uuid not null,
  night_number integer not null,
  witch_player_id uuid not null,
  target_player_id uuid not null,
  source_effect_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (finalization_id, target_player_id, source_effect_id),
  foreign key (finalization_id, room_id, night_number)
    references private.night_finalizations(id, room_id, night_number) on delete cascade,
  foreign key (room_id, witch_player_id)
    references public.room_players(room_id, id),
  foreign key (source_effect_id, room_id, night_number, target_player_id)
    references private.night_effects(id, room_id, night_number, target_player_id)
);

create table private.night_final_deaths (
  finalization_id uuid not null,
  room_id uuid not null,
  night_number integer not null,
  player_id uuid not null,
  source_effect_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (finalization_id, player_id, source_effect_id),
  foreign key (finalization_id, room_id, night_number)
    references private.night_finalizations(id, room_id, night_number) on delete cascade,
  foreign key (source_effect_id, room_id, night_number, player_id)
    references private.night_effects(id, room_id, night_number, target_player_id)
);

create index witch_decisions_room_night_idx
  on private.witch_decisions(room_id, night_number);
create index witch_rescues_room_night_idx
  on private.witch_rescues(room_id, night_number);
create index night_final_deaths_room_night_idx
  on private.night_final_deaths(room_id, night_number);

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
    'WITCH_DECISION_SUBMITTED',
    'WITCH_RESURRECTION_USED',
    'WITCH_POISON_USED',
    'WITCH_CHECKPOINT_COMPLETED',
    'NIGHT_DEATH_FINALIZED'
  ));

create or replace function private.raise_ms1c(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end;
$$;

create or replace function private.enforce_night_role_stage()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_stage text;
begin
  if new.status <> 'ACTIVE' or (tg_op = 'UPDATE' and old.status = 'ACTIVE') then
    return new;
  end if;

  select stage.stage into v_stage
  from private.night_role_stages stage
  where stage.role_id = new.role_id;
  if v_stage is null then
    perform private.raise_ms1c('ROLE_NOT_CONFIGURED');
  end if;

  if v_stage = 'PRE_WITCH' then
    if exists (
      select 1 from private.night_role_calls call
      where call.room_id = new.room_id
        and call.night_number = new.night_number
        and call.role_id = 'witch'
        and call.status in ('ACTIVE', 'COMPLETED')
    ) or exists (
      select 1 from private.night_finalizations finalization
      where finalization.room_id = new.room_id
        and finalization.night_number = new.night_number
    ) then
      perform private.raise_ms1c('WITCH_CHECKPOINT_ALREADY_OPEN');
    end if;
  else
    if exists (
      select 1
      from public.room_role_config config
      join private.night_role_stages stage
        on stage.role_id = config.role_id and stage.stage = 'PRE_WITCH'
      where config.room_id = new.room_id
        and config.quantity > 0
        and not exists (
          select 1 from private.night_role_calls call
          where call.room_id = new.room_id
            and call.night_number = new.night_number
            and call.role_id = config.role_id
            and call.status = 'COMPLETED'
        )
    ) then
      perform private.raise_ms1c('WITCH_CHECKPOINT_NOT_READY');
    end if;
    if not exists (
      select 1 from private.night_resolutions resolution
      where resolution.room_id = new.room_id
        and resolution.night_number = new.night_number
    ) then
      perform private.raise_ms1c('WITCH_CHECKPOINT_NOT_READY');
    end if;
  end if;
  return new;
end;
$$;

create trigger night_role_calls_enforce_stage
before insert or update of status on private.night_role_calls
for each row execute function private.enforce_night_role_stage();

create or replace function private.witch_player_action_payload(
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
  v_call private.night_role_calls%rowtype;
  v_resources private.witch_resources%rowtype;
  v_attacked boolean := false;
  v_resurrection_candidates jsonb := '[]'::jsonb;
  v_poison_candidates jsonb := '[]'::jsonb;
  v_resurrection_available boolean := false;
  v_poison_available boolean := false;
begin
  select * into v_room from public.rooms room where room.id = p_room_id;
  select player.* into v_player
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  where membership.room_id = p_room_id and membership.user_id = p_user_id;
  if not found or not v_player.alive then return null; end if;

  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = 'witch'
    and call.status = 'ACTIVE';
  if not found or not (v_player.id = any(v_call.eligible_actor_ids)) then
    return null;
  end if;
  if exists (select 1 from private.witch_decisions decision where decision.call_id = v_call.id) then
    return null;
  end if;

  select * into v_resources
  from private.witch_resources resources
  where resources.room_id = p_room_id;
  select exists (
    select 1 from private.provisional_night_death_candidates candidate
    where candidate.room_id = p_room_id
      and candidate.night_number = v_room.day_number
      and candidate.player_id = v_player.id
  ) into v_attacked;
  v_resurrection_available := v_resources.resurrection_available and not v_attacked;
  v_poison_available := v_resources.poison_available and v_room.day_number >= 2;

  if v_resurrection_available then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', player.id,
      'seat', player.seat_number,
      'displayName', player.display_name,
      'alive', true
    ) order by player.seat_number), '[]'::jsonb)
    into v_resurrection_candidates
    from (
      select distinct candidate.player_id
      from private.provisional_night_death_candidates candidate
      where candidate.room_id = p_room_id
        and candidate.night_number = v_room.day_number
    ) candidate
    join public.room_players player on player.id = candidate.player_id;
  end if;

  if v_poison_available then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', player.id,
      'seat', player.seat_number,
      'displayName', player.display_name,
      'alive', true
    ) order by player.seat_number), '[]'::jsonb)
    into v_poison_candidates
    from public.room_players player
    where player.room_id = p_room_id
      and player.alive
      and player.id <> v_player.id;
  end if;

  return jsonb_build_object(
    'id', v_call.id,
    'kind', 'WITCH_DECISION',
    'roleId', 'witch',
    'roleName', 'Phù Thủy',
    'instructions', 'Chọn tối đa một người để cứu và một người để dùng độc.',
    'mode', 'WITCH_DECISION',
    'candidates', '[]'::jsonb,
    'hasSelected', false,
    'resurrectionCandidates', v_resurrection_candidates,
    'poisonCandidates', v_poison_candidates,
    'resurrectionAvailable', v_resurrection_available,
    'poisonAvailable', v_poison_available,
    'witchAttackedThisNight', v_attacked
  );
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
    select death.player_id, jsonb_agg(death.source_effect_id order by death.source_effect_id) source_effect_ids
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
    'resourcesAfter', case when v_resources.room_id is null then null else jsonb_build_object(
      'witchPlayerId', v_resources.witch_player_id,
      'resurrectionAvailable', v_resources.resurrection_available,
      'poisonAvailable', v_resources.poison_available
    ) end
  );
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
  if not found or v_room.phase <> 'NIGHT' then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'roleId', config.role_id,
    'status', case when call.status = 'ACTIVE' then 'CALLED'
      when call.status = 'COMPLETED' then 'COMPLETED' else 'NOT_CALLED' end,
    'calledAt', call.called_at,
    'completedAt', call.completed_at
  ) order by stage.stage_order), '[]'::jsonb)
  into v_calls
  from public.room_role_config config
  join private.night_role_stages stage on stage.role_id = config.role_id
  left join private.night_role_calls call
    on call.room_id = config.room_id
    and call.night_number = v_room.day_number
    and call.role_id = config.role_id
  where config.room_id = p_room_id and config.quantity > 0;

  select coalesce(jsonb_object_agg(
    call.role_id,
    case when call.role_id = 'witch' then jsonb_build_object(
      'id', call.id,
      'roleId', 'witch',
      'kind', 'WITCH_DECISION',
      'status', case when call.status = 'ACTIVE' then 'OPEN' else 'COMPLETED' end,
      'eligibleActorIds', to_jsonb(call.eligible_actor_ids),
      'eligibleTargetIds', to_jsonb(call.eligible_target_ids),
      'selections', '{}'::jsonb,
      'confirmedActorIds', case when decision.call_id is null then '[]'::jsonb
        else to_jsonb(call.eligible_actor_ids) end,
      'openedAt', call.called_at,
      'completedAt', call.completed_at
    ) else private.moderator_night_action_payload(call.id) end
  ) filter (where cardinality(call.eligible_actor_ids) > 0), '{}'::jsonb),
  max(call.role_id) filter (where call.status = 'ACTIVE')
  into v_actions, v_active_role
  from private.night_role_calls call
  left join private.witch_decisions decision on decision.call_id = call.id
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

create or replace function public.ms1c_open_witch_call(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_call private.night_role_calls%rowtype;
  v_witch_player_id uuid;
  v_actor_ids uuid[] := '{}'::uuid[];
  v_target_ids uuid[] := '{}'::uuid[];
begin
  select * into v_room from public.rooms room where room.id = p_room_id for update;
  if not found then perform private.raise_ms1c('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1c('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1c('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1c('NOT_NIGHT'); end if;
  if not exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id and config.role_id = 'witch' and config.quantity = 1
  ) then perform private.raise_ms1c('ROLE_NOT_CONFIGURED'); end if;
  if exists (
    select 1 from private.night_role_calls call
    where call.room_id = p_room_id and call.status = 'ACTIVE'
  ) then perform private.raise_ms1c('CALL_ALREADY_ACTIVE'); end if;

  insert into private.night_role_calls (room_id, night_number, role_id)
  values (p_room_id, v_room.day_number, 'witch')
  on conflict (room_id, night_number, role_id) do nothing;
  select * into v_call from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = 'witch'
  for update;
  if v_call.status = 'COMPLETED' then perform private.raise_ms1c('CALL_ALREADY_COMPLETED'); end if;

  select assignment.player_id into v_witch_player_id
  from public.room_role_assignments assignment
  where assignment.room_id = p_room_id and assignment.role_id = 'witch';
  insert into private.witch_resources (room_id, witch_player_id)
  values (p_room_id, v_witch_player_id)
  on conflict (room_id) do nothing;

  if exists (
    select 1 from public.room_players player
    where player.id = v_witch_player_id and player.alive
  ) then
    v_actor_ids := array[v_witch_player_id];
    select coalesce(array_agg(distinct candidate_id), '{}'::uuid[])
    into v_target_ids
    from (
      select candidate.player_id candidate_id
      from private.provisional_night_death_candidates candidate
      join private.witch_resources resources on resources.room_id = candidate.room_id
      where candidate.room_id = p_room_id
        and candidate.night_number = v_room.day_number
        and resources.resurrection_available
        and not exists (
          select 1 from private.provisional_night_death_candidates attacked
          where attacked.room_id = p_room_id
            and attacked.night_number = v_room.day_number
            and attacked.player_id = v_witch_player_id
        )
      union
      select player.id
      from public.room_players player
      join private.witch_resources resources on resources.room_id = player.room_id
      where player.room_id = p_room_id
        and player.alive
        and player.id <> v_witch_player_id
        and resources.poison_available
        and v_room.day_number >= 2
    ) targets(candidate_id);
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
    p_room_id, v_room.day_number, 'ROLE_CALLED', 'witch',
    jsonb_build_object('eligibleActorCount', cardinality(v_actor_ids))
  );
  perform private.touch_gameplay_room(p_room_id);
  return private.moderator_night_payload(p_room_id);
end;
$$;

create or replace function public.ms1c_submit_witch_decision(
  p_room_id uuid,
  p_resurrection_target_id uuid default null,
  p_poison_target_id uuid default null
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
  v_resources private.witch_resources%rowtype;
  v_resolution_id uuid;
  v_attacked boolean;
begin
  select * into v_room from public.rooms room where room.id = p_room_id for update;
  if not found then perform private.raise_ms1c('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1c('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1c('NOT_NIGHT'); end if;
  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  join public.room_role_assignments assignment
    on assignment.room_id = player.room_id and assignment.player_id = player.id
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id
    and player.alive
    and assignment.role_id = 'witch';
  if v_player_id is null then perform private.raise_ms1c('WRONG_ROLE'); end if;
  select * into v_call from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = 'witch'
    and call.status = 'ACTIVE'
  for update;
  if not found then perform private.raise_ms1c('CALL_NOT_ACTIVE'); end if;
  if not (v_player_id = any(v_call.eligible_actor_ids)) then
    perform private.raise_ms1c('WRONG_ROLE');
  end if;
  if exists (select 1 from private.witch_decisions decision where decision.call_id = v_call.id) then
    perform private.raise_ms1c('CALL_ALREADY_COMPLETED');
  end if;
  select * into v_resources from private.witch_resources resources
  where resources.room_id = p_room_id for update;
  select resolution.id into v_resolution_id
  from private.night_resolutions resolution
  where resolution.room_id = p_room_id and resolution.night_number = v_room.day_number;
  if v_resolution_id is null then perform private.raise_ms1c('WITCH_CHECKPOINT_NOT_READY'); end if;
  select exists (
    select 1 from private.provisional_night_death_candidates candidate
    where candidate.room_id = p_room_id
      and candidate.night_number = v_room.day_number
      and candidate.player_id = v_player_id
  ) into v_attacked;

  if p_resurrection_target_id is not null then
    if not v_resources.resurrection_available then
      perform private.raise_ms1c('WITCH_RESURRECTION_UNAVAILABLE');
    end if;
    if v_attacked then perform private.raise_ms1c('WITCH_ATTACKED_CANNOT_RESURRECT'); end if;
    if not exists (
      select 1 from private.provisional_night_death_candidates candidate
      where candidate.room_id = p_room_id
        and candidate.night_number = v_room.day_number
        and candidate.player_id = p_resurrection_target_id
    ) then perform private.raise_ms1c('WITCH_RESURRECTION_TARGET_INVALID'); end if;
  end if;

  if p_poison_target_id is not null then
    if not v_resources.poison_available then perform private.raise_ms1c('WITCH_POISON_UNAVAILABLE'); end if;
    if v_room.day_number < 2 then perform private.raise_ms1c('WITCH_POISON_FORBIDDEN_NIGHT_ONE'); end if;
    if p_poison_target_id = v_player_id then perform private.raise_ms1c('WITCH_POISON_SELF_TARGET'); end if;
    if not exists (
      select 1 from public.room_players player
      where player.room_id = p_room_id and player.id = p_poison_target_id and player.alive
    ) then perform private.raise_ms1c('INVALID_TARGET'); end if;
  end if;

  insert into private.witch_decisions (
    call_id, resolution_id, room_id, night_number, witch_player_id,
    resurrection_target_id, poison_target_id
  ) values (
    v_call.id, v_resolution_id, p_room_id, v_room.day_number, v_player_id,
    p_resurrection_target_id, p_poison_target_id
  );
  update private.night_role_calls
  set status = 'COMPLETED', completed_at = statement_timestamp()
  where id = v_call.id;
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id, actor_player_id, metadata
  ) values (
    p_room_id, v_room.day_number, 'WITCH_DECISION_SUBMITTED', 'witch', v_player_id,
    jsonb_build_object(
      'usesResurrection', p_resurrection_target_id is not null,
      'usesPoison', p_poison_target_id is not null
    )
  );
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id, actor_player_id, metadata
  ) values (
    p_room_id, v_room.day_number, 'CALL_COMPLETED', 'witch', v_player_id,
    jsonb_build_object('combinedDecision', true)
  );
  perform private.touch_gameplay_room(p_room_id);
  return private.witch_player_action_payload(p_room_id, v_user_id);
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
begin
  select * into v_room from public.rooms room where room.id = p_room_id for update;
  if not found then perform private.raise_ms1c('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1c('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1c('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1c('NOT_NIGHT'); end if;
  if exists (
    select 1 from private.night_finalizations finalization
    where finalization.room_id = p_room_id and finalization.night_number = v_room.day_number
  ) then return private.moderator_witch_checkpoint_payload(p_room_id); end if;

  select * into v_resolution from private.night_resolutions resolution
  where resolution.room_id = p_room_id and resolution.night_number = v_room.day_number;
  if not found then perform private.raise_ms1c('WITCH_CHECKPOINT_NOT_READY'); end if;
  select exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id and config.role_id = 'witch' and config.quantity = 1
  ) into v_witch_configured;

  if v_witch_configured then
    select * into v_call from private.night_role_calls call
    where call.room_id = p_room_id
      and call.night_number = v_room.day_number
      and call.role_id = 'witch';
    if not found or v_call.status <> 'COMPLETED' then
      perform private.raise_ms1c('WITCH_CHECKPOINT_NOT_READY');
    end if;
    select assignment.player_id, player.alive
    into v_witch_player_id, v_witch_alive
    from public.room_role_assignments assignment
    join public.room_players player on player.id = assignment.player_id
    where assignment.room_id = p_room_id and assignment.role_id = 'witch';
    select * into v_resources from private.witch_resources resources
    where resources.room_id = p_room_id for update;
    select * into v_decision from private.witch_decisions decision
    where decision.call_id = v_call.id;
    if v_witch_alive and not found then
      perform private.raise_ms1c('WITCH_DECISION_REQUIRED');
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
    if v_attacked then perform private.raise_ms1c('WITCH_ATTACKED_CANNOT_RESURRECT'); end if;
    if not v_resources.resurrection_available then
      perform private.raise_ms1c('WITCH_RESURRECTION_UNAVAILABLE');
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
    if not found then perform private.raise_ms1c('WITCH_RESURRECTION_TARGET_INVALID'); end if;
    update private.witch_resources
    set resurrection_available = false, updated_at = statement_timestamp()
    where room_id = p_room_id and resurrection_available;
    insert into private.gameplay_events (
      room_id, night_number, event_type, role_id, actor_player_id,
      target_player_id, resolution
    ) values (
      p_room_id, v_room.day_number, 'WITCH_RESURRECTION_USED', 'witch',
      v_witch_player_id, v_decision.resurrection_target_id, 'CURRENT_NIGHT_RESCUE'
    );
  end if;

  if v_decision.poison_target_id is not null then
    if v_room.day_number < 2 then perform private.raise_ms1c('WITCH_POISON_FORBIDDEN_NIGHT_ONE'); end if;
    if not v_resources.poison_available then perform private.raise_ms1c('WITCH_POISON_UNAVAILABLE'); end if;
    if v_decision.poison_target_id = v_witch_player_id then
      perform private.raise_ms1c('WITCH_POISON_SELF_TARGET');
    end if;
    insert into private.night_effects (
      resolution_id, room_id, night_number, source_call_id, source_type,
      source_role_id, effect_category, target_player_id, lethal,
      protector_blockable, outcome
    ) values (
      v_resolution.id, p_room_id, v_room.day_number, v_call.id, 'WITCH_POISON',
      'witch', 'NON_VILLAIN_LETHAL_EFFECT', v_decision.poison_target_id, true,
      false, 'UNBLOCKED'
    ) returning id into v_poison_effect_id;
    update private.witch_resources
    set poison_available = false, updated_at = statement_timestamp()
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

  insert into private.night_final_deaths (
    finalization_id, room_id, night_number, player_id, source_effect_id
  )
  select v_finalization_id, candidate.room_id, candidate.night_number,
    candidate.player_id, candidate.source_effect_id
  from private.provisional_night_death_candidates candidate
  where candidate.room_id = p_room_id
    and candidate.night_number = v_room.day_number
    and candidate.player_id is distinct from v_decision.resurrection_target_id;
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
    select death.player_id, array_agg(death.source_effect_id order by death.source_effect_id) source_ids
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
    'witchCheckpoint', private.moderator_witch_checkpoint_payload(p_room_id)
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
  where call.room_id = p_room_id and call.status = 'ACTIVE';
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
      else private.player_night_action_payload(p_room_id, v_user_id) end
  );
end;
$$;

alter table private.night_role_stages enable row level security;
alter table private.witch_resources enable row level security;
alter table private.witch_decisions enable row level security;
alter table private.night_finalizations enable row level security;
alter table private.witch_rescues enable row level security;
alter table private.night_final_deaths enable row level security;

revoke all on table private.night_role_stages from public, anon, authenticated;
revoke all on table private.witch_resources from public, anon, authenticated;
revoke all on table private.witch_decisions from public, anon, authenticated;
revoke all on table private.night_finalizations from public, anon, authenticated;
revoke all on table private.witch_rescues from public, anon, authenticated;
revoke all on table private.night_final_deaths from public, anon, authenticated;

revoke execute on function private.raise_ms1c(text) from public, anon, authenticated;
revoke execute on function private.enforce_night_role_stage() from public, anon, authenticated;
revoke execute on function private.witch_player_action_payload(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function private.moderator_witch_checkpoint_payload(uuid)
  from public, anon, authenticated;

revoke execute on function public.ms1c_open_witch_call(uuid) from public, anon;
grant execute on function public.ms1c_open_witch_call(uuid) to authenticated;
revoke execute on function public.ms1c_submit_witch_decision(uuid, uuid, uuid)
  from public, anon;
grant execute on function public.ms1c_submit_witch_decision(uuid, uuid, uuid)
  to authenticated;
revoke execute on function public.ms1c_finalize_night_checkpoint(uuid)
  from public, anon;
grant execute on function public.ms1c_finalize_night_checkpoint(uuid)
  to authenticated;
revoke execute on function public.ms1a_get_moderator_room(uuid) from public, anon;
grant execute on function public.ms1a_get_moderator_room(uuid) to authenticated;
revoke execute on function public.ms1a_get_player_room(uuid) from public, anon;
grant execute on function public.ms1a_get_player_room(uuid) to authenticated;

commit;
