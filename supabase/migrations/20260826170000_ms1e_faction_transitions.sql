begin;

alter table private.night_resolutions
  drop constraint if exists night_resolutions_outcome_check;
alter table private.night_resolutions
  add constraint night_resolutions_outcome_check check (
    outcome in ('NO_ATTACK', 'BLOCKED', 'UNBLOCKED', 'BITE_SCHEDULED')
  );

alter table private.night_effects
  add column conversion_kind text,
  add column conversion_due_night_number integer;
alter table private.night_effects
  drop constraint if exists night_effects_outcome_check;
alter table private.night_effects
  drop constraint if exists night_effects_check;
alter table private.night_effects
  add constraint night_effects_outcome_check check (
    outcome in (
      'BLOCKED_BY_PROTECTOR',
      'UNBLOCKED',
      'HALF_WOLF_BITE_SCHEDULED'
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
    )
    or (
      outcome = 'UNBLOCKED'
      and block_source_type is null
      and block_source_role_id is null
      and conversion_kind is null
      and conversion_due_night_number is null
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
    )
  );

create table private.half_wolf_transitions (
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null,
  status text not null check (
    status in ('PENDING_TRANSFORMATION', 'TRANSFORMED', 'CANCELED')
  ),
  bitten_night_number integer not null check (bitten_night_number >= 1),
  transform_due_night_number integer not null,
  source_effect_id uuid not null,
  bitten_at timestamptz not null default statement_timestamp(),
  transformed_night_number integer,
  transformed_at timestamptz,
  canceled_at timestamptz,
  cancellation_reason text,
  primary key (room_id, player_id),
  foreign key (room_id, player_id)
    references public.room_players(room_id, id) on delete cascade,
  foreign key (
    source_effect_id, room_id, bitten_night_number, player_id
  ) references private.night_effects(
    id, room_id, night_number, target_player_id
  ) on delete cascade,
  check (transform_due_night_number = bitten_night_number + 1),
  check (
    (
      status = 'PENDING_TRANSFORMATION'
      and transformed_night_number is null
      and transformed_at is null
      and canceled_at is null
      and cancellation_reason is null
    )
    or (
      status = 'TRANSFORMED'
      and transformed_night_number is not null
      and transformed_night_number >= transform_due_night_number
      and transformed_at is not null
      and canceled_at is null
      and cancellation_reason is null
    )
    or (
      status = 'CANCELED'
      and transformed_night_number is null
      and transformed_at is null
      and canceled_at is not null
      and cancellation_reason = 'DIED_BEFORE_TRANSFORMATION'
    )
  )
);

create table private.traitor_faction_transitions (
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null,
  converted_at timestamptz not null default statement_timestamp(),
  converted_night_number integer not null check (converted_night_number >= 1),
  conversion_reason text not null check (
    conversion_reason = 'NO_LIVING_BITE_CAPABLE_WOLF'
  ),
  primary key (room_id, player_id),
  foreign key (room_id, player_id)
    references public.room_players(room_id, id) on delete cascade
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
    'TRAITOR_CONVERTED_TO_VILLAGE'
  ));

create or replace function private.ms1e_living_bite_capable_wolf_exists(
  p_room_id uuid
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_role_assignments assignment
    join public.room_players player
      on player.room_id = assignment.room_id
      and player.id = assignment.player_id
    where assignment.room_id = p_room_id
      and player.alive
      and (
        assignment.role_id = 'werewolf'
        or (
          assignment.role_id = 'half-wolf'
          and exists (
            select 1
            from private.half_wolf_transitions transition
            where transition.room_id = assignment.room_id
              and transition.player_id = assignment.player_id
              and transition.status = 'TRANSFORMED'
          )
        )
      )
  );
$$;

create or replace function private.ms1e_wolf_actor_ids(p_room_id uuid)
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select case
    when not private.ms1e_living_bite_capable_wolf_exists(p_room_id)
      then '{}'::uuid[]
    else coalesce(array_agg(player.id order by player.seat_number), '{}'::uuid[])
  end
  from public.room_players player
  join public.room_role_assignments assignment
    on assignment.room_id = player.room_id
    and assignment.player_id = player.id
  where player.room_id = p_room_id
    and player.alive
    and (
      assignment.role_id = 'werewolf'
      or (
        assignment.role_id = 'half-wolf'
        and exists (
          select 1 from private.half_wolf_transitions transition
          where transition.room_id = assignment.room_id
            and transition.player_id = assignment.player_id
            and transition.status = 'TRANSFORMED'
        )
      )
      or (
        assignment.role_id = 'traitor'
        and not exists (
          select 1 from private.traitor_faction_transitions transition
          where transition.room_id = assignment.room_id
            and transition.player_id = assignment.player_id
        )
      )
    );
$$;

create or replace function private.ms1e_wolf_target_ids(p_room_id uuid)
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select case
    when not private.ms1e_living_bite_capable_wolf_exists(p_room_id)
      then '{}'::uuid[]
    else coalesce(array_agg(player.id order by player.seat_number), '{}'::uuid[])
  end
  from public.room_players player
  where player.room_id = p_room_id
    and player.alive
    and not (player.id = any(private.ms1e_wolf_actor_ids(p_room_id)));
