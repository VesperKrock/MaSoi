begin;

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
  v_peer_ballots jsonb := '[]'::jsonb;
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

    if cardinality(v_call.eligible_actor_ids) >= 2 then
      select coalesce(jsonb_agg(jsonb_build_object(
        'voter', jsonb_build_object(
          'id', voter.id,
          'seat', voter.seat_number,
          'displayName', voter.display_name,
          'alive', voter.alive
        ),
        'targetId', ballot.target_player_id
      ) order by voter.seat_number), '[]'::jsonb)
      into v_peer_ballots
      from private.wolf_ballots ballot
      join public.room_players voter on voter.id = ballot.voter_player_id
      where ballot.call_id = v_call.id
        and ballot.round = v_call.wolf_round
        and ballot.confirmed
        and ballot.target_player_id is not null
        and ballot.voter_player_id <> v_player.id
        and ballot.voter_player_id = any(v_call.eligible_actor_ids)
        and ballot.target_player_id = any(v_call.eligible_target_ids);
    end if;

    return jsonb_build_object(
      'id', v_call.id,
      'kind', 'WOLF_VOTE',
      'roleId', 'werewolf',
      'roleName', 'Ma Sói',
      'instructions', 'Chọn một mục tiêu hợp lệ để Ma Sói tấn công, rồi xác nhận.',
      'mode', case when v_call.wolf_round = 'REVOTE'
        then 'WOLF_REVOTE' else 'WOLF_BALLOT' end,
      'round', v_call.wolf_round,
      'deadlineAt', v_call.revote_deadline,
      'candidates', v_candidates,
      'currentTargetId', v_target_id,
      'hasSelected', v_has_selection,
      'wolfTeammateBallots', v_peer_ballots
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
  if p_target_player_id is null then perform private.raise_ms1b1('WOLF_TARGET_REQUIRED'); end if;

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
  if not (p_target_player_id = any(v_call.eligible_target_ids)) then
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
      and ballot.target_player_id is not null
      and ballot.target_player_id = any(v_call.eligible_target_ids)
  ) then perform private.raise_ms1b1('WOLF_TARGET_REQUIRED'); end if;

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
    and ballot.confirmed
    and ballot.target_player_id is not null
    and ballot.target_player_id = any(v_call.eligible_target_ids);
  if v_confirmed_count = 0 then
    perform private.raise_ms1b1('WOLF_TARGET_REQUIRED');
  end if;

  select coalesce(max(vote_count), 0) into v_top_count
  from (
    select count(*)::integer as vote_count
    from private.wolf_ballots ballot
    where ballot.call_id = v_call.id
      and ballot.round = v_call.wolf_round
      and ballot.confirmed
      and ballot.target_player_id is not null
      and ballot.target_player_id = any(v_call.eligible_target_ids)
    group by ballot.target_player_id
  ) counts;

  select coalesce(array_agg(target_player_id order by target_player_id), '{}'::uuid[])
  into v_leaders
  from (
    select ballot.target_player_id
    from private.wolf_ballots ballot
    where ballot.call_id = v_call.id
      and ballot.round = v_call.wolf_round
      and ballot.confirmed
      and ballot.target_player_id is not null
      and ballot.target_player_id = any(v_call.eligible_target_ids)
    group by ballot.target_player_id
    having count(*) = v_top_count
  ) leaders;

  if v_call.wolf_round = 'INITIAL' then
    if cardinality(v_leaders) = 1 then
      perform private.complete_wolf_call(
        v_call.id, v_leaders[1], false, 'UNIQUE_TOP', '{}'::uuid[]
      );
    elsif v_room.wolf_policy = 'REVOTE_10S' then
      update private.night_role_calls
      set wolf_round = 'REVOTE',
          initial_tied_target_ids = v_leaders,
          eligible_target_ids = v_leaders,
          revote_deadline = v_now + interval '10 seconds'
      where id = v_call.id;
      insert into private.gameplay_events (
        room_id, night_number, event_type, role_id, metadata
      ) values (
        p_room_id, v_room.day_number, 'WOLF_REVOTE_STARTED', 'werewolf',
        jsonb_build_object(
          'candidateIds', to_jsonb(v_leaders),
          'deadlineAt', v_now + interval '10 seconds'
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

revoke execute on function private.player_night_action_payload(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.ms1b1_submit_wolf_ballot(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.ms1b1_confirm_wolf_ballot(uuid)
  from public, anon, authenticated;
revoke execute on function public.ms1b1_finalize_wolf_round(uuid)
  from public, anon, authenticated;

commit;
