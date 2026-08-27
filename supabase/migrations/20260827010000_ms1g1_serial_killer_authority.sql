begin;

alter table private.night_role_calls
  drop constraint if exists night_role_calls_role_id_check;
alter table private.night_role_calls
  add constraint night_role_calls_role_id_check
  check (role_id in (
    'werewolf', 'seer', 'protector', 'serial-killer', 'hunter', 'cupid', 'witch'
  ));

insert into private.night_role_stages (role_id, stage, stage_order)
values ('serial-killer', 'PRE_WITCH', 35)
on conflict (role_id) do update
set stage = excluded.stage,
    stage_order = excluded.stage_order;

create table private.serial_killer_intents (
  call_id uuid primary key references private.night_role_calls(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number integer not null check (night_number >= 1),
  serial_killer_player_id uuid not null,
  target_player_id uuid,
  confirmed boolean not null default false,
  selected_at timestamptz not null default statement_timestamp(),
  confirmed_at timestamptz,
  unique (room_id, night_number),
  foreign key (room_id, serial_killer_player_id)
    references public.room_players(room_id, id) on delete cascade,
  foreign key (room_id, target_player_id)
    references public.room_players(room_id, id),
  check (
    (not confirmed and confirmed_at is null)
    or (confirmed and confirmed_at is not null)
  )
);

alter table private.night_resolutions
  drop constraint if exists night_resolutions_outcome_check;
alter table private.night_resolutions
  add constraint night_resolutions_outcome_check check (
    outcome in ('NO_ATTACK', 'BLOCKED', 'UNBLOCKED', 'BITE_SCHEDULED', 'IMMUNE')
  );

alter table private.night_effects
  add column immunity_kind text,
  add column immunity_role_id text references public.classic_roles(id);
alter table private.night_effects
  drop constraint if exists night_effects_outcome_check;
alter table private.night_effects
  drop constraint if exists night_effects_block_outcome_check;
alter table private.night_effects
  add constraint night_effects_outcome_check check (
    outcome in (
      'BLOCKED_BY_PROTECTOR',
      'UNBLOCKED',
      'HALF_WOLF_BITE_SCHEDULED',
      'IMMUNE_TO_WOLF_ATTACK'
    )
  );
alter table private.night_effects
  add constraint night_effects_block_outcome_check check (
    (
      outcome = 'BLOCKED_BY_PROTECTOR'
      and protector_blockable
      and block_source_type = 'PROTECTOR_SHIELD'
      and block_source_role_id = 'protector'
      and conversion_kind is null
      and conversion_due_night_number is null
      and immunity_kind is null
      and immunity_role_id is null
    )
    or (
      outcome = 'UNBLOCKED'
      and block_source_type is null
      and block_source_role_id is null
      and conversion_kind is null
      and conversion_due_night_number is null
      and immunity_kind is null
      and immunity_role_id is null
    )
    or (
      outcome = 'HALF_WOLF_BITE_SCHEDULED'
      and source_type = 'WOLF_ATTACK'
      and not lethal
      and protector_blockable
      and block_source_type is null
      and block_source_role_id is null
      and conversion_kind = 'HALF_WOLF_TRANSFORMATION'
      and conversion_due_night_number = night_number + 1
      and immunity_kind is null
      and immunity_role_id is null
    )
    or (
      outcome = 'IMMUNE_TO_WOLF_ATTACK'
      and source_type = 'WOLF_ATTACK'
      and source_role_id = 'werewolf'
      and not lethal
      and protector_blockable
      and block_source_type is null
      and block_source_role_id is null
      and conversion_kind is null
      and conversion_due_night_number is null
      and immunity_kind = 'WOLF_ATTACK_IMMUNITY'
      and immunity_role_id = 'serial-killer'
    )
  );
alter table private.night_effects
  add constraint night_effects_serial_killer_source_check check (
    source_type <> 'SERIAL_KILLER_ATTACK'
    or (
      source_role_id = 'serial-killer'
      and source_player_id is not null
      and effect_category = 'HOSTILE_VILLAIN_ATTACK'
      and lethal
      and protector_blockable
      and conversion_kind is null
      and immunity_kind is null
    )
  );

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
    'WOLF_ATTACK_IMMUNE',
    'SERIAL_KILLER_TARGET_LOCKED',
    'SERIAL_KILLER_ATTACK_CREATED',
    'SERIAL_KILLER_ATTACK_BLOCKED',
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
    'NEXT_NIGHT_STARTED',
    'HALF_WOLF_BITE_SCHEDULED',
    'HALF_WOLF_TRANSFORMED',
    'HALF_WOLF_TRANSFORMATION_CANCELED',
    'TRAITOR_CONVERTED_TO_VILLAGE',
    'CUPID_PAIR_CREATED',
    'LOVER_REVEAL_ACKNOWLEDGED',
    'LOVER_HEARTBREAK_CREATED',
    'CUPID_OBJECTIVE_FALLBACK'
  ));

