begin;

create table private.night_resolutions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  night_number integer not null check (night_number >= 1),
  outcome text not null check (outcome in ('NO_ATTACK', 'BLOCKED', 'UNBLOCKED')),
  resolved_by_user_id uuid not null references auth.users(id),
  resolved_at timestamptz not null default statement_timestamp(),
  unique (room_id, night_number),
  unique (id, room_id, night_number)
);

create table private.night_effects (
  id uuid primary key default gen_random_uuid(),
  resolution_id uuid not null,
  room_id uuid not null,
  night_number integer not null check (night_number >= 1),
  source_call_id uuid not null references private.night_role_calls(id),
  source_type text not null check (char_length(source_type) > 0),
  source_role_id text not null references public.classic_roles(id),
  effect_category text not null check (
    effect_category in ('HOSTILE_VILLAIN_ATTACK', 'NON_VILLAIN_LETHAL_EFFECT')
  ),
  target_player_id uuid not null,
  lethal boolean not null,
  protector_blockable boolean not null,
  outcome text not null check (outcome in ('BLOCKED_BY_PROTECTOR', 'UNBLOCKED')),
  block_source_type text,
  block_source_role_id text references public.classic_roles(id),
  created_at timestamptz not null default statement_timestamp(),
  resolved_at timestamptz not null default statement_timestamp(),
  foreign key (resolution_id, room_id, night_number)
    references private.night_resolutions(id, room_id, night_number) on delete cascade,
  foreign key (room_id, target_player_id)
    references public.room_players(room_id, id),
  unique (source_call_id, source_type),
  unique (id, room_id, night_number, target_player_id),
  check (
    (
      outcome = 'BLOCKED_BY_PROTECTOR'
      and protector_blockable
      and block_source_type = 'PROTECTOR_SHIELD'
      and block_source_role_id = 'protector'
    )
    or (
      outcome = 'UNBLOCKED'
      and block_source_type is null
      and block_source_role_id is null
    )
  )
);

create table private.provisional_night_death_candidates (
  room_id uuid not null,
  night_number integer not null check (night_number >= 1),
  player_id uuid not null,
  source_effect_id uuid not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (room_id, night_number, player_id, source_effect_id),
  foreign key (room_id, player_id)
    references public.room_players(room_id, id) on delete cascade,
  foreign key (source_effect_id, room_id, night_number, player_id)
    references private.night_effects(id, room_id, night_number, target_player_id)
      on delete cascade
);

create index night_effects_room_night_idx
  on private.night_effects(room_id, night_number);

create index provisional_night_death_candidates_room_night_idx
  on private.provisional_night_death_candidates(room_id, night_number);

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
    'NIGHT_RESOLUTION_COMPLETED'
  ));