$$;

create or replace function private.ms1e_reconcile_faction_transitions(
  p_room_id uuid,
  p_stage text,
  p_night_number integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transition record;
begin
  if p_stage not in ('AFTER_DEATH', 'START_NIGHT') then
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION_STAGE';
  end if;

  for v_transition in
    update private.half_wolf_transitions transition
    set status = 'CANCELED',
        canceled_at = statement_timestamp(),
        cancellation_reason = 'DIED_BEFORE_TRANSFORMATION'
    from public.room_players player
    where transition.room_id = p_room_id
      and transition.status = 'PENDING_TRANSFORMATION'
      and player.room_id = transition.room_id
      and player.id = transition.player_id
      and not player.alive
    returning transition.player_id
  loop
    insert into private.gameplay_events (
      room_id, night_number, event_type, role_id, target_player_id,
      resolution, metadata
    ) values (
      p_room_id, p_night_number, 'HALF_WOLF_TRANSFORMATION_CANCELED',
      'half-wolf', v_transition.player_id, 'DIED_BEFORE_TRANSFORMATION',
      jsonb_build_object('secretTransition', true)
    );
  end loop;

  if not private.ms1e_living_bite_capable_wolf_exists(p_room_id) then
    for v_transition in
      insert into private.traitor_faction_transitions (
        room_id, player_id, converted_night_number, conversion_reason
      )
      select assignment.room_id, assignment.player_id, p_night_number,
        'NO_LIVING_BITE_CAPABLE_WOLF'
      from public.room_role_assignments assignment
      join public.room_players player
        on player.room_id = assignment.room_id
        and player.id = assignment.player_id
      where assignment.room_id = p_room_id
        and assignment.role_id = 'traitor'
        and player.alive
      on conflict (room_id, player_id) do nothing
      returning player_id
    loop
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, target_player_id,
        resolution, metadata
      ) values (
        p_room_id, p_night_number, 'TRAITOR_CONVERTED_TO_VILLAGE',
        'traitor', v_transition.player_id, 'NO_LIVING_BITE_CAPABLE_WOLF',
        jsonb_build_object('permanent', true, 'secretTransition', true)
      );
    end loop;
  end if;

  if p_stage = 'START_NIGHT' then
    for v_transition in
      update private.half_wolf_transitions transition
      set status = 'TRANSFORMED',
          transformed_night_number = p_night_number,
          transformed_at = statement_timestamp()
      from public.room_players player
      where transition.room_id = p_room_id
        and transition.status = 'PENDING_TRANSFORMATION'
        and transition.transform_due_night_number <= p_night_number
        and player.room_id = transition.room_id
        and player.id = transition.player_id
        and player.alive
      returning transition.player_id
    loop
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, target_player_id,
        resolution, metadata
      ) values (
        p_room_id, p_night_number, 'HALF_WOLF_TRANSFORMED',
        'half-wolf', v_transition.player_id, 'WOLF',
        jsonb_build_object('biteCapable', true, 'secretTransition', true)
      );
    end loop;
  end if;
end;
$$;

create or replace function private.ms1e_reconcile_player_death()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_night_number integer;
begin
  if old.alive and not new.alive then
    select room.day_number into v_night_number
    from public.rooms room where room.id = new.room_id;
    perform private.ms1e_reconcile_faction_transitions(
      new.room_id, 'AFTER_DEATH', v_night_number
    );
  end if;
  return new;
end;
$$;

create trigger room_players_ms1e_reconcile_death
after update of alive on public.room_players
for each row execute function private.ms1e_reconcile_player_death();

create or replace function private.ms1e_reconcile_night_start()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.phase = 'NIGHT'
    and (old.phase is distinct from 'NIGHT' or old.day_number <> new.day_number)
  then
    perform private.ms1e_reconcile_faction_transitions(
      new.id, 'START_NIGHT', new.day_number
    );
  end if;
  return new;
end;
$$;

create trigger rooms_ms1e_reconcile_night_start
after update of phase, day_number on public.rooms
for each row execute function private.ms1e_reconcile_night_start();

