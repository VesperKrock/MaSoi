begin;

create table private.match_results (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  outcome_type text not null check (
    outcome_type in ('FOOL', 'WOLF', 'COUPLE', 'SERIAL_KILLER', 'VILLAGE', 'DRAW')
  ),
  finished_phase text not null check (finished_phase in ('NIGHT', 'DAY')),
  finished_day_number integer not null check (finished_day_number >= 1),
  trigger_type text not null check (trigger_type in (
    'FOOL_DAY_HANGING', 'NIGHT_STABILIZED', 'DAY_STABILIZED', 'START_NIGHT'
  )),
  subject_player_ids uuid[] not null default '{}'::uuid[],
  finished_at timestamptz not null default statement_timestamp(),
  check (
    (outcome_type = 'FOOL' and cardinality(subject_player_ids) = 1)
    or (outcome_type = 'COUPLE' and cardinality(subject_player_ids) = 3)
    or (outcome_type = 'SERIAL_KILLER' and cardinality(subject_player_ids) = 1)
    or (outcome_type in ('WOLF', 'VILLAGE', 'DRAW') and cardinality(subject_player_ids) = 0)
  )
);

alter table private.match_results enable row level security;
revoke all on table private.match_results from public, anon, authenticated;

alter table private.gameplay_events
  drop constraint if exists gameplay_events_event_type_check;
alter table private.gameplay_events
  add constraint gameplay_events_event_type_check check (event_type in (
    'ROLE_CALLED', 'CALL_COMPLETED', 'WOLF_REVOTE_STARTED',
    'WOLF_FINAL_TARGET', 'SEER_INSPECTION', 'SEER_RESULT_ACKNOWLEDGED',
    'PROTECTOR_INTENT', 'WOLF_ATTACK_CREATED', 'WOLF_ATTACK_BLOCKED',
    'WOLF_ATTACK_IMMUNE', 'SERIAL_KILLER_TARGET_LOCKED',
    'SERIAL_KILLER_ATTACK_CREATED', 'SERIAL_KILLER_ATTACK_BLOCKED',
    'NIGHT_DEATH_CANDIDATE_CREATED', 'NIGHT_RESOLUTION_COMPLETED',
    'HUNTER_TARGET_LOCKED', 'HUNTER_SHOT_CREATED',
    'HUNTER_SHOT_ACTIVATED', 'HUNTER_SHOT_CANCELED',
    'HUNTER_SHOT_VICTIM_RESCUED', 'WITCH_DECISION_SUBMITTED',
    'WITCH_RESURRECTION_USED', 'WITCH_POISON_USED',
    'WITCH_CHECKPOINT_COMPLETED', 'NIGHT_DEATH_FINALIZED',
    'MORNING_STARTED', 'DAY_VOTE_OPENED', 'DAY_VOTE_CHANGED',
    'DAY_VOTE_RESOLVED', 'DAY_HANGING_CREATED',
    'HUNTER_HANGING_REVEALED', 'HUNTER_REVENGE_RESOLVED',
    'NEXT_NIGHT_STARTED', 'HALF_WOLF_BITE_SCHEDULED',
    'HALF_WOLF_TRANSFORMED', 'HALF_WOLF_TRANSFORMATION_CANCELED',
    'TRAITOR_CONVERTED_TO_VILLAGE', 'CUPID_PAIR_CREATED',
    'LOVER_REVEAL_ACKNOWLEDGED', 'LOVER_HEARTBREAK_CREATED',
    'CUPID_OBJECTIVE_FALLBACK', 'MATCH_FINISHED'
  ));