create or replace function private.raise_ms1g1(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end;
$$;

create or replace function public.ms1g1_open_serial_killer_call(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_call private.night_role_calls%rowtype;
  v_actor_id uuid;
  v_actor_ids uuid[] := '{}'::uuid[];
  v_target_ids uuid[] := '{}'::uuid[];
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1g1('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1g1('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1g1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1g1('NOT_NIGHT'); end if;
  if not exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id
      and config.role_id = 'serial-killer'
      and config.quantity = 1
  ) then perform private.raise_ms1g1('ROLE_NOT_CONFIGURED'); end if;
  if exists (
    select 1 from private.night_role_calls call
    where call.room_id = p_room_id and call.status = 'ACTIVE'
  ) then perform private.raise_ms1g1('CALL_ALREADY_ACTIVE'); end if;

  insert into private.night_role_calls (room_id, night_number, role_id)
  values (p_room_id, v_room.day_number, 'serial-killer')
  on conflict (room_id, night_number, role_id) do nothing;
  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = 'serial-killer'
  for update;
  if v_call.status = 'COMPLETED' then
    perform private.raise_ms1g1('CALL_ALREADY_COMPLETED');
  end if;

  select assignment.player_id into v_actor_id
  from public.room_role_assignments assignment
  where assignment.room_id = p_room_id
    and assignment.role_id = 'serial-killer';
  if exists (
    select 1 from public.room_players player
    where player.room_id = p_room_id
      and player.id = v_actor_id
      and player.alive
  ) then
    v_actor_ids := array[v_actor_id];
    select coalesce(array_agg(player.id order by player.seat_number), '{}'::uuid[])
    into v_target_ids
    from public.room_players player
    where player.room_id = p_room_id
      and player.alive
      and player.id <> v_actor_id;
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
    p_room_id, v_room.day_number, 'ROLE_CALLED', 'serial-killer',
    jsonb_build_object('eligibleActorCount', cardinality(v_actor_ids))
  );
  perform private.touch_gameplay_room(p_room_id);
  return private.moderator_night_payload(p_room_id);
end;
$$;

create or replace function public.ms1g1_submit_serial_killer_intent(
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
  if not found then perform private.raise_ms1g1('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1g1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1g1('NOT_NIGHT'); end if;

  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  join public.room_role_assignments assignment
    on assignment.room_id = player.room_id and assignment.player_id = player.id
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id
    and player.alive
    and assignment.role_id = 'serial-killer';
  if v_player_id is null then perform private.raise_ms1g1('WRONG_ROLE'); end if;

  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = 'serial-killer'
    and call.status = 'ACTIVE'
  for update;
  if not found then perform private.raise_ms1g1('CALL_NOT_ACTIVE'); end if;
  if not (v_player_id = any(v_call.eligible_actor_ids)) then
    perform private.raise_ms1g1('WRONG_ROLE');
  end if;
  if p_target_player_id is not null
    and not (p_target_player_id = any(v_call.eligible_target_ids)) then
    perform private.raise_ms1g1('INVALID_TARGET');
  end if;

  select intent.confirmed into v_confirmed
  from private.serial_killer_intents intent
  where intent.call_id = v_call.id;
  if coalesce(v_confirmed, false) then
    perform private.raise_ms1g1('SERIAL_KILLER_SELECTION_ALREADY_CONFIRMED');
  end if;

  insert into private.serial_killer_intents (
    call_id, room_id, night_number, serial_killer_player_id, target_player_id
  ) values (
    v_call.id, p_room_id, v_room.day_number, v_player_id, p_target_player_id
  )
  on conflict (call_id) do update
  set target_player_id = excluded.target_player_id,
      selected_at = statement_timestamp()
  where not private.serial_killer_intents.confirmed;
  perform private.touch_gameplay_room(p_room_id);
  return private.player_night_action_payload(p_room_id, v_user_id);
end;
$$;

create or replace function public.ms1g1_confirm_serial_killer_intent(
  p_room_id uuid
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
  v_intent private.serial_killer_intents%rowtype;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1g1('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1g1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1g1('NOT_NIGHT'); end if;

  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  join public.room_role_assignments assignment
    on assignment.room_id = player.room_id and assignment.player_id = player.id
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id
    and player.alive
    and assignment.role_id = 'serial-killer';
  if v_player_id is null then perform private.raise_ms1g1('WRONG_ROLE'); end if;

  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = 'serial-killer'
  for update;
  if not found then perform private.raise_ms1g1('CALL_NOT_ACTIVE'); end if;

  select * into v_intent
  from private.serial_killer_intents intent
  where intent.call_id = v_call.id
    and intent.serial_killer_player_id = v_player_id
  for update;
  if v_call.status = 'COMPLETED' and found and v_intent.confirmed then
    return null;
  end if;
  if v_call.status <> 'ACTIVE' then perform private.raise_ms1g1('CALL_NOT_ACTIVE'); end if;
  if not (v_player_id = any(v_call.eligible_actor_ids)) then
    perform private.raise_ms1g1('WRONG_ROLE');
  end if;
  if not found then
    perform private.raise_ms1g1('SERIAL_KILLER_SELECTION_REQUIRED');
  end if;

  update private.serial_killer_intents
  set confirmed = true,
      confirmed_at = statement_timestamp()
  where call_id = v_call.id and not confirmed;
  update private.night_role_calls
  set status = 'COMPLETED', completed_at = statement_timestamp()
  where id = v_call.id;
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id, actor_player_id,
    target_player_id, resolution, metadata
  ) values (
    p_room_id, v_room.day_number, 'SERIAL_KILLER_TARGET_LOCKED',
    'serial-killer', v_player_id, v_intent.target_player_id,
    case when v_intent.target_player_id is null then 'NOBODY' else 'TARGET_LOCKED' end,
    jsonb_build_object('intentOnly', true, 'private', true)
  );
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id, actor_player_id, metadata
  ) values (
    p_room_id, v_room.day_number, 'CALL_COMPLETED', 'serial-killer', v_player_id,
    jsonb_build_object('intentConfirmed', true)
  );
  perform private.touch_gameplay_room(p_room_id);
  return null;
end;
$$;

create or replace function private.ms1g1_moderator_serial_killer_action_payload(
  p_call_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_call private.night_role_calls%rowtype;
  v_intent private.serial_killer_intents%rowtype;
begin
  select * into v_call
  from private.night_role_calls call
  where call.id = p_call_id;
  if not found or cardinality(v_call.eligible_actor_ids) = 0 then return null; end if;
  select * into v_intent
  from private.serial_killer_intents intent
  where intent.call_id = v_call.id;
  return jsonb_build_object(
    'id', v_call.id,
    'roleId', 'serial-killer',
    'kind', 'SERIAL_KILLER_ATTACK',
    'status', case when v_call.status = 'ACTIVE' then 'OPEN' else 'COMPLETED' end,
    'eligibleActorIds', to_jsonb(v_call.eligible_actor_ids),
    'eligibleTargetIds', to_jsonb(v_call.eligible_target_ids),
    'selections', case when v_intent.call_id is null then '{}'::jsonb
      else jsonb_build_object(
        v_intent.serial_killer_player_id::text,
        to_jsonb(v_intent.target_player_id)
      ) end,
    'confirmedActorIds', case when coalesce(v_intent.confirmed, false)
      then jsonb_build_array(v_intent.serial_killer_player_id)
      else '[]'::jsonb end,
    'openedAt', v_call.called_at,
    'completedAt', v_call.completed_at
  );
end;
$$;

create or replace function private.ms1g1_serial_killer_player_action_payload(
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
  v_intent private.serial_killer_intents%rowtype;
  v_candidates jsonb;
begin
  select player.* into v_player
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  join public.room_role_assignments assignment
    on assignment.room_id = player.room_id and assignment.player_id = player.id
  where membership.room_id = p_room_id
    and membership.user_id = p_user_id
    and player.alive
    and assignment.role_id = 'serial-killer';
  if not found then return null; end if;

  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.role_id = 'serial-killer'
    and call.status = 'ACTIVE';
  if not found or not (v_player.id = any(v_call.eligible_actor_ids)) then
    return null;
  end if;

  select * into v_intent
  from private.serial_killer_intents intent
  where intent.call_id = v_call.id
    and intent.serial_killer_player_id = v_player.id;
  if found and v_intent.confirmed then return null; end if;

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

  return jsonb_build_object(
    'id', v_call.id,
    'kind', 'SERIAL_KILLER_ATTACK',
    'roleId', 'serial-killer',
    'roleName', 'Sát Nhân Hàng Loạt',
    'instructions', 'Chọn một người còn sống khác hoặc Không ai, rồi xác nhận quyết định.',
    'mode', 'SERIAL_KILLER_ATTACK',
    'candidates', v_candidates,
    'currentTargetId', case when v_intent.call_id is null
      then null else v_intent.target_player_id end,
    'hasSelected', v_intent.call_id is not null
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
    case
      when call.role_id = 'witch' then jsonb_build_object(
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
      )
      when call.role_id = 'cupid'
        then private.ms1f_moderator_cupid_action_payload(call.id)
      when call.role_id = 'serial-killer'
        then private.ms1g1_moderator_serial_killer_action_payload(call.id)
      else private.moderator_night_action_payload(call.id)
    end
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
  return v_payload
    || jsonb_build_object(
      'alivePlayerIds', v_alive_player_ids,
      'nightAction', case
        when v_active_role_id = 'witch'
          then private.witch_player_action_payload(p_room_id, v_user_id)
        when v_active_role_id = 'cupid'
          then private.ms1f_cupid_player_action_payload(p_room_id, v_user_id)
        when v_active_role_id = 'serial-killer'
          then private.ms1g1_serial_killer_player_action_payload(p_room_id, v_user_id)
        else private.player_night_action_payload(p_room_id, v_user_id)
      end,
      'dayVote', private.player_day_vote_payload(p_room_id, v_user_id)
    )
    || private.ms1f_player_relationship_payload(p_room_id, v_user_id);
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
    'sourcePlayerId', effect.source_player_id,
    'coupleId', effect.couple_id,
    'category', effect.effect_category,
    'targetPlayerId', effect.target_player_id,
    'lethal', effect.lethal,
    'protectorBlockable', effect.protector_blockable,
    'witchInteractable', effect.witch_interactable,
    'outcome', effect.outcome,
    'conversion', case when effect.conversion_kind is null then null
      else jsonb_build_object(
        'kind', effect.conversion_kind,
        'dueNightNumber', effect.conversion_due_night_number
      ) end,
    'immunity', case when effect.immunity_kind is null then null
      else jsonb_build_object(
        'kind', effect.immunity_kind,
        'roleId', effect.immunity_role_id
      ) end,
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
  v_serial_killer_call private.night_role_calls%rowtype;
  v_hunter_call private.night_role_calls%rowtype;
  v_wolf_configured boolean := false;
  v_protector_configured boolean := false;
  v_serial_killer_configured boolean := false;
  v_hunter_configured boolean := false;
  v_protector_target_id uuid;
  v_serial_killer_player_id uuid;
  v_serial_killer_target_id uuid;
  v_hunter_player_id uuid;
  v_hunter_target_id uuid;
  v_resolution_id uuid;
  v_effect_id uuid;
  v_resolution_outcome text;
  v_wolf_effect_outcome text;
  v_serial_killer_effect_outcome text;
  v_wolf_blocked boolean := false;
  v_serial_killer_blocked boolean := false;
  v_half_wolf_bite boolean := false;
  v_wolf_target_immune boolean := false;
  v_has_unblocked_lethal boolean := false;
  v_has_scheduled_bite boolean := false;
  v_has_immunity boolean := false;
  v_attack_count integer := 0;
  v_blocked_count integer := 0;
  v_hunter_provisional boolean := false;
  v_effect_count integer := 0;
  v_candidate_count integer := 0;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1g1('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1g1('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1g1('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1g1('NOT_NIGHT'); end if;

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
    where config.room_id = p_room_id and config.role_id = 'serial-killer' and config.quantity = 1
  ) into v_serial_killer_configured;
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
      perform private.raise_ms1g1('NIGHT_RESOLUTION_NOT_READY');
    end if;
  end if;
  if v_protector_configured then
    select * into v_protector_call
    from private.night_role_calls call
    where call.room_id = p_room_id
      and call.night_number = v_room.day_number
      and call.role_id = 'protector';
    if not found or v_protector_call.status <> 'COMPLETED' then
      perform private.raise_ms1g1('NIGHT_RESOLUTION_NOT_READY');
    end if;
    select intent.target_player_id into v_protector_target_id
    from private.protector_intents intent
    where intent.room_id = p_room_id
      and intent.night_number = v_room.day_number;
  end if;
  if v_serial_killer_configured then
    select * into v_serial_killer_call
    from private.night_role_calls call
    where call.room_id = p_room_id
      and call.night_number = v_room.day_number
      and call.role_id = 'serial-killer';
    if not found or v_serial_killer_call.status <> 'COMPLETED' then
      perform private.raise_ms1g1('NIGHT_RESOLUTION_NOT_READY');
    end if;
    select intent.serial_killer_player_id, intent.target_player_id
    into v_serial_killer_player_id, v_serial_killer_target_id
    from private.serial_killer_intents intent
    where intent.call_id = v_serial_killer_call.id
      and intent.confirmed;
  end if;
  if v_hunter_configured then
    select * into v_hunter_call
    from private.night_role_calls call
    where call.room_id = p_room_id
      and call.night_number = v_room.day_number
      and call.role_id = 'hunter';
    if not found or v_hunter_call.status <> 'COMPLETED' then
      perform private.raise_ms1g1('NIGHT_RESOLUTION_NOT_READY');
    end if;
    select intent.hunter_player_id, intent.target_player_id
    into v_hunter_player_id, v_hunter_target_id
    from private.hunter_night_intents intent
    where intent.call_id = v_hunter_call.id and intent.confirmed;
  end if;

  if v_wolf_configured and v_wolf_call.final_target_id is not null then
    v_attack_count := v_attack_count + 1;
    v_wolf_blocked := v_protector_target_id is not null
      and v_protector_target_id = v_wolf_call.final_target_id;
    select exists (
      select 1
      from public.room_role_assignments assignment
      where assignment.room_id = p_room_id
        and assignment.player_id = v_wolf_call.final_target_id
        and assignment.role_id = 'half-wolf'
        and not exists (
          select 1 from private.half_wolf_transitions transition
          where transition.room_id = assignment.room_id
            and transition.player_id = assignment.player_id
            and transition.status = 'TRANSFORMED'
        )
    ) into v_half_wolf_bite;
    select exists (
      select 1
      from public.room_role_assignments assignment
      where assignment.room_id = p_room_id
        and assignment.player_id = v_wolf_call.final_target_id
        and assignment.role_id = 'serial-killer'
    ) into v_wolf_target_immune;
    if v_wolf_blocked then
      v_wolf_effect_outcome := 'BLOCKED_BY_PROTECTOR';
      v_blocked_count := v_blocked_count + 1;
    elsif v_half_wolf_bite then
      v_wolf_effect_outcome := 'HALF_WOLF_BITE_SCHEDULED';
      v_has_scheduled_bite := true;
    elsif v_wolf_target_immune then
      v_wolf_effect_outcome := 'IMMUNE_TO_WOLF_ATTACK';
      v_has_immunity := true;
    else
      v_wolf_effect_outcome := 'UNBLOCKED';
      v_has_unblocked_lethal := true;
    end if;
  end if;

  if v_serial_killer_target_id is not null then
    v_attack_count := v_attack_count + 1;
    v_serial_killer_blocked := v_protector_target_id is not null
      and v_protector_target_id = v_serial_killer_target_id;
    if v_serial_killer_blocked then
      v_serial_killer_effect_outcome := 'BLOCKED_BY_PROTECTOR';
      v_blocked_count := v_blocked_count + 1;
    else
      v_serial_killer_effect_outcome := 'UNBLOCKED';
      v_has_unblocked_lethal := true;
    end if;
  end if;

  v_resolution_outcome := case
    when v_attack_count = 0 then 'NO_ATTACK'
    when v_has_unblocked_lethal then 'UNBLOCKED'
    when v_has_scheduled_bite then 'BITE_SCHEDULED'
    when v_has_immunity then 'IMMUNE'
    when v_blocked_count = v_attack_count then 'BLOCKED'
    else 'NO_ATTACK'
  end;

  insert into private.night_resolutions (
    room_id, night_number, outcome, resolved_by_user_id
  ) values (
    p_room_id, v_room.day_number, v_resolution_outcome, v_user_id
  ) returning id into v_resolution_id;

  if v_wolf_configured and v_wolf_call.final_target_id is not null then
    insert into private.night_effects (
      resolution_id, room_id, night_number, source_call_id, source_type,
      source_role_id, effect_category, target_player_id, lethal,
      protector_blockable, outcome, block_source_type, block_source_role_id,
      conversion_kind, conversion_due_night_number,
      immunity_kind, immunity_role_id
    ) values (
      v_resolution_id, p_room_id, v_room.day_number, v_wolf_call.id,
      'WOLF_ATTACK', 'werewolf', 'HOSTILE_VILLAIN_ATTACK',
      v_wolf_call.final_target_id,
      not v_half_wolf_bite and not v_wolf_target_immune,
      true, v_wolf_effect_outcome,
      case when v_wolf_blocked then 'PROTECTOR_SHIELD' end,
      case when v_wolf_blocked then 'protector' end,
      case when not v_wolf_blocked and v_half_wolf_bite
        then 'HALF_WOLF_TRANSFORMATION' end,
      case when not v_wolf_blocked and v_half_wolf_bite
        then v_room.day_number + 1 end,
      case when not v_wolf_blocked and v_wolf_target_immune
        then 'WOLF_ATTACK_IMMUNITY' end,
      case when not v_wolf_blocked and v_wolf_target_immune
        then 'serial-killer' end
    ) returning id into v_effect_id;
    insert into private.gameplay_events (
      room_id, night_number, event_type, role_id, target_player_id,
      resolution, metadata
    ) values (
      p_room_id, v_room.day_number, 'WOLF_ATTACK_CREATED', 'werewolf',
      v_wolf_call.final_target_id, v_wolf_effect_outcome,
      jsonb_build_object(
        'effectId', v_effect_id,
        'sourceType', 'WOLF_ATTACK',
        'effectCategory', 'HOSTILE_VILLAIN_ATTACK',
        'lethal', not v_half_wolf_bite and not v_wolf_target_immune,
        'protectorBlockable', true,
        'conversionCausing', not v_wolf_blocked and v_half_wolf_bite,
        'immuneNonlethal', not v_wolf_blocked and v_wolf_target_immune
      )
    );
    if v_wolf_blocked then
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
    elsif v_half_wolf_bite then
      insert into private.half_wolf_transitions (
        room_id, player_id, status, bitten_night_number,
        transform_due_night_number, source_effect_id
      ) values (
        p_room_id, v_wolf_call.final_target_id, 'PENDING_TRANSFORMATION',
        v_room.day_number, v_room.day_number + 1, v_effect_id
      );
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, target_player_id,
        resolution, metadata
      ) values (
        p_room_id, v_room.day_number, 'HALF_WOLF_BITE_SCHEDULED',
        'half-wolf', v_wolf_call.final_target_id, 'TRANSFORM_NEXT_NIGHT',
        jsonb_build_object(
          'sourceEffectId', v_effect_id,
          'transformDueNightNumber', v_room.day_number + 1,
          'secretTransition', true
        )
      );
    elsif v_wolf_target_immune then
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, target_player_id,
        resolution, metadata
      ) values (
        p_room_id, v_room.day_number, 'WOLF_ATTACK_IMMUNE', 'werewolf',
        v_wolf_call.final_target_id, 'IMMUNE_TO_WOLF_ATTACK',
        jsonb_build_object(
          'effectId', v_effect_id,
          'immunityKind', 'WOLF_ATTACK_IMMUNITY',
          'immunityRoleId', 'serial-killer',
          'private', true
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

  if v_serial_killer_target_id is not null then
    insert into private.night_effects (
      resolution_id, room_id, night_number, source_call_id, source_type,
      source_role_id, source_player_id, effect_category, target_player_id,
      lethal, protector_blockable, outcome, block_source_type,
      block_source_role_id
    ) values (
      v_resolution_id, p_room_id, v_room.day_number, v_serial_killer_call.id,
      'SERIAL_KILLER_ATTACK', 'serial-killer', v_serial_killer_player_id,
      'HOSTILE_VILLAIN_ATTACK', v_serial_killer_target_id,
      true, true, v_serial_killer_effect_outcome,
      case when v_serial_killer_blocked then 'PROTECTOR_SHIELD' end,
      case when v_serial_killer_blocked then 'protector' end
    ) returning id into v_effect_id;
    insert into private.gameplay_events (
      room_id, night_number, event_type, role_id, actor_player_id,
      target_player_id, resolution, metadata
    ) values (
      p_room_id, v_room.day_number, 'SERIAL_KILLER_ATTACK_CREATED',
      'serial-killer', v_serial_killer_player_id, v_serial_killer_target_id,
      v_serial_killer_effect_outcome,
      jsonb_build_object(
        'effectId', v_effect_id,
        'sourceType', 'SERIAL_KILLER_ATTACK',
        'effectCategory', 'HOSTILE_VILLAIN_ATTACK',
        'lethal', true,
        'protectorBlockable', true,
        'private', true
      )
    );
    if v_serial_killer_blocked then
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, actor_player_id,
        target_player_id, resolution, metadata
      ) values (
        p_room_id, v_room.day_number, 'SERIAL_KILLER_ATTACK_BLOCKED',
        'serial-killer', v_serial_killer_player_id, v_serial_killer_target_id,
        'BLOCKED_BY_PROTECTOR',
        jsonb_build_object(
          'effectId', v_effect_id,
          'blockSourceType', 'PROTECTOR_SHIELD',
          'blockSourceRoleId', 'protector',
          'private', true
        )
      );
    else
      insert into private.provisional_night_death_candidates (
        room_id, night_number, player_id, source_effect_id
      ) values (
        p_room_id, v_room.day_number, v_serial_killer_target_id, v_effect_id
      );
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, actor_player_id,
        target_player_id, resolution, metadata
      ) values (
        p_room_id, v_room.day_number, 'NIGHT_DEATH_CANDIDATE_CREATED',
        'serial-killer', v_serial_killer_player_id, v_serial_killer_target_id,
        'PROVISIONAL_PRE_WITCH',
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
    p_room_id, v_room.day_number, 'NIGHT_RESOLUTION_COMPLETED',
    case when v_wolf_call.final_target_id is not null
      then 'werewolf' else 'serial-killer' end,
    coalesce(v_wolf_call.final_target_id, v_serial_killer_target_id),
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

alter table private.serial_killer_intents enable row level security;
revoke all on table private.serial_killer_intents from public, anon, authenticated;

revoke execute on function private.raise_ms1g1(text)
  from public, anon, authenticated;
revoke execute on function private.ms1g1_moderator_serial_killer_action_payload(uuid)
  from public, anon, authenticated;
revoke execute on function private.ms1g1_serial_killer_player_action_payload(uuid, uuid)
  from public, anon, authenticated;

revoke execute on function public.ms1g1_open_serial_killer_call(uuid)
  from public, anon;
grant execute on function public.ms1g1_open_serial_killer_call(uuid)
  to authenticated;
revoke execute on function public.ms1g1_submit_serial_killer_intent(uuid, uuid)
  from public, anon;
grant execute on function public.ms1g1_submit_serial_killer_intent(uuid, uuid)
  to authenticated;
revoke execute on function public.ms1g1_confirm_serial_killer_intent(uuid)
  from public, anon;
grant execute on function public.ms1g1_confirm_serial_killer_intent(uuid)
  to authenticated;
revoke execute on function public.ms1b2_resolve_night_effects(uuid)
  from public, anon;
grant execute on function public.ms1b2_resolve_night_effects(uuid)
  to authenticated;

commit;