create or replace function private.moderator_faction_transition_payload(
  p_room_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'halfWolves', coalesce((
      select jsonb_object_agg(
        assignment.player_id,
        jsonb_strip_nulls(jsonb_build_object(
          'playerId', assignment.player_id,
          'status', coalesce(transition.status, 'VILLAGE'),
          'bittenNightNumber', transition.bitten_night_number,
          'transformDueNightNumber', transition.transform_due_night_number,
          'bittenAt', transition.bitten_at,
          'transformedAt', transition.transformed_at,
          'canceledAt', transition.canceled_at,
          'cancellationReason', transition.cancellation_reason
        ))
      )
      from public.room_role_assignments assignment
      left join private.half_wolf_transitions transition
        on transition.room_id = assignment.room_id
        and transition.player_id = assignment.player_id
      where assignment.room_id = p_room_id
        and assignment.role_id = 'half-wolf'
    ), '{}'::jsonb),
    'traitors', coalesce((
      select jsonb_object_agg(
        assignment.player_id,
        jsonb_strip_nulls(jsonb_build_object(
          'playerId', assignment.player_id,
          'status', case when transition.player_id is null
            then 'WOLF_ALIGNED' else 'CONVERTED_VILLAGE' end,
          'convertedAt', transition.converted_at,
          'conversionReason', transition.conversion_reason
        ))
      )
      from public.room_role_assignments assignment
      left join private.traitor_faction_transitions transition
        on transition.room_id = assignment.room_id
        and transition.player_id = assignment.player_id
      where assignment.room_id = p_room_id
        and assignment.role_id = 'traitor'
    ), '{}'::jsonb)
  );
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
    v_actor_ids := private.ms1e_wolf_actor_ids(p_room_id);
    v_target_ids := private.ms1e_wolf_target_ids(p_room_id);
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
  v_result := case
    when v_target_role_id = 'werewolf' then 'WOLF'
    when v_target_role_id = 'half-wolf' and exists (
      select 1 from private.half_wolf_transitions transition
      where transition.room_id = p_room_id
        and transition.player_id = p_target_player_id
        and transition.status = 'TRANSFORMED'
    ) then 'WOLF'
    else 'NON_WOLF'
  end;
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
    'conversion', case when effect.conversion_kind is null then null
      else jsonb_build_object(
        'kind', effect.conversion_kind,
        'dueNightNumber', effect.conversion_due_night_number
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
  v_half_wolf_bite boolean := false;
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

  if v_wolf_configured and v_wolf_call.final_target_id is not null then
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
  end if;

  if not v_wolf_configured or v_wolf_call.final_target_id is null then
    v_resolution_outcome := 'NO_ATTACK';
  else
    v_blocked := v_protector_target_id is not null
      and v_protector_target_id = v_wolf_call.final_target_id;
    if v_blocked then
      v_resolution_outcome := 'BLOCKED';
      v_effect_outcome := 'BLOCKED_BY_PROTECTOR';
    elsif v_half_wolf_bite then
      v_resolution_outcome := 'BITE_SCHEDULED';
      v_effect_outcome := 'HALF_WOLF_BITE_SCHEDULED';
    else
      v_resolution_outcome := 'UNBLOCKED';
      v_effect_outcome := 'UNBLOCKED';
    end if;
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
      protector_blockable, outcome, block_source_type, block_source_role_id,
      conversion_kind, conversion_due_night_number
    ) values (
      v_resolution_id, p_room_id, v_room.day_number, v_wolf_call.id,
      'WOLF_ATTACK', 'werewolf', 'HOSTILE_VILLAIN_ATTACK',
      v_wolf_call.final_target_id, not v_half_wolf_bite, true,
      v_effect_outcome,
      case when v_blocked then 'PROTECTOR_SHIELD' end,
      case when v_blocked then 'protector' end,
      case when not v_blocked and v_half_wolf_bite
        then 'HALF_WOLF_TRANSFORMATION' end,
      case when not v_blocked and v_half_wolf_bite
        then v_room.day_number + 1 end
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
        'lethal', not v_half_wolf_bite,
        'protectorBlockable', true,
        'conversionCausing', not v_blocked and v_half_wolf_bite
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
    'dayVote', private.moderator_day_vote_payload(p_room_id),
    'factionTransitions', private.moderator_faction_transition_payload(p_room_id)
  );
end;
$$;

alter table private.half_wolf_transitions enable row level security;
alter table private.traitor_faction_transitions enable row level security;

revoke all on table private.half_wolf_transitions from public, anon, authenticated;
revoke all on table private.traitor_faction_transitions from public, anon, authenticated;

revoke execute on function private.ms1e_living_bite_capable_wolf_exists(uuid)
  from public, anon, authenticated;
revoke execute on function private.ms1e_wolf_actor_ids(uuid)
  from public, anon, authenticated;
revoke execute on function private.ms1e_wolf_target_ids(uuid)
  from public, anon, authenticated;
revoke execute on function private.ms1e_reconcile_faction_transitions(uuid, text, integer)
  from public, anon, authenticated;
revoke execute on function private.ms1e_reconcile_player_death()
  from public, anon, authenticated;
revoke execute on function private.ms1e_reconcile_night_start()
  from public, anon, authenticated;
revoke execute on function private.moderator_faction_transition_payload(uuid)
  from public, anon, authenticated;

revoke execute on function public.ms1b1_open_night_role_call(uuid, text)
  from public, anon;
grant execute on function public.ms1b1_open_night_role_call(uuid, text)
  to authenticated;
revoke execute on function public.ms1b1_submit_seer_inspection(uuid, uuid)
  from public, anon;
grant execute on function public.ms1b1_submit_seer_inspection(uuid, uuid)
  to authenticated;
revoke execute on function public.ms1b2_resolve_night_effects(uuid)
  from public, anon;
grant execute on function public.ms1b2_resolve_night_effects(uuid)
  to authenticated;

commit;