create or replace function private.raise_ms1g2(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end;
$$;

create or replace function private.ms1g2_assert_match_active(p_room_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_status text;
begin
  select room.status into v_status
  from public.rooms room where room.id = p_room_id;
  if not found then perform private.raise_ms1g2('ROOM_NOT_FOUND'); end if;
  if v_status = 'FINISHED' or exists (
    select 1 from private.match_results result where result.room_id = p_room_id
  ) then perform private.raise_ms1g2('MATCH_FINISHED'); end if;
end;
$$;

create or replace function private.ms1g2_match_result_payload(p_room_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when result.room_id is null then null else jsonb_build_object(
    'outcome', result.outcome_type,
    'finishedAt', result.finished_at,
    'finishedPhase', result.finished_phase,
    'dayNumber', result.finished_day_number,
    'trigger', result.trigger_type
  ) end
  from (select p_room_id as requested_room_id) requested
  left join private.match_results result
    on result.room_id = requested.requested_room_id;
$$;

create or replace function private.ms1g2_persist_match_result(
  p_room_id uuid,
  p_outcome_type text,
  p_trigger_type text,
  p_subject_player_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_inserted boolean := false;
begin
  select * into v_room from public.rooms room
  where room.id = p_room_id for update;
  if not found then perform private.raise_ms1g2('ROOM_NOT_FOUND'); end if;
  if v_room.phase not in ('NIGHT', 'DAY') then
    perform private.raise_ms1g2('WIN_CHECKPOINT_NOT_STABLE');
  end if;

  insert into private.match_results (
    room_id, outcome_type, finished_phase, finished_day_number,
    trigger_type, subject_player_ids
  ) values (
    p_room_id, p_outcome_type, v_room.phase, v_room.day_number,
    p_trigger_type, coalesce(p_subject_player_ids, '{}'::uuid[])
  ) on conflict (room_id) do nothing;
  v_inserted := found;

  if v_inserted then
    update public.rooms
    set status = 'FINISHED', phase = 'ENDED', revision = revision + 1,
        updated_at = statement_timestamp()
    where id = p_room_id;
    insert into private.gameplay_events (
      room_id, night_number, event_type, resolution, metadata
    ) values (
      p_room_id, v_room.day_number, 'MATCH_FINISHED', p_outcome_type,
      jsonb_strip_nulls(jsonb_build_object(
        'trigger', p_trigger_type,
        'subjectPlayerIds', to_jsonb(coalesce(p_subject_player_ids, '{}'::uuid[])),
        'message', case when p_outcome_type = 'DRAW'
          then 'Cả làng bị xóa sổ.' else null end
      ))
    );
  end if;
  return private.ms1g2_match_result_payload(p_room_id);
end;
$$;

create or replace function private.ms1g2_resolve_global_win(
  p_room_id uuid,
  p_trigger_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_living_count integer;
  v_bite_capable_count integer;
  v_runtime_village_count integer;
  v_serial_killer_count integer;
  v_pending_half_wolf_count integer;
  v_couple private.cupid_couples%rowtype;
  v_cupid_objective private.cupid_runtime_objectives%rowtype;
  v_subjects uuid[];
begin
  select * into v_room from public.rooms room
  where room.id = p_room_id for update;
  if not found then perform private.raise_ms1g2('ROOM_NOT_FOUND'); end if;
  if exists (
    select 1 from private.match_results result where result.room_id = p_room_id
  ) then return private.ms1g2_match_result_payload(p_room_id); end if;
  if p_trigger_type not in ('NIGHT_STABILIZED', 'DAY_STABILIZED', 'START_NIGHT') then
    perform private.raise_ms1g2('WIN_CHECKPOINT_NOT_STABLE');
  end if;
  if v_room.phase not in ('NIGHT', 'DAY') then
    perform private.raise_ms1g2('WIN_CHECKPOINT_NOT_STABLE');
  end if;

  perform private.ms1e_reconcile_faction_transitions(
    p_room_id,
    case when p_trigger_type = 'START_NIGHT' then 'START_NIGHT' else 'AFTER_DEATH' end,
    v_room.day_number
  );
  perform private.ms1f_reconcile_cupid_objective(p_room_id, v_room.day_number);

  select
    count(*) filter (where player.alive),
    count(*) filter (where player.alive and (
      assignment.role_id = 'werewolf' or (
        assignment.role_id = 'half-wolf' and exists (
          select 1 from private.half_wolf_transitions transition
          where transition.room_id = p_room_id
            and transition.player_id = player.id
            and transition.status = 'TRANSFORMED'
        )
      )
    )),
    count(*) filter (where player.alive and assignment.role_id = 'serial-killer'),
    count(*) filter (where player.alive and (
      assignment.role_id not in ('werewolf', 'serial-killer', 'half-wolf', 'traitor')
      or (assignment.role_id = 'half-wolf' and not exists (
        select 1 from private.half_wolf_transitions transition
        where transition.room_id = p_room_id
          and transition.player_id = player.id
          and transition.status = 'TRANSFORMED'
      ))
      or (assignment.role_id = 'traitor' and exists (
        select 1 from private.traitor_faction_transitions transition
        where transition.room_id = p_room_id
          and transition.player_id = player.id
      ))
    )),
    count(*) filter (where player.alive and assignment.role_id = 'half-wolf'
      and exists (
        select 1 from private.half_wolf_transitions transition
        where transition.room_id = p_room_id
          and transition.player_id = player.id
          and transition.status = 'PENDING_TRANSFORMATION'
      ))
  into v_living_count, v_bite_capable_count, v_serial_killer_count,
       v_runtime_village_count, v_pending_half_wolf_count
  from public.room_players player
  join public.room_role_assignments assignment
    on assignment.room_id = player.room_id
    and assignment.player_id = player.id
  where player.room_id = p_room_id;

  if v_bite_capable_count > 0
    and v_bite_capable_count >= v_runtime_village_count
    and v_serial_killer_count = 0
  then
    return private.ms1g2_persist_match_result(
      p_room_id, 'WOLF', p_trigger_type, '{}'::uuid[]
    );
  end if;

  select * into v_couple from private.cupid_couples couple
  where couple.room_id = p_room_id;
  select * into v_cupid_objective from private.cupid_runtime_objectives objective
  where objective.room_id = p_room_id;
  if v_living_count = 3 and v_couple.id is not null
    and v_cupid_objective.status = 'ACTIVE'
    and exists (select 1 from public.room_players player where player.room_id = p_room_id and player.id = v_couple.cupid_player_id and player.alive)
    and exists (select 1 from public.room_players player where player.room_id = p_room_id and player.id = v_couple.first_lover_player_id and player.alive)
    and exists (select 1 from public.room_players player where player.room_id = p_room_id and player.id = v_couple.second_lover_player_id and player.alive)
  then
    v_subjects := array[
      v_couple.cupid_player_id,
      v_couple.first_lover_player_id,
      v_couple.second_lover_player_id
    ];
    return private.ms1g2_persist_match_result(
      p_room_id, 'COUPLE', p_trigger_type, v_subjects
    );
  end if;

  if v_living_count = 1 and v_serial_killer_count = 1 then
    select array_agg(player.id) into v_subjects
    from public.room_players player
    join public.room_role_assignments assignment
      on assignment.room_id = player.room_id and assignment.player_id = player.id
    where player.room_id = p_room_id and player.alive
      and assignment.role_id = 'serial-killer';
    return private.ms1g2_persist_match_result(
      p_room_id, 'SERIAL_KILLER', p_trigger_type, v_subjects
    );
  end if;
  if v_living_count = 0 then
    return private.ms1g2_persist_match_result(
      p_room_id, 'DRAW', p_trigger_type, '{}'::uuid[]
    );
  end if;
  if v_living_count > 0 and v_bite_capable_count = 0
    and v_serial_killer_count = 0 and v_pending_half_wolf_count = 0
  then
    return private.ms1g2_persist_match_result(
      p_room_id, 'VILLAGE', p_trigger_type, '{}'::uuid[]
    );
  end if;
  return null;
end;
$$;

create or replace function private.ms1g2_finish_fool_hanging(
  p_room_id uuid,
  p_hanged_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
begin
  select * into v_room from public.rooms room
  where room.id = p_room_id for update;
  if exists (
    select 1 from private.match_results result where result.room_id = p_room_id
  ) then return private.ms1g2_match_result_payload(p_room_id); end if;
  if v_room.phase <> 'DAY' or not exists (
    select 1
    from private.day_vote_rounds vote
    join private.day_effects effect on effect.vote_id = vote.id
    join public.room_role_assignments assignment
      on assignment.room_id = vote.room_id
      and assignment.player_id = vote.hanged_player_id
    where vote.room_id = p_room_id
      and vote.day_number = v_room.day_number
      and vote.status = 'RESOLVED'
      and vote.hanged_player_id = p_hanged_player_id
      and effect.source_type = 'DAY_HANGING'
      and effect.target_player_id = p_hanged_player_id
      and assignment.role_id = 'fool'
  ) then perform private.raise_ms1g2('FOOL_HANGING_NOT_AUTHORITATIVE'); end if;
  return private.ms1g2_persist_match_result(
    p_room_id, 'FOOL', 'FOOL_DAY_HANGING', array[p_hanged_player_id]
  );
end;
$$;

-- Every gameplay mutation exposed to the browser passes through an active-match
-- guard. The historical functions remain implementation details and are
-- revoked from authenticated callers at the end of this migration.
create or replace function public.ms1g2_start_room(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_payload jsonb;
begin
  perform private.ms1g2_assert_match_active(p_room_id);
  v_payload := public.ms1a_start_room(p_room_id);
  perform private.ms1g2_resolve_global_win(p_room_id, 'START_NIGHT');
  return public.ms1a_get_moderator_room(p_room_id);
end;
$$;

create or replace function public.ms1g2_open_night_role_call(p_room_id uuid, p_role_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1b1_open_night_role_call(p_room_id, p_role_id); end;
$$;
create or replace function public.ms1g2_complete_empty_night_role_call(p_room_id uuid, p_role_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1b1_complete_empty_night_role_call(p_room_id, p_role_id); end;
$$;
create or replace function public.ms1g2_submit_wolf_ballot(p_room_id uuid, p_target_player_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1b1_submit_wolf_ballot(p_room_id, p_target_player_id); end;
$$;
create or replace function public.ms1g2_confirm_wolf_ballot(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1b1_confirm_wolf_ballot(p_room_id); end;
$$;
create or replace function public.ms1g2_finalize_wolf_round(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1b1_finalize_wolf_round(p_room_id); end;
$$;
create or replace function public.ms1g2_submit_seer_inspection(p_room_id uuid, p_target_player_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1b1_submit_seer_inspection(p_room_id, p_target_player_id); end;
$$;
create or replace function public.ms1g2_acknowledge_seer_result(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1b1_acknowledge_seer_result(p_room_id); end;
$$;
create or replace function public.ms1g2_submit_protector_target(p_room_id uuid, p_target_player_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1b1_submit_protector_target(p_room_id, p_target_player_id); end;
$$;

create or replace function public.ms1g2_open_hunter_call(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1d1_open_hunter_call(p_room_id); end;
$$;
create or replace function public.ms1g2_submit_hunter_prelock(p_room_id uuid, p_target_player_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1d1_submit_hunter_prelock(p_room_id, p_target_player_id); end;
$$;
create or replace function public.ms1g2_confirm_hunter_prelock(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1d1_confirm_hunter_prelock(p_room_id); end;
$$;

create or replace function public.ms1g2_open_cupid_call(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1f_open_cupid_call(p_room_id); end;
$$;
create or replace function public.ms1g2_submit_cupid_pairing(
  p_room_id uuid, p_first_target_player_id uuid, p_second_target_player_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1f_submit_cupid_pairing(
  p_room_id, p_first_target_player_id, p_second_target_player_id
); end;
$$;
create or replace function public.ms1g2_acknowledge_lover_reveal(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1f_acknowledge_lover_reveal(p_room_id); end;
$$;

create or replace function public.ms1g2_open_serial_killer_call(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1g1_open_serial_killer_call(p_room_id); end;
$$;
create or replace function public.ms1g2_submit_serial_killer_intent(p_room_id uuid, p_target_player_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1g1_submit_serial_killer_intent(p_room_id, p_target_player_id); end;
$$;
create or replace function public.ms1g2_confirm_serial_killer_intent(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1g1_confirm_serial_killer_intent(p_room_id); end;
$$;

create or replace function public.ms1g2_resolve_night_effects(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1b2_resolve_night_effects(p_room_id); end;
$$;
create or replace function public.ms1g2_open_witch_call(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1f_open_witch_call(p_room_id); end;
$$;
create or replace function public.ms1g2_submit_witch_decision(
  p_room_id uuid, p_resurrection_target_id uuid, p_poison_target_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1c_submit_witch_decision(
  p_room_id, p_resurrection_target_id, p_poison_target_id
); end;
$$;

create or replace function public.ms1g2_finalize_night_checkpoint(p_room_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := private.require_auth_uid();
begin
  if not exists (select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id)
  then perform private.raise_ms1g2('NOT_MODERATOR'); end if;
  if exists (select 1 from private.match_results result where result.room_id = p_room_id)
  then return public.ms1a_get_moderator_room(p_room_id); end if;
  perform private.ms1g2_assert_match_active(p_room_id);
  perform public.ms1f_finalize_night_checkpoint(p_room_id);
  perform private.ms1g2_resolve_global_win(p_room_id, 'NIGHT_STABILIZED');
  return public.ms1a_get_moderator_room(p_room_id);
end;
$$;

create or replace function public.ms1g2_start_morning(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1d1_start_morning(p_room_id); end;
$$;
create or replace function public.ms1g2_start_day_vote(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1d2_start_day_vote(p_room_id); end;
$$;
create or replace function public.ms1g2_cast_day_vote(p_room_id uuid, p_target_player_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin perform private.ms1g2_assert_match_active(p_room_id);
return public.ms1d2_cast_day_vote(p_room_id, p_target_player_id); end;
$$;

create or replace function public.ms1g2_resolve_day_vote(p_room_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_vote private.day_vote_rounds%rowtype;
  v_hanged_role text;
begin
  select * into v_room from public.rooms room
  where room.id = p_room_id for update;
  if not found then perform private.raise_ms1g2('ROOM_NOT_FOUND'); end if;
  if not exists (select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id)
  then perform private.raise_ms1g2('NOT_MODERATOR'); end if;
  if exists (select 1 from private.match_results result where result.room_id = p_room_id)
  then return public.ms1a_get_moderator_room(p_room_id); end if;
  perform private.ms1g2_assert_match_active(p_room_id);

  perform public.ms1d2_resolve_day_vote(p_room_id);
  select * into v_vote from private.day_vote_rounds vote
  where vote.room_id = p_room_id and vote.day_number = v_room.day_number;
  if v_vote.hanged_player_id is not null then
    select assignment.role_id into v_hanged_role
    from public.room_role_assignments assignment
    where assignment.room_id = p_room_id
      and assignment.player_id = v_vote.hanged_player_id;
    if v_hanged_role = 'fool' then
      perform private.ms1g2_finish_fool_hanging(p_room_id, v_vote.hanged_player_id);
      return public.ms1a_get_moderator_room(p_room_id);
    end if;
  end if;

  perform private.ms1f_reconcile_day_heartbreak(
    p_room_id, v_room.day_number, v_vote.id
  );
  if not exists (
    select 1 from private.hunter_day_revenge revenge
    where revenge.vote_id = v_vote.id and revenge.status = 'PENDING'
  ) then
    perform private.ms1g2_resolve_global_win(p_room_id, 'DAY_STABILIZED');
  end if;
  perform private.touch_gameplay_room(p_room_id);
  return public.ms1a_get_moderator_room(p_room_id);
end;
$$;

create or replace function public.ms1g2_submit_hunter_revenge(
  p_room_id uuid, p_target_player_id uuid
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := private.require_auth_uid();
begin
  if exists (select 1 from private.match_results result where result.room_id = p_room_id)
  then return public.ms1a_get_player_room(p_room_id); end if;
  perform private.ms1g2_assert_match_active(p_room_id);
  perform public.ms1f_submit_hunter_revenge(p_room_id, p_target_player_id);
  perform private.ms1g2_resolve_global_win(p_room_id, 'DAY_STABILIZED');
  return public.ms1a_get_player_room(p_room_id);
end;
$$;

create or replace function public.ms1g2_start_next_night(p_room_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := private.require_auth_uid();
begin
  if not exists (select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id)
  then perform private.raise_ms1g2('NOT_MODERATOR'); end if;
  if exists (select 1 from private.match_results result where result.room_id = p_room_id)
  then return public.ms1a_get_moderator_room(p_room_id); end if;
  perform private.ms1g2_assert_match_active(p_room_id);
  perform public.ms1f_start_next_night(p_room_id);
  perform private.ms1g2_resolve_global_win(p_room_id, 'START_NIGHT');
  return public.ms1a_get_moderator_room(p_room_id);
end;
$$;

create or replace function public.ms1a_get_moderator_room(p_room_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_payload jsonb;
  v_alive_player_ids jsonb;
begin
  if not exists (select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id)
  then perform private.raise_ms1a('NOT_MODERATOR'); end if;
  v_payload := private.moderator_room_payload(p_room_id);
  select coalesce(jsonb_agg(player.id order by player.seat_number)
    filter (where player.alive), '[]'::jsonb)
  into v_alive_player_ids from public.room_players player
  where player.room_id = p_room_id;
  return v_payload || jsonb_build_object(
    'alivePlayerIds', v_alive_player_ids,
    'night', private.moderator_night_payload(p_room_id),
    'nightResolution', private.moderator_night_resolution_payload(p_room_id),
    'witchCheckpoint', private.moderator_witch_checkpoint_payload(p_room_id),
    'dayVote', private.moderator_day_vote_payload(p_room_id),
    'factionTransitions', private.moderator_faction_transition_payload(p_room_id),
    'cupidLovers', private.ms1f_moderator_cupid_payload(p_room_id),
    'matchResult', private.ms1g2_match_result_payload(p_room_id)
  );
end;
$$;

create or replace function public.ms1a_get_player_room(p_room_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
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
      'dayVote', private.player_day_vote_payload(p_room_id, v_user_id),
      'matchResult', private.ms1g2_match_result_payload(p_room_id)
    )
    || private.ms1f_player_relationship_payload(p_room_id, v_user_id);
end;
$$;

revoke execute on function private.raise_ms1g2(text) from public, anon, authenticated;
revoke execute on function private.ms1g2_assert_match_active(uuid) from public, anon, authenticated;
revoke execute on function private.ms1g2_match_result_payload(uuid) from public, anon, authenticated;
revoke execute on function private.ms1g2_persist_match_result(uuid, text, text, uuid[]) from public, anon, authenticated;
revoke execute on function private.ms1g2_resolve_global_win(uuid, text) from public, anon, authenticated;
revoke execute on function private.ms1g2_finish_fool_hanging(uuid, uuid) from public, anon, authenticated;

-- Historical mutation endpoints cannot bypass the terminal guard.
revoke execute on function public.ms1a_start_room(uuid) from public, anon, authenticated;
revoke execute on function public.ms1b1_open_night_role_call(uuid, text) from public, anon, authenticated;
revoke execute on function public.ms1b1_complete_empty_night_role_call(uuid, text) from public, anon, authenticated;
revoke execute on function public.ms1b1_submit_wolf_ballot(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ms1b1_confirm_wolf_ballot(uuid) from public, anon, authenticated;
revoke execute on function public.ms1b1_finalize_wolf_round(uuid) from public, anon, authenticated;
revoke execute on function public.ms1b1_submit_seer_inspection(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ms1b1_acknowledge_seer_result(uuid) from public, anon, authenticated;
revoke execute on function public.ms1b1_submit_protector_target(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ms1d1_open_hunter_call(uuid) from public, anon, authenticated;
revoke execute on function public.ms1d1_submit_hunter_prelock(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ms1d1_confirm_hunter_prelock(uuid) from public, anon, authenticated;
revoke execute on function public.ms1f_open_cupid_call(uuid) from public, anon, authenticated;
revoke execute on function public.ms1f_submit_cupid_pairing(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ms1f_acknowledge_lover_reveal(uuid) from public, anon, authenticated;
revoke execute on function public.ms1g1_open_serial_killer_call(uuid) from public, anon, authenticated;
revoke execute on function public.ms1g1_submit_serial_killer_intent(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ms1g1_confirm_serial_killer_intent(uuid) from public, anon, authenticated;
revoke execute on function public.ms1b2_resolve_night_effects(uuid) from public, anon, authenticated;
revoke execute on function public.ms1f_open_witch_call(uuid) from public, anon, authenticated;
revoke execute on function public.ms1c_submit_witch_decision(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ms1f_finalize_night_checkpoint(uuid) from public, anon, authenticated;
revoke execute on function public.ms1d1_start_morning(uuid) from public, anon, authenticated;
revoke execute on function public.ms1d2_start_day_vote(uuid) from public, anon, authenticated;
revoke execute on function public.ms1d2_cast_day_vote(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ms1f_resolve_day_vote(uuid) from public, anon, authenticated;
revoke execute on function public.ms1f_submit_hunter_revenge(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.ms1f_start_next_night(uuid) from public, anon, authenticated;

revoke execute on function public.ms1g2_start_room(uuid) from public, anon;
grant execute on function public.ms1g2_start_room(uuid) to authenticated;
revoke execute on function public.ms1g2_open_night_role_call(uuid, text) from public, anon;
grant execute on function public.ms1g2_open_night_role_call(uuid, text) to authenticated;
revoke execute on function public.ms1g2_complete_empty_night_role_call(uuid, text) from public, anon;
grant execute on function public.ms1g2_complete_empty_night_role_call(uuid, text) to authenticated;
revoke execute on function public.ms1g2_submit_wolf_ballot(uuid, uuid) from public, anon;
grant execute on function public.ms1g2_submit_wolf_ballot(uuid, uuid) to authenticated;
revoke execute on function public.ms1g2_confirm_wolf_ballot(uuid) from public, anon;
grant execute on function public.ms1g2_confirm_wolf_ballot(uuid) to authenticated;
revoke execute on function public.ms1g2_finalize_wolf_round(uuid) from public, anon;
grant execute on function public.ms1g2_finalize_wolf_round(uuid) to authenticated;
revoke execute on function public.ms1g2_submit_seer_inspection(uuid, uuid) from public, anon;
grant execute on function public.ms1g2_submit_seer_inspection(uuid, uuid) to authenticated;
revoke execute on function public.ms1g2_acknowledge_seer_result(uuid) from public, anon;
grant execute on function public.ms1g2_acknowledge_seer_result(uuid) to authenticated;
revoke execute on function public.ms1g2_submit_protector_target(uuid, uuid) from public, anon;
grant execute on function public.ms1g2_submit_protector_target(uuid, uuid) to authenticated;
revoke execute on function public.ms1g2_open_hunter_call(uuid) from public, anon;
grant execute on function public.ms1g2_open_hunter_call(uuid) to authenticated;
revoke execute on function public.ms1g2_submit_hunter_prelock(uuid, uuid) from public, anon;
grant execute on function public.ms1g2_submit_hunter_prelock(uuid, uuid) to authenticated;
revoke execute on function public.ms1g2_confirm_hunter_prelock(uuid) from public, anon;
grant execute on function public.ms1g2_confirm_hunter_prelock(uuid) to authenticated;
revoke execute on function public.ms1g2_open_cupid_call(uuid) from public, anon;
grant execute on function public.ms1g2_open_cupid_call(uuid) to authenticated;
revoke execute on function public.ms1g2_submit_cupid_pairing(uuid, uuid, uuid) from public, anon;
grant execute on function public.ms1g2_submit_cupid_pairing(uuid, uuid, uuid) to authenticated;
revoke execute on function public.ms1g2_acknowledge_lover_reveal(uuid) from public, anon;
grant execute on function public.ms1g2_acknowledge_lover_reveal(uuid) to authenticated;
revoke execute on function public.ms1g2_open_serial_killer_call(uuid) from public, anon;
grant execute on function public.ms1g2_open_serial_killer_call(uuid) to authenticated;
revoke execute on function public.ms1g2_submit_serial_killer_intent(uuid, uuid) from public, anon;
grant execute on function public.ms1g2_submit_serial_killer_intent(uuid, uuid) to authenticated;
revoke execute on function public.ms1g2_confirm_serial_killer_intent(uuid) from public, anon;
grant execute on function public.ms1g2_confirm_serial_killer_intent(uuid) to authenticated;
revoke execute on function public.ms1g2_resolve_night_effects(uuid) from public, anon;
grant execute on function public.ms1g2_resolve_night_effects(uuid) to authenticated;
revoke execute on function public.ms1g2_open_witch_call(uuid) from public, anon;
grant execute on function public.ms1g2_open_witch_call(uuid) to authenticated;
revoke execute on function public.ms1g2_submit_witch_decision(uuid, uuid, uuid) from public, anon;
grant execute on function public.ms1g2_submit_witch_decision(uuid, uuid, uuid) to authenticated;
revoke execute on function public.ms1g2_finalize_night_checkpoint(uuid) from public, anon;
grant execute on function public.ms1g2_finalize_night_checkpoint(uuid) to authenticated;
revoke execute on function public.ms1g2_start_morning(uuid) from public, anon;
grant execute on function public.ms1g2_start_morning(uuid) to authenticated;
revoke execute on function public.ms1g2_start_day_vote(uuid) from public, anon;
grant execute on function public.ms1g2_start_day_vote(uuid) to authenticated;
revoke execute on function public.ms1g2_cast_day_vote(uuid, uuid) from public, anon;
grant execute on function public.ms1g2_cast_day_vote(uuid, uuid) to authenticated;
revoke execute on function public.ms1g2_resolve_day_vote(uuid) from public, anon;
grant execute on function public.ms1g2_resolve_day_vote(uuid) to authenticated;
revoke execute on function public.ms1g2_submit_hunter_revenge(uuid, uuid) from public, anon;
grant execute on function public.ms1g2_submit_hunter_revenge(uuid, uuid) to authenticated;
revoke execute on function public.ms1g2_start_next_night(uuid) from public, anon;
grant execute on function public.ms1g2_start_next_night(uuid) to authenticated;

commit;
