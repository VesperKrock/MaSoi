begin;

alter table private.night_role_calls
  drop constraint if exists night_role_calls_role_id_check;
alter table private.night_role_calls
  add constraint night_role_calls_role_id_check
  check (role_id in ('werewolf', 'seer', 'protector', 'hunter', 'cupid', 'witch'));

insert into private.night_role_stages (role_id, stage, stage_order)
values ('cupid', 'PRE_WITCH', 5)
on conflict (role_id) do update
set stage = excluded.stage,
    stage_order = excluded.stage_order;

create table private.cupid_couples (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null unique references public.rooms(id) on delete cascade,
  cupid_call_id uuid not null unique references private.night_role_calls(id) on delete cascade,
  cupid_player_id uuid not null,
  first_lover_player_id uuid not null,
  second_lover_player_id uuid not null,
  paired_night_number integer not null check (paired_night_number = 1),
  paired_at timestamptz not null default statement_timestamp(),
  foreign key (room_id, cupid_player_id)
    references public.room_players(room_id, id),
  foreign key (room_id, first_lover_player_id)
    references public.room_players(room_id, id),
  foreign key (room_id, second_lover_player_id)
    references public.room_players(room_id, id),
  check (first_lover_player_id <> second_lover_player_id),
  check (cupid_player_id <> first_lover_player_id),
  check (cupid_player_id <> second_lover_player_id)
);

create table private.lover_reveal_acknowledgements (
  couple_id uuid not null references private.cupid_couples(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null,
  acknowledged_at timestamptz not null default statement_timestamp(),
  primary key (couple_id, player_id),
  foreign key (room_id, player_id)
    references public.room_players(room_id, id)
);

create table private.cupid_runtime_objectives (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  cupid_player_id uuid not null,
  status text not null check (
    status in ('UNRESOLVED', 'ACTIVE', 'FALLBACK_VILLAGE')
  ),
  changed_at timestamptz not null default statement_timestamp(),
  reason text check (
    reason is null or reason in ('CUPID_DEAD_BEFORE_PAIRING', 'COUPLE_DEAD')
  ),
  foreign key (room_id, cupid_player_id)
    references public.room_players(room_id, id),
  check (
    (status in ('UNRESOLVED', 'ACTIVE') and reason is null)
    or (status = 'FALLBACK_VILLAGE' and reason is not null)
  )
);

alter table private.night_effects
  add column source_player_id uuid,
  add column couple_id uuid,
  add column witch_interactable boolean generated always as (
    source_type not in ('WITCH_POISON', 'LOVER_HEARTBREAK')
  ) stored;
alter table private.night_effects
  add constraint night_effects_source_player_fk
  foreign key (room_id, source_player_id)
    references public.room_players(room_id, id);
alter table private.night_effects
  add constraint night_effects_couple_fk
  foreign key (couple_id) references private.cupid_couples(id);
alter table private.night_effects
  add constraint night_effects_lover_heartbreak_check check (
    source_type <> 'LOVER_HEARTBREAK'
    or (
      source_role_id = 'cupid'
      and effect_category = 'NON_VILLAIN_LETHAL_EFFECT'
      and lethal
      and not protector_blockable
      and outcome = 'UNBLOCKED'
      and source_player_id is not null
      and couple_id is not null
      and activation_condition is null
    )
  );

alter table private.day_effects
  add column source_player_id uuid,
  add column couple_id uuid,
  add column witch_interactable boolean generated always as (false) stored;
alter table private.day_effects
  add constraint day_effects_source_player_fk
  foreign key (room_id, source_player_id)
    references public.room_players(room_id, id);
alter table private.day_effects
  add constraint day_effects_couple_fk
  foreign key (couple_id) references private.cupid_couples(id);
alter table private.day_effects
  drop constraint if exists day_effects_source_type_check;
alter table private.day_effects
  drop constraint if exists day_effects_check;
alter table private.day_effects
  add constraint day_effects_source_type_check check (
    source_type in ('DAY_HANGING', 'HUNTER_REVENGE_SHOT', 'LOVER_HEARTBREAK')
  );
alter table private.day_effects
  add constraint day_effects_source_contract_check check (
    (source_type = 'DAY_HANGING'
      and source_role_id is null
      and actor_player_id is null
      and source_player_id is null
      and couple_id is null
      and effect_category = 'DAY_LETHAL_EFFECT')
    or
    (source_type = 'HUNTER_REVENGE_SHOT'
      and source_role_id = 'hunter'
      and actor_player_id is not null
      and source_player_id is null
      and couple_id is null
      and effect_category = 'NON_VILLAIN_LETHAL_EFFECT')
    or
    (source_type = 'LOVER_HEARTBREAK'
      and source_role_id = 'cupid'
      and actor_player_id is null
      and source_player_id is not null
      and couple_id is not null
      and effect_category = 'NON_VILLAIN_LETHAL_EFFECT')
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
    'TRAITOR_CONVERTED_TO_VILLAGE',
    'CUPID_PAIR_CREATED',
    'LOVER_REVEAL_ACKNOWLEDGED',
    'LOVER_HEARTBREAK_CREATED',
    'CUPID_OBJECTIVE_FALLBACK'
  ));

