begin;

-- H1 does not create new game truth. It projects the immutable G2 result and
-- existing authoritative assignment/relationship/runtime tables only after
-- the room is terminal.
create or replace function private.ms1h1_final_reveal_payload(p_room_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_result private.match_results%rowtype;
begin
  select result.* into v_result
  from private.match_results result
  join public.rooms room on room.id = result.room_id
  where result.room_id = p_room_id
    and room.status = 'FINISHED'
    and room.phase = 'ENDED';
  if not found then return null; end if;

  return jsonb_build_object(
    'outcome', v_result.outcome_type,
    'subjects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', player.id,
        'seat', player.seat_number,
        'displayName', player.display_name,
        'alive', player.alive
      ) order by subject.ordinality)
      from unnest(v_result.subject_player_ids) with ordinality
        as subject(player_id, ordinality)
      join public.room_players player
        on player.room_id = p_room_id
        and player.id = subject.player_id
    ), '[]'::jsonb),
    'roster', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'player', jsonb_build_object(
          'id', player.id,
          'seat', player.seat_number,
          'displayName', player.display_name,
          'alive', player.alive
        ),
        'roleId', assignment.role_id,
        'runtimeNote', case
          when assignment.role_id = 'half-wolf' and exists (
            select 1 from private.half_wolf_transitions transition
            where transition.room_id = p_room_id
              and transition.player_id = player.id
              and transition.status = 'TRANSFORMED'
          ) then 'HALF_WOLF_TRANSFORMED'
          when assignment.role_id = 'traitor' and exists (
            select 1 from private.traitor_faction_transitions transition
            where transition.room_id = p_room_id
              and transition.player_id = player.id
          ) then 'TRAITOR_CONVERTED_VILLAGE'
          else null
        end,
        'loverPartnerPlayerId', case
          when player.id = couple.first_lover_player_id
            then couple.second_lover_player_id
          when player.id = couple.second_lover_player_id
            then couple.first_lover_player_id
          else null
        end
      )) order by player.seat_number)
      from public.room_players player
      join public.room_role_assignments assignment
        on assignment.room_id = player.room_id
        and assignment.player_id = player.id
      left join private.cupid_couples couple on couple.room_id = player.room_id
      where player.room_id = p_room_id
    ), '[]'::jsonb),
    'couple', (
      select jsonb_build_object(
        'cupidPlayerId', couple.cupid_player_id,
        'loverPlayerIds', jsonb_build_array(
          couple.first_lover_player_id,
          couple.second_lover_player_id
        )
      )
      from private.cupid_couples couple
      where couple.room_id = p_room_id
    )
  );
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
    'matchResult', private.ms1g2_match_result_payload(p_room_id),
    'endMatch', private.ms1h1_final_reveal_payload(p_room_id)
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
      'matchResult', private.ms1g2_match_result_payload(p_room_id),
      'endMatch', private.ms1h1_final_reveal_payload(p_room_id)
    )
    || private.ms1f_player_relationship_payload(p_room_id, v_user_id);
end;
$$;

revoke execute on function private.ms1h1_final_reveal_payload(uuid)
  from public, anon, authenticated;

commit;
