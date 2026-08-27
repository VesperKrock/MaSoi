begin;

-- H2 is a read model over durable gameplay truth. It stores no narrative text
-- and creates no competing event authority. Only the owner-checked Moderator
-- room projection below can reach this private helper.
create or replace function private.ms1h2_moderator_journal_payload(p_room_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with meaningful_event as (
    select
      event.*,
      case
        when event.event_type = 'MATCH_FINISHED' then 'RESULT'
        when event.event_type in (
          'DAY_VOTE_OPENED',
          'DAY_VOTE_RESOLVED',
          'DAY_HANGING_CREATED',
          'HUNTER_REVENGE_RESOLVED'
        ) then 'DAY'
        when event.event_type = 'LOVER_HEARTBREAK_CREATED'
          and event.resolution = 'FINAL_DAY_CONSEQUENCE' then 'DAY'
        when event.event_type = 'TRAITOR_CONVERTED_TO_VILLAGE'
          and exists (
            select 1
            from private.day_vote_rounds vote
            where vote.room_id = event.room_id
              and vote.day_number = event.night_number
              and vote.opened_at <= event.created_at
          ) then 'DAY'
        else 'NIGHT'
      end as journal_phase
    from private.gameplay_events event
    where event.room_id = p_room_id
      and event.event_type in (
        'WOLF_REVOTE_STARTED',
        'WOLF_FINAL_TARGET',
        'PROTECTOR_INTENT',
        'SEER_INSPECTION',
        'WOLF_ATTACK_CREATED',
        'SERIAL_KILLER_ATTACK_CREATED',
        'WITCH_RESURRECTION_USED',
        'WITCH_POISON_USED',
        'NIGHT_DEATH_FINALIZED',
        'HUNTER_SHOT_ACTIVATED',
        'CUPID_PAIR_CREATED',
        'LOVER_HEARTBREAK_CREATED',
        'HALF_WOLF_BITE_SCHEDULED',
        'HALF_WOLF_TRANSFORMED',
        'TRAITOR_CONVERTED_TO_VILLAGE',
        'DAY_VOTE_OPENED',
        'DAY_VOTE_RESOLVED',
        'DAY_HANGING_CREATED',
        'HUNTER_REVENGE_RESOLVED',
        'MATCH_FINISHED'
      )
  ),
  projected_fact as (
    select
      event.id,
      event.created_at,
      jsonb_strip_nulls(jsonb_build_object(
        'id', event.id,
        'phase', event.journal_phase,
        'cycleNumber', event.night_number,
        'kind', event.event_type,
        'occurredAt', event.created_at,
        'actorName', actor.display_name,
        'targetName', target.display_name,
        'relatedNames', case
          when event.event_type = 'CUPID_PAIR_CREATED' then (
            select coalesce(
              jsonb_agg(player.display_name order by related.ordinality),
              '[]'::jsonb
            )
            from jsonb_array_elements_text(event.metadata -> 'loverPlayerIds')
              with ordinality as related(player_id, ordinality)
            join public.room_players player
              on player.room_id = event.room_id
              and player.id = related.player_id::uuid
          )
          else null
        end,
        'resolution', event.resolution,
        'totals', case
          when event.event_type = 'DAY_VOTE_RESOLVED' then (
            select coalesce(jsonb_agg(jsonb_build_object(
              'targetName', player.display_name,
              'total', total.weighted_total
            ) order by total.weighted_total desc, player.seat_number), '[]'::jsonb)
            from private.day_vote_rounds vote
            join private.day_vote_result_totals total on total.vote_id = vote.id
            join public.room_players player
              on player.room_id = vote.room_id
              and player.id = total.target_player_id
            where vote.room_id = event.room_id
              and vote.day_number = event.night_number
          )
          else null
        end,
        'sourceTypes', case
          when event.event_type = 'NIGHT_DEATH_FINALIZED' then (
            select coalesce(
              jsonb_agg(distinct effect.source_type order by effect.source_type),
              '[]'::jsonb
            )
            from private.night_final_deaths death
            join private.night_effects effect
              on effect.id = death.source_effect_id
              and effect.room_id = death.room_id
              and effect.night_number = death.night_number
              and effect.target_player_id = death.player_id
            where death.room_id = event.room_id
              and death.night_number = event.night_number
              and death.player_id = event.target_player_id
          )
          else null
        end,
        'random', case
          when event.event_type = 'WOLF_FINAL_TARGET'
            then coalesce((event.metadata ->> 'random')::boolean, false)
          else null
        end
      )) as payload
    from meaningful_event event
    left join public.room_players actor
      on actor.room_id = event.room_id
      and actor.id = event.actor_player_id
    left join public.room_players target
      on target.room_id = event.room_id
      and target.id = event.target_player_id
  )
  select jsonb_build_object(
    'facts', coalesce(
      jsonb_agg(fact.payload order by fact.created_at, fact.id),
      '[]'::jsonb
    )
  )
  from projected_fact fact;
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
    'endMatch', private.ms1h1_final_reveal_payload(p_room_id),
    'moderatorJournal', private.ms1h2_moderator_journal_payload(p_room_id)
  );
end;
$$;

revoke execute on function private.ms1h2_moderator_journal_payload(uuid)
  from public, anon, authenticated;

commit;