create or replace function private.raise_ms1f(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end;
$$;

create or replace function private.ms1f_player_object(p_player_id uuid)
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

create or replace function private.ms1f_moderator_cupid_payload(p_room_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_couple private.cupid_couples%rowtype;
  v_objective private.cupid_runtime_objectives%rowtype;
  v_acknowledged jsonb := '[]'::jsonb;
begin
  select * into v_couple
  from private.cupid_couples couple
  where couple.room_id = p_room_id;
  select * into v_objective
  from private.cupid_runtime_objectives objective
  where objective.room_id = p_room_id;
  if v_couple.id is not null then
    select coalesce(jsonb_agg(ack.player_id order by player.seat_number), '[]'::jsonb)
    into v_acknowledged
    from private.lover_reveal_acknowledgements ack
    join public.room_players player on player.id = ack.player_id
    where ack.couple_id = v_couple.id;
  end if;
  return jsonb_build_object(
    'couple', case when v_couple.id is null then null else jsonb_build_object(
      'id', v_couple.id,
      'cupidPlayerId', v_couple.cupid_player_id,
      'loverPlayerIds', jsonb_build_array(
        v_couple.first_lover_player_id,
        v_couple.second_lover_player_id
      ),
      'pairedNightNumber', v_couple.paired_night_number,
      'pairedAt', v_couple.paired_at
    ) end,
    'loverRevealAcknowledgedPlayerIds', v_acknowledged,
    'objective', case when v_objective.room_id is null then null else jsonb_strip_nulls(jsonb_build_object(
      'cupidPlayerId', v_objective.cupid_player_id,
      'status', v_objective.status,
      'changedAt', v_objective.changed_at,
      'reason', v_objective.reason
    )) end
  );
end;
$$;

create or replace function private.ms1f_player_relationship_payload(
  p_room_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_player_id uuid;
  v_role_id text;
  v_couple private.cupid_couples%rowtype;
  v_partner_id uuid;
  v_reveal_pending boolean;
  v_result jsonb := '{}'::jsonb;
begin
  select membership.player_id, assignment.role_id
  into v_player_id, v_role_id
  from public.room_memberships membership
  left join public.room_role_assignments assignment
    on assignment.room_id = membership.room_id
    and assignment.player_id = membership.player_id
  where membership.room_id = p_room_id
    and membership.user_id = p_user_id;
  if v_player_id is null then return v_result; end if;

  select * into v_couple
  from private.cupid_couples couple
  where couple.room_id = p_room_id;
  if not found then return v_result; end if;

  if v_player_id = v_couple.first_lover_player_id then
    v_partner_id := v_couple.second_lover_player_id;
  elsif v_player_id = v_couple.second_lover_player_id then
    v_partner_id := v_couple.first_lover_player_id;
  end if;
  if v_partner_id is not null then
    v_reveal_pending := not exists (
      select 1 from private.lover_reveal_acknowledgements ack
      where ack.couple_id = v_couple.id
        and ack.player_id = v_player_id
    );
    v_result := v_result || jsonb_build_object(
      'loverRelationship', jsonb_build_object(
        'partner', private.ms1f_player_object(v_partner_id),
        'revealPending', v_reveal_pending
      )
    );
  end if;
  if v_role_id = 'cupid' and v_player_id = v_couple.cupid_player_id then
    v_result := v_result || jsonb_build_object(
      'cupidPair', jsonb_build_object(
        'lovers', jsonb_build_array(
          private.ms1f_player_object(v_couple.first_lover_player_id),
          private.ms1f_player_object(v_couple.second_lover_player_id)
        )
      )
    );
  end if;
  return v_result;
end;
$$;

create or replace function private.ms1f_cupid_player_action_payload(
  p_room_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_player_id uuid;
  v_call private.night_role_calls%rowtype;
  v_candidates jsonb := '[]'::jsonb;
begin
  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  join public.room_role_assignments assignment
    on assignment.room_id = membership.room_id
    and assignment.player_id = membership.player_id
  where membership.room_id = p_room_id
    and membership.user_id = p_user_id
    and player.alive
    and assignment.role_id = 'cupid';
  if v_player_id is null then return null; end if;

  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.role_id = 'cupid'
    and call.status = 'ACTIVE';
  if not found or not (v_player_id = any(v_call.eligible_actor_ids)) then
    return null;
  end if;

  select coalesce(jsonb_agg(private.ms1f_player_object(player.id)
    order by player.seat_number), '[]'::jsonb)
  into v_candidates
  from public.room_players player
  where player.room_id = p_room_id
    and player.id = any(v_call.eligible_target_ids);

  return jsonb_build_object(
    'id', v_call.id,
    'kind', 'CUPID_PAIRING',
    'roleId', 'cupid',
    'roleName', 'Thần Tình Yêu',
    'instructions', 'Chọn đúng hai người còn sống để ghép thành một cặp Người Yêu.',
    'mode', 'CUPID_PAIRING',
    'candidates', v_candidates,
    'selectedTargetIds', '[]'::jsonb,
    'hasSelected', false
  );
end;
$$;

create or replace function public.ms1f_open_cupid_call(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_call private.night_role_calls%rowtype;
  v_cupid_player_id uuid;
  v_cupid_alive boolean := false;
  v_actor_ids uuid[] := '{}'::uuid[];
  v_target_ids uuid[] := '{}'::uuid[];
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1f('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1f('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1f('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1f('NOT_NIGHT'); end if;
  if not exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id
      and config.role_id = 'cupid'
      and config.quantity = 1
  ) then perform private.raise_ms1f('ROLE_NOT_CONFIGURED'); end if;
  if exists (
    select 1 from private.night_role_calls call
    where call.room_id = p_room_id and call.status = 'ACTIVE'
  ) then perform private.raise_ms1f('CALL_ALREADY_ACTIVE'); end if;

  insert into private.night_role_calls (room_id, night_number, role_id)
  values (p_room_id, v_room.day_number, 'cupid')
  on conflict (room_id, night_number, role_id) do nothing;
  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = v_room.day_number
    and call.role_id = 'cupid'
  for update;
  if v_call.status = 'COMPLETED' then
    perform private.raise_ms1f('CALL_ALREADY_COMPLETED');
  end if;

  select assignment.player_id, player.alive
  into v_cupid_player_id, v_cupid_alive
  from public.room_role_assignments assignment
  join public.room_players player
    on player.room_id = assignment.room_id
    and player.id = assignment.player_id
  where assignment.room_id = p_room_id
    and assignment.role_id = 'cupid';

  insert into private.cupid_runtime_objectives (
    room_id, cupid_player_id, status
  ) values (
    p_room_id, v_cupid_player_id, 'UNRESOLVED'
  ) on conflict (room_id) do nothing;

  if v_room.day_number = 1
    and v_cupid_alive
    and not exists (
      select 1 from private.cupid_couples couple
      where couple.room_id = p_room_id
    ) then
    v_actor_ids := array[v_cupid_player_id];
    select coalesce(array_agg(player.id order by player.seat_number), '{}'::uuid[])
    into v_target_ids
    from public.room_players player
    where player.room_id = p_room_id
      and player.alive
      and player.id <> v_cupid_player_id;
  elsif v_room.day_number = 1 and not v_cupid_alive then
    update private.cupid_runtime_objectives
    set status = 'FALLBACK_VILLAGE',
        changed_at = statement_timestamp(),
        reason = 'CUPID_DEAD_BEFORE_PAIRING'
    where room_id = p_room_id and status = 'UNRESOLVED';
    if found then
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id,
        actor_player_id, resolution, metadata
      ) values (
        p_room_id, 1, 'CUPID_OBJECTIVE_FALLBACK', 'cupid',
        v_cupid_player_id, 'VILLAGE_SIDE',
        jsonb_build_object(
          'reason', 'CUPID_DEAD_BEFORE_PAIRING',
          'private', true
        )
      );
    end if;
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
    p_room_id, v_room.day_number, 'ROLE_CALLED', 'cupid',
    jsonb_build_object(
      'eligibleActorCount', cardinality(v_actor_ids),
      'firstNightAction', v_room.day_number = 1
    )
  );
  perform private.touch_gameplay_room(p_room_id);
  return private.moderator_night_payload(p_room_id);
end;
$$;

create or replace function public.ms1f_submit_cupid_pairing(
  p_room_id uuid,
  p_first_target_player_id uuid,
  p_second_target_player_id uuid
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
  v_existing private.cupid_couples%rowtype;
  v_couple_id uuid;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1f('ROOM_NOT_FOUND'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1f('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1f('NOT_NIGHT'); end if;

  select membership.player_id into v_player_id
  from public.room_memberships membership
  join public.room_players player on player.id = membership.player_id
  join public.room_role_assignments assignment
    on assignment.room_id = membership.room_id
    and assignment.player_id = membership.player_id
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id
    and player.alive
    and assignment.role_id = 'cupid';
  if v_player_id is null then perform private.raise_ms1f('WRONG_ROLE'); end if;

  select * into v_existing
  from private.cupid_couples couple
  where couple.room_id = p_room_id;
  if found then
    if v_existing.cupid_player_id = v_player_id
      and (
        (v_existing.first_lover_player_id = p_first_target_player_id
          and v_existing.second_lover_player_id = p_second_target_player_id)
        or
        (v_existing.first_lover_player_id = p_second_target_player_id
          and v_existing.second_lover_player_id = p_first_target_player_id)
      ) then
      return public.ms1a_get_player_room(p_room_id);
    end if;
    perform private.raise_ms1f('CUPID_PAIR_ALREADY_EXISTS');
  end if;

  if v_room.day_number <> 1 then
    perform private.raise_ms1f('CUPID_PAIRING_NIGHT_ONE_ONLY');
  end if;
  select * into v_call
  from private.night_role_calls call
  where call.room_id = p_room_id
    and call.night_number = 1
    and call.role_id = 'cupid'
    and call.status = 'ACTIVE'
  for update;
  if not found then perform private.raise_ms1f('CALL_NOT_ACTIVE'); end if;
  if not (v_player_id = any(v_call.eligible_actor_ids)) then
    perform private.raise_ms1f('WRONG_ROLE');
  end if;
  if p_first_target_player_id = p_second_target_player_id then
    perform private.raise_ms1f('CUPID_TARGETS_MUST_BE_DISTINCT');
  end if;
  if p_first_target_player_id = v_player_id
    or p_second_target_player_id = v_player_id then
    perform private.raise_ms1f('CUPID_CANNOT_TARGET_SELF');
  end if;
  if not (p_first_target_player_id = any(v_call.eligible_target_ids))
    or not (p_second_target_player_id = any(v_call.eligible_target_ids))
    or not exists (
      select 1 from public.room_players player
      where player.room_id = p_room_id
        and player.id = p_first_target_player_id
        and player.alive
    )
    or not exists (
      select 1 from public.room_players player
      where player.room_id = p_room_id
        and player.id = p_second_target_player_id
        and player.alive
    ) then perform private.raise_ms1f('CUPID_TARGET_NOT_LIVING'); end if;

  insert into private.cupid_couples (
    room_id, cupid_call_id, cupid_player_id,
    first_lover_player_id, second_lover_player_id, paired_night_number
  ) values (
    p_room_id, v_call.id, v_player_id,
    p_first_target_player_id, p_second_target_player_id, 1
  ) returning id into v_couple_id;
  update private.cupid_runtime_objectives
  set status = 'ACTIVE', changed_at = statement_timestamp(), reason = null
  where room_id = p_room_id and cupid_player_id = v_player_id;
  update private.night_role_calls
  set status = 'COMPLETED', completed_at = statement_timestamp()
  where id = v_call.id;

  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id,
    actor_player_id, resolution, metadata
  ) values (
    p_room_id, 1, 'CUPID_PAIR_CREATED', 'cupid', v_player_id,
    'PAIR_CREATED', jsonb_build_object(
      'coupleId', v_couple_id,
      'loverPlayerIds', jsonb_build_array(
        p_first_target_player_id,
        p_second_target_player_id
      ),
      'private', true
    )
  );
  insert into private.gameplay_events (
    room_id, night_number, event_type, role_id,
    actor_player_id, resolution, metadata
  ) values (
    p_room_id, 1, 'CALL_COMPLETED', 'cupid', v_player_id,
    'PAIR_CREATED', jsonb_build_object('coupleId', v_couple_id, 'private', true)
  );
  perform private.touch_gameplay_room(p_room_id);
  return public.ms1a_get_player_room(p_room_id);
end;
$$;

create or replace function public.ms1f_acknowledge_lover_reveal(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_player_id uuid;
  v_couple private.cupid_couples%rowtype;
begin
  select membership.player_id into v_player_id
  from public.room_memberships membership
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id;
  if v_player_id is null then perform private.raise_ms1f('NOT_PLAYER'); end if;
  select * into v_couple
  from private.cupid_couples couple
  where couple.room_id = p_room_id
  for update;
  if not found or v_player_id not in (
    v_couple.first_lover_player_id,
    v_couple.second_lover_player_id
  ) then perform private.raise_ms1f('LOVER_REVEAL_UNAVAILABLE'); end if;
  insert into private.lover_reveal_acknowledgements (
    couple_id, room_id, player_id
  ) values (
    v_couple.id, p_room_id, v_player_id
  ) on conflict (couple_id, player_id) do nothing;
  if found then
    insert into private.gameplay_events (
      room_id, night_number, event_type,
      actor_player_id, resolution, metadata
    ) values (
      p_room_id, 1, 'LOVER_REVEAL_ACKNOWLEDGED',
      v_player_id, 'PRIVATE_PARTNER_REMEMBERED',
      jsonb_build_object('coupleId', v_couple.id, 'private', true)
    );
    perform private.touch_gameplay_room(p_room_id);
  end if;
  return public.ms1a_get_player_room(p_room_id);
end;
$$;

-- Declared before fixpoint helpers so every death path reuses one objective
-- reconciliation primitive.
create or replace function private.ms1f_reconcile_cupid_objective(
  p_room_id uuid,
  p_night_number integer
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_objective private.cupid_runtime_objectives%rowtype;
  v_couple private.cupid_couples%rowtype;
begin
  select * into v_objective
  from private.cupid_runtime_objectives objective
  where objective.room_id = p_room_id
  for update;
  if not found or v_objective.status <> 'ACTIVE' then return; end if;
  select * into v_couple
  from private.cupid_couples couple
  where couple.room_id = p_room_id;
  if not found then return; end if;
  if not exists (
    select 1 from public.room_players player
    where player.room_id = p_room_id
      and player.id in (
        v_couple.first_lover_player_id,
        v_couple.second_lover_player_id
      )
      and player.alive
  ) then
    update private.cupid_runtime_objectives
    set status = 'FALLBACK_VILLAGE',
        changed_at = statement_timestamp(),
        reason = 'COUPLE_DEAD'
    where room_id = p_room_id and status = 'ACTIVE';
    if found then
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id,
        actor_player_id, resolution, metadata
      ) values (
        p_room_id, p_night_number, 'CUPID_OBJECTIVE_FALLBACK', 'cupid',
        v_objective.cupid_player_id, 'VILLAGE_SIDE',
        jsonb_build_object('reason', 'COUPLE_DEAD', 'private', true)
      );
    end if;
  end if;
end;
$$;

create or replace function public.ms1f_open_witch_call(p_room_id uuid)
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
  if not found then perform private.raise_ms1f('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1f('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1f('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1f('NOT_NIGHT'); end if;
  if exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id
      and config.role_id = 'cupid'
      and config.quantity = 1
      and not exists (
        select 1 from private.night_role_calls call
        where call.room_id = p_room_id
          and call.night_number = v_room.day_number
          and call.role_id = 'cupid'
          and call.status = 'COMPLETED'
      )
  ) then perform private.raise_ms1f('WITCH_CHECKPOINT_NOT_READY'); end if;
  if not exists (
    select 1 from private.night_resolutions resolution
    where resolution.room_id = p_room_id
      and resolution.night_number = v_room.day_number
  ) then perform private.raise_ms1f('WITCH_CHECKPOINT_NOT_READY'); end if;
  return public.ms1c_open_witch_call(p_room_id);
end;
$$;

create or replace function public.ms1f_finalize_night_checkpoint(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_finalization_id uuid;
  v_resolution_id uuid;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1f('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1f('NOT_MODERATOR'); end if;
  if v_room.status <> 'IN_GAME' then perform private.raise_ms1f('NOT_IN_GAME'); end if;
  if v_room.phase <> 'NIGHT' then perform private.raise_ms1f('NOT_NIGHT'); end if;
  if exists (
    select 1 from public.room_role_config config
    where config.room_id = p_room_id
      and config.role_id = 'cupid'
      and config.quantity = 1
      and not exists (
        select 1 from private.night_role_calls call
        where call.room_id = p_room_id
          and call.night_number = v_room.day_number
          and call.role_id = 'cupid'
          and call.status = 'COMPLETED'
      )
  ) then perform private.raise_ms1f('WITCH_CHECKPOINT_NOT_READY'); end if;

  perform public.ms1c_finalize_night_checkpoint(p_room_id);
  select finalization.id, finalization.resolution_id
  into v_finalization_id, v_resolution_id
  from private.night_finalizations finalization
  where finalization.room_id = p_room_id
    and finalization.night_number = v_room.day_number;
  if v_finalization_id is null then
    perform private.raise_ms1f('WITCH_CHECKPOINT_NOT_READY');
  end if;
  perform private.ms1f_reconcile_night_death_consequences(
    p_room_id,
    v_room.day_number,
    v_finalization_id,
    v_resolution_id
  );
  perform private.touch_gameplay_room(p_room_id);
  return private.moderator_witch_checkpoint_payload(p_room_id);
end;
$$;

create or replace function public.ms1f_resolve_day_vote(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_vote_id uuid;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1f('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1f('NOT_MODERATOR'); end if;
  perform public.ms1d2_resolve_day_vote(p_room_id);
  select vote.id into v_vote_id
  from private.day_vote_rounds vote
  where vote.room_id = p_room_id
    and vote.day_number = v_room.day_number;
  perform private.ms1f_reconcile_day_heartbreak(
    p_room_id,
    v_room.day_number,
    v_vote_id
  );
  perform private.touch_gameplay_room(p_room_id);
  return public.ms1a_get_moderator_room(p_room_id);
end;
$$;

create or replace function public.ms1f_submit_hunter_revenge(
  p_room_id uuid,
  p_target_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_vote_id uuid;
begin
  perform private.require_auth_uid();
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1f('ROOM_NOT_FOUND'); end if;
  perform public.ms1d2_submit_hunter_revenge(
    p_room_id,
    p_target_player_id
  );
  select vote.id into v_vote_id
  from private.day_vote_rounds vote
  where vote.room_id = p_room_id
    and vote.day_number = v_room.day_number;
  perform private.ms1f_reconcile_day_heartbreak(
    p_room_id,
    v_room.day_number,
    v_vote_id
  );
  perform private.touch_gameplay_room(p_room_id);
  return public.ms1a_get_player_room(p_room_id);
end;
$$;

create or replace function public.ms1f_start_next_night(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_couple private.cupid_couples%rowtype;
begin
  perform 1
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then perform private.raise_ms1f('ROOM_NOT_FOUND'); end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then perform private.raise_ms1f('NOT_MODERATOR'); end if;
  select * into v_couple
  from private.cupid_couples couple
  where couple.room_id = p_room_id;
  if found and (
    select count(*)
    from public.room_players player
    where player.room_id = p_room_id
      and player.id in (
        v_couple.first_lover_player_id,
        v_couple.second_lover_player_id
      )
      and player.alive
  ) = 1 then perform private.raise_ms1f('DAY_CONSEQUENCE_NOT_READY'); end if;
  return public.ms1d2_start_next_night(p_room_id);
end;
$$;

create or replace function private.ms1f_reconcile_night_death_consequences(
  p_room_id uuid,
  p_night_number integer,
  p_finalization_id uuid,
  p_resolution_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_couple private.cupid_couples%rowtype;
  v_source_player_id uuid;
  v_target_player_id uuid;
  v_effect_id uuid;
  v_hunter_effect record;
  v_changed boolean := true;
  v_inserted boolean;
begin
  select * into v_couple
  from private.cupid_couples couple
  where couple.room_id = p_room_id;

  while v_changed loop
    v_changed := false;

    if v_couple.id is not null then
      v_source_player_id := null;
      v_target_player_id := null;
      if exists (
        select 1 from private.night_final_deaths death
        where death.finalization_id = p_finalization_id
          and death.player_id = v_couple.first_lover_player_id
      ) and exists (
        select 1 from public.room_players player
        where player.room_id = p_room_id
          and player.id = v_couple.second_lover_player_id
          and player.alive
      ) and not exists (
        select 1 from private.night_final_deaths death
        where death.finalization_id = p_finalization_id
          and death.player_id = v_couple.second_lover_player_id
      ) then
        v_source_player_id := v_couple.first_lover_player_id;
        v_target_player_id := v_couple.second_lover_player_id;
      elsif exists (
        select 1 from private.night_final_deaths death
        where death.finalization_id = p_finalization_id
          and death.player_id = v_couple.second_lover_player_id
      ) and exists (
        select 1 from public.room_players player
        where player.room_id = p_room_id
          and player.id = v_couple.first_lover_player_id
          and player.alive
      ) and not exists (
        select 1 from private.night_final_deaths death
        where death.finalization_id = p_finalization_id
          and death.player_id = v_couple.first_lover_player_id
      ) then
        v_source_player_id := v_couple.second_lover_player_id;
        v_target_player_id := v_couple.first_lover_player_id;
      end if;

      if v_target_player_id is not null then
        v_effect_id := null;
        v_inserted := false;
        insert into private.night_effects (
          resolution_id, room_id, night_number, source_call_id,
          source_type, source_role_id, effect_category, target_player_id,
          lethal, protector_blockable, outcome, source_player_id, couple_id
        ) values (
          p_resolution_id, p_room_id, p_night_number, v_couple.cupid_call_id,
          'LOVER_HEARTBREAK', 'cupid', 'NON_VILLAIN_LETHAL_EFFECT',
          v_target_player_id, true, false, 'UNBLOCKED',
          v_source_player_id, v_couple.id
        )
        on conflict (source_call_id, source_type) do nothing
        returning id into v_effect_id;
        v_inserted := found;
        if v_effect_id is null then
          select effect.id into v_effect_id
          from private.night_effects effect
          where effect.source_call_id = v_couple.cupid_call_id
            and effect.source_type = 'LOVER_HEARTBREAK';
        end if;

        insert into private.night_final_deaths (
          finalization_id, room_id, night_number, player_id, source_effect_id
        ) values (
          p_finalization_id, p_room_id, p_night_number,
          v_target_player_id, v_effect_id
        ) on conflict do nothing;
        if found then
          update public.room_players
          set alive = false
          where room_id = p_room_id
            and id = v_target_player_id
            and alive;
          v_changed := true;
        end if;

        if v_inserted then
          insert into private.gameplay_events (
            room_id, night_number, event_type, role_id,
            actor_player_id, target_player_id, resolution, metadata
          ) values (
            p_room_id, p_night_number, 'LOVER_HEARTBREAK_CREATED', 'cupid',
            v_source_player_id, v_target_player_id, 'FINAL_NIGHT_CONSEQUENCE',
            jsonb_build_object(
              'effectId', v_effect_id,
              'coupleId', v_couple.id,
              'sourceType', 'LOVER_HEARTBREAK',
              'protectorBlockable', false,
              'witchInteractable', false,
              'privateRelationship', true
            )
          );
        end if;
      end if;
    end if;

    select effect.* into v_hunter_effect
    from private.night_effects effect
    where effect.resolution_id = p_resolution_id
      and effect.source_type = 'HUNTER_SHOT'
      and effect.activation_condition = 'SOURCE_PLAYER_FINAL_NIGHT_DEATH'
      and effect.activation_status <> 'ACTIVATED'
      and exists (
        select 1 from private.night_final_deaths death
        where death.finalization_id = p_finalization_id
          and death.player_id = effect.condition_player_id
      )
    order by effect.created_at, effect.id
    limit 1;

    if found then
      update private.night_effects
      set activation_status = 'ACTIVATED'
      where id = v_hunter_effect.id
        and activation_status <> 'ACTIVATED';

      insert into private.night_final_deaths (
        finalization_id, room_id, night_number, player_id, source_effect_id
      )
      select p_finalization_id, p_room_id, p_night_number,
        v_hunter_effect.target_player_id, v_hunter_effect.id
      where exists (
        select 1 from public.room_players player
        where player.room_id = p_room_id
          and player.id = v_hunter_effect.target_player_id
          and player.alive
      )
      on conflict do nothing;
      if found then
        update public.room_players
        set alive = false
        where room_id = p_room_id
          and id = v_hunter_effect.target_player_id
          and alive;
        v_changed := true;
      end if;

      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id,
        actor_player_id, target_player_id, resolution, metadata
      ) values (
        p_room_id, p_night_number, 'HUNTER_SHOT_ACTIVATED', 'hunter',
        v_hunter_effect.condition_player_id,
        v_hunter_effect.target_player_id,
        'ACTIVATED_AFTER_HEARTBREAK',
        jsonb_build_object(
          'effectId', v_hunter_effect.id,
          'protectorBlockable', false
        )
      );
    end if;
  end loop;

  perform private.ms1f_reconcile_cupid_objective(
    p_room_id,
    p_night_number
  );
end;
$$;

create or replace function private.ms1f_reconcile_day_heartbreak(
  p_room_id uuid,
  p_day_number integer,
  p_vote_id uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_couple private.cupid_couples%rowtype;
  v_source_player_id uuid;
  v_target_player_id uuid;
  v_effect_id uuid;
begin
  select * into v_couple
  from private.cupid_couples couple
  where couple.room_id = p_room_id;
  if not found then return; end if;

  if not exists (
    select 1 from public.room_players player
    where player.room_id = p_room_id
      and player.id = v_couple.first_lover_player_id
      and player.alive
  ) and exists (
    select 1 from public.room_players player
    where player.room_id = p_room_id
      and player.id = v_couple.second_lover_player_id
      and player.alive
  ) then
    v_source_player_id := v_couple.first_lover_player_id;
    v_target_player_id := v_couple.second_lover_player_id;
  elsif not exists (
    select 1 from public.room_players player
    where player.room_id = p_room_id
      and player.id = v_couple.second_lover_player_id
      and player.alive
  ) and exists (
    select 1 from public.room_players player
    where player.room_id = p_room_id
      and player.id = v_couple.first_lover_player_id
      and player.alive
  ) then
    v_source_player_id := v_couple.second_lover_player_id;
    v_target_player_id := v_couple.first_lover_player_id;
  else
    perform private.ms1f_reconcile_cupid_objective(p_room_id, p_day_number);
    return;
  end if;

  insert into private.day_effects (
    vote_id, room_id, day_number, source_type, source_role_id,
    effect_category, target_player_id, source_player_id, couple_id
  ) values (
    p_vote_id, p_room_id, p_day_number, 'LOVER_HEARTBREAK', 'cupid',
    'NON_VILLAIN_LETHAL_EFFECT', v_target_player_id,
    v_source_player_id, v_couple.id
  )
  on conflict (vote_id, source_type) do nothing
  returning id into v_effect_id;

  if v_effect_id is not null then
    update public.room_players
    set alive = false
    where room_id = p_room_id
      and id = v_target_player_id
      and alive;
    insert into private.gameplay_events (
      room_id, night_number, event_type, role_id,
      actor_player_id, target_player_id, resolution, metadata
    ) values (
      p_room_id, p_day_number, 'LOVER_HEARTBREAK_CREATED', 'cupid',
      v_source_player_id, v_target_player_id, 'FINAL_DAY_CONSEQUENCE',
      jsonb_build_object(
        'effectId', v_effect_id,
        'coupleId', v_couple.id,
        'sourceType', 'LOVER_HEARTBREAK',
        'protectorBlockable', false,
        'witchInteractable', false,
        'privateRelationship', true
      )
    );
  end if;

  perform private.ms1f_reconcile_cupid_objective(p_room_id, p_day_number);
end;
$$;

create or replace function private.ms1f_moderator_cupid_action_payload(
  p_call_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_call private.night_role_calls%rowtype;
  v_couple private.cupid_couples%rowtype;
begin
  select * into v_call
  from private.night_role_calls call
  where call.id = p_call_id;
  if not found or cardinality(v_call.eligible_actor_ids) = 0 then return null; end if;
  select * into v_couple
  from private.cupid_couples couple
  where couple.cupid_call_id = v_call.id;
  return jsonb_build_object(
    'id', v_call.id,
    'roleId', 'cupid',
    'kind', 'CUPID_PAIRING',
    'status', case when v_call.status = 'ACTIVE' then 'OPEN' else 'COMPLETED' end,
    'eligibleActorIds', to_jsonb(v_call.eligible_actor_ids),
    'eligibleTargetIds', to_jsonb(v_call.eligible_target_ids),
    'selections', '{}'::jsonb,
    'confirmedActorIds', case when v_couple.id is null
      then '[]'::jsonb else to_jsonb(v_call.eligible_actor_ids) end,
    'cupid', jsonb_build_object(
      'selectedTargetIds', case when v_couple.id is null then '[]'::jsonb
        else jsonb_build_array(
          v_couple.first_lover_player_id,
          v_couple.second_lover_player_id
        ) end
    ),
    'openedAt', v_call.called_at,
    'completedAt', v_call.completed_at
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
    'sourcePlayerId', effect.source_player_id,
    'coupleId', effect.couple_id,
    'category', effect.effect_category,
    'targetPlayerId', effect.target_player_id,
    'lethal', effect.lethal,
    'protectorBlockable', effect.protector_blockable,
    'witchInteractable', effect.witch_interactable,
    'finalized', true,
    'finalizedAt', effect.finalized_at
  ))
  from private.day_effects effect
  where effect.vote_id = p_vote_id
    and effect.source_type = p_source_type;
$$;

create or replace function private.ms1f_day_consequence_effects_payload(
  p_vote_id uuid
)
returns jsonb
language sql
stable
set search_path = ''
as $$
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
    'finalized', true,
    'finalizedAt', effect.finalized_at
  )) order by effect.finalized_at, effect.id), '[]'::jsonb)
  from private.day_effects effect
  where effect.vote_id = p_vote_id
    and effect.source_type = 'LOVER_HEARTBREAK';
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
    'consequenceEffects', private.ms1f_day_consequence_effects_payload(v_vote.id),
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
    'factionTransitions', private.moderator_faction_transition_payload(p_room_id),
    'cupidLovers', private.ms1f_moderator_cupid_payload(p_room_id)
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
        else private.player_night_action_payload(p_room_id, v_user_id)
      end,
      'dayVote', private.player_day_vote_payload(p_room_id, v_user_id)
    )
    || private.ms1f_player_relationship_payload(p_room_id, v_user_id);
end;
$$;

alter table private.cupid_couples enable row level security;
alter table private.lover_reveal_acknowledgements enable row level security;
alter table private.cupid_runtime_objectives enable row level security;

revoke all on table private.cupid_couples from public, anon, authenticated;
revoke all on table private.lover_reveal_acknowledgements from public, anon, authenticated;
revoke all on table private.cupid_runtime_objectives from public, anon, authenticated;

revoke execute on function private.raise_ms1f(text)
  from public, anon, authenticated;
revoke execute on function private.ms1f_player_object(uuid)
  from public, anon, authenticated;
revoke execute on function private.ms1f_moderator_cupid_payload(uuid)
  from public, anon, authenticated;
revoke execute on function private.ms1f_player_relationship_payload(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function private.ms1f_cupid_player_action_payload(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function private.ms1f_reconcile_cupid_objective(uuid, integer)
  from public, anon, authenticated;
revoke execute on function private.ms1f_reconcile_night_death_consequences(uuid, integer, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function private.ms1f_reconcile_day_heartbreak(uuid, integer, uuid)
  from public, anon, authenticated;
revoke execute on function private.ms1f_moderator_cupid_action_payload(uuid)
  from public, anon, authenticated;
revoke execute on function private.ms1f_day_consequence_effects_payload(uuid)
  from public, anon, authenticated;

revoke execute on function public.ms1c_open_witch_call(uuid)
  from public, anon, authenticated;
revoke execute on function public.ms1c_finalize_night_checkpoint(uuid)
  from public, anon, authenticated;
revoke execute on function public.ms1d2_resolve_day_vote(uuid)
  from public, anon, authenticated;
revoke execute on function public.ms1d2_submit_hunter_revenge(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.ms1d2_start_next_night(uuid)
  from public, anon, authenticated;

revoke execute on function public.ms1f_open_cupid_call(uuid)
  from public, anon;
grant execute on function public.ms1f_open_cupid_call(uuid)
  to authenticated;
revoke execute on function public.ms1f_submit_cupid_pairing(uuid, uuid, uuid)
  from public, anon;
grant execute on function public.ms1f_submit_cupid_pairing(uuid, uuid, uuid)
  to authenticated;
revoke execute on function public.ms1f_acknowledge_lover_reveal(uuid)
  from public, anon;
grant execute on function public.ms1f_acknowledge_lover_reveal(uuid)
  to authenticated;
revoke execute on function public.ms1f_open_witch_call(uuid)
  from public, anon;
grant execute on function public.ms1f_open_witch_call(uuid)
  to authenticated;
revoke execute on function public.ms1f_finalize_night_checkpoint(uuid)
  from public, anon;
grant execute on function public.ms1f_finalize_night_checkpoint(uuid)
  to authenticated;
revoke execute on function public.ms1f_resolve_day_vote(uuid)
  from public, anon;
grant execute on function public.ms1f_resolve_day_vote(uuid)
  to authenticated;
revoke execute on function public.ms1f_submit_hunter_revenge(uuid, uuid)
  from public, anon;
grant execute on function public.ms1f_submit_hunter_revenge(uuid, uuid)
  to authenticated;
revoke execute on function public.ms1f_start_next_night(uuid)
  from public, anon;
grant execute on function public.ms1f_start_next_night(uuid)
  to authenticated;

commit;