create or replace function private.raise_ms1b2(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
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
    'night', private.moderator_night_payload(p_room_id),
    'nightResolution', private.moderator_night_resolution_payload(p_room_id)
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
  v_wolf_configured boolean := false;
  v_protector_configured boolean := false;
  v_protector_target_id uuid;
  v_resolution_id uuid;
  v_effect_id uuid;
  v_resolution_outcome text;
  v_effect_outcome text;
  v_blocked boolean := false;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1b2('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1b2('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then
    perform private.raise_ms1b2('NOT_IN_GAME');
  end if;
  if v_room.phase <> 'NIGHT' then
    perform private.raise_ms1b2('NOT_NIGHT');
  end if;

  perform 1
  from private.night_resolutions resolution
  where resolution.room_id = p_room_id
    and resolution.night_number = v_room.day_number;
  if found then
    return private.moderator_night_resolution_payload(p_room_id);
  end if;

  select exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id
      and config.role_id = 'werewolf'
      and config.quantity > 0
  ) into v_wolf_configured;
  select exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id
      and config.role_id = 'protector'
      and config.quantity > 0
  ) into v_protector_configured;

  if v_wolf_configured then
    select * into v_wolf_call
    from private.night_role_calls call
    where call.room_id = p_room_id
      and call.night_number = v_room.day_number
      and call.role_id = 'werewolf';
    if not found or v_wolf_call.status <> 'COMPLETED' then
      perform private.raise_ms1b2('NIGHT_RESOLUTION_NOT_READY');
    end if;
  end if;

  if v_protector_configured then
    select * into v_protector_call
    from private.night_role_calls call
    where call.room_id = p_room_id
      and call.night_number = v_room.day_number
      and call.role_id = 'protector';
    if not found or v_protector_call.status <> 'COMPLETED' then
      perform private.raise_ms1b2('NIGHT_RESOLUTION_NOT_READY');
    end if;

    select intent.target_player_id into v_protector_target_id
    from private.protector_intents intent
    where intent.room_id = p_room_id
      and intent.night_number = v_room.day_number;
  end if;

  if not v_wolf_configured or v_wolf_call.final_target_id is null then
    v_resolution_outcome := 'NO_ATTACK';
  else
    v_blocked :=
      v_protector_target_id is not null
      and v_protector_target_id = v_wolf_call.final_target_id;
    v_resolution_outcome := case when v_blocked then 'BLOCKED' else 'UNBLOCKED' end;
    v_effect_outcome := case
      when v_blocked then 'BLOCKED_BY_PROTECTOR'
      else 'UNBLOCKED'
    end;
  end if;

  insert into private.night_resolutions (
    room_id, night_number, outcome, resolved_by_user_id
  ) values (
    p_room_id, v_room.day_number, v_resolution_outcome, v_user_id
  ) returning id into v_resolution_id;

  if v_resolution_outcome <> 'NO_ATTACK' then
    insert into private.night_effects (
      resolution_id,
      room_id,
      night_number,
      source_call_id,
      source_type,
      source_role_id,
      effect_category,
      target_player_id,
      lethal,
      protector_blockable,
      outcome,
      block_source_type,
      block_source_role_id
    ) values (
      v_resolution_id,
      p_room_id,
      v_room.day_number,
      v_wolf_call.id,
      'WOLF_ATTACK',
      'werewolf',
      'HOSTILE_VILLAIN_ATTACK',
      v_wolf_call.final_target_id,
      true,
      true,
      v_effect_outcome,
      case when v_blocked then 'PROTECTOR_SHIELD' end,
      case when v_blocked then 'protector' end
    ) returning id into v_effect_id;

    insert into private.gameplay_events (
      room_id,
      night_number,
      event_type,
      role_id,
      target_player_id,
      resolution,
      metadata
    ) values (
      p_room_id,
      v_room.day_number,
      'WOLF_ATTACK_CREATED',
      'werewolf',
      v_wolf_call.final_target_id,
      v_effect_outcome,
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
        room_id,
        night_number,
        event_type,
        role_id,
        target_player_id,
        resolution,
        metadata
      ) values (
        p_room_id,
        v_room.day_number,
        'WOLF_ATTACK_BLOCKED',
        'werewolf',
        v_wolf_call.final_target_id,
        'BLOCKED_BY_PROTECTOR',
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
        room_id,
        night_number,
        event_type,
        role_id,
        target_player_id,
        resolution,
        metadata
      ) values (
        p_room_id,
        v_room.day_number,
        'NIGHT_DEATH_CANDIDATE_CREATED',
        'werewolf',
        v_wolf_call.final_target_id,
        'PROVISIONAL_PRE_WITCH',
        jsonb_build_object(
          'sourceEffectId', v_effect_id,
          'finalDeathApplied', false
        )
      );
    end if;
  end if;

  insert into private.gameplay_events (
    room_id,
    night_number,
    event_type,
    role_id,
    target_player_id,
    resolution,
    metadata
  ) values (
    p_room_id,
    v_room.day_number,
    'NIGHT_RESOLUTION_COMPLETED',
    'werewolf',
    case when v_resolution_outcome = 'NO_ATTACK'
      then null else v_wolf_call.final_target_id end,
    v_resolution_outcome,
    jsonb_build_object(
      'resolutionId', v_resolution_id,
      'effectCount', case when v_resolution_outcome = 'NO_ATTACK' then 0 else 1 end,
      'provisionalDeathCandidateCount', case
        when v_resolution_outcome = 'UNBLOCKED' then 1 else 0 end,
      'finalDeathsApplied', false
    )
  );

  perform private.touch_gameplay_room(p_room_id);
  return private.moderator_night_resolution_payload(p_room_id);
end;
$$;

alter table private.night_resolutions enable row level security;
alter table private.night_effects enable row level security;
alter table private.provisional_night_death_candidates enable row level security;

revoke all on table private.night_resolutions from public, anon, authenticated;
revoke all on table private.night_effects from public, anon, authenticated;
revoke all on table private.provisional_night_death_candidates
  from public, anon, authenticated;

revoke execute on function private.raise_ms1b2(text)
  from public, anon, authenticated;
revoke execute on function private.moderator_night_resolution_payload(uuid)
  from public, anon, authenticated;

revoke execute on function public.ms1b2_resolve_night_effects(uuid)
  from public, anon;
grant execute on function public.ms1b2_resolve_night_effects(uuid)
  to authenticated;

revoke execute on function public.ms1a_get_moderator_room(uuid)
  from public, anon;
grant execute on function public.ms1a_get_moderator_room(uuid)
  to authenticated;

commit;
