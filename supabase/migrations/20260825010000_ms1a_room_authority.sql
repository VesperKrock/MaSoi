begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.classic_roles (
  id text primary key,
  display_name text not null,
  quantity_mode text not null check (quantity_mode in ('MULTIPLE', 'SINGLE'))
);

insert into public.classic_roles (id, display_name, quantity_mode) values
  ('villager', 'Dân Làng', 'MULTIPLE'),
  ('protector', 'Bảo Vệ', 'SINGLE'),
  ('witch', 'Phù Thủy', 'SINGLE'),
  ('cupid', 'Thần Tình Yêu', 'SINGLE'),
  ('mayor', 'Thị Trưởng', 'SINGLE'),
  ('hunter', 'Thợ Săn', 'SINGLE'),
  ('seer', 'Tiên Tri', 'SINGLE'),
  ('werewolf', 'Ma Sói', 'MULTIPLE'),
  ('traitor', 'Kẻ Phản Bội', 'SINGLE'),
  ('serial-killer', 'Sát Nhân Hàng Loạt', 'SINGLE'),
  ('fool', 'Thằng Ngố', 'SINGLE'),
  ('half-wolf', 'Bán Sói', 'SINGLE');

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[0-9]{6}$'),
  seat_count smallint not null check (seat_count between 7 and 16),
  status text not null default 'LOBBY'
    check (status in ('LOBBY', 'ROLE_REVEAL', 'IN_GAME', 'FINISHED')),
  phase text not null default 'SETUP'
    check (phase in ('SETUP', 'NIGHT', 'DAY', 'ENDED')),
  day_number integer not null default 1 check (day_number >= 1),
  wolf_policy text not null
    check (wolf_policy in ('RANDOM_ON_TIE', 'REVOTE_10S')),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  locked_at timestamptz,
  started_at timestamptz
);

create table private.room_owners (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  create_request_id uuid not null,
  unique (user_id, create_request_id)
);

create index room_owners_user_id_idx on private.room_owners(user_id);

create table public.room_role_config (
  room_id uuid not null references public.rooms(id) on delete cascade,
  role_id text not null references public.classic_roles(id),
  quantity smallint not null check (quantity between 1 and 16),
  primary key (room_id, role_id),
  check (role_id in ('villager', 'werewolf') or quantity = 1)
);

create table public.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  seat_number smallint not null check (seat_number between 1 and 16),
  display_name text not null check (char_length(display_name) between 1 and 20),
  normalized_name text not null check (char_length(normalized_name) between 1 and 20),
  reveal_confirmed boolean not null default false,
  joined_at timestamptz not null default statement_timestamp(),
  unique (room_id, id),
  unique (room_id, seat_number),
  unique (room_id, normalized_name)
);

create index room_players_room_id_idx on public.room_players(room_id);

create table public.room_memberships (
  room_id uuid not null,
  player_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default statement_timestamp(),
  primary key (room_id, user_id),
  unique (player_id),
  foreign key (room_id, player_id)
    references public.room_players(room_id, id) on delete cascade
);

create index room_memberships_user_id_idx on public.room_memberships(user_id);

create table public.room_role_assignments (
  room_id uuid not null,
  player_id uuid not null,
  role_id text not null references public.classic_roles(id),
  assigned_at timestamptz not null default statement_timestamp(),
  primary key (room_id, player_id),
  foreign key (room_id, player_id)
    references public.room_players(room_id, id) on delete cascade
);

create index room_role_assignments_room_id_idx
  on public.room_role_assignments(room_id);

create or replace function private.raise_ms1a(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end;
$$;

create or replace function private.require_auth_uid()
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    perform private.raise_ms1a('UNAUTHORIZED');
  end if;
  return v_user_id;
end;
$$;

create or replace function private.normalize_display_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g');
$$;

create or replace function private.is_room_moderator(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.room_owners owner
    where owner.room_id = p_room_id
      and owner.user_id = auth.uid()
  );
$$;

create or replace function private.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_memberships membership
    where membership.room_id = p_room_id
      and membership.user_id = auth.uid()
  );
$$;

create or replace function private.can_read_assignment(
  p_room_id uuid,
  p_player_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    private.is_room_moderator(p_room_id)
    or exists (
      select 1
      from public.room_memberships membership
      where membership.room_id = p_room_id
        and membership.player_id = p_player_id
        and membership.user_id = auth.uid()
    );
$$;

create or replace function private.can_receive_room_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_room_id uuid;
begin
  if p_topic is null or p_topic !~ '^room:[0-9a-fA-F-]{36}$' then
    return false;
  end if;
  begin
    v_room_id := pg_catalog.split_part(p_topic, ':', 2)::uuid;
  exception
    when invalid_text_representation then return false;
  end;
  return private.is_room_moderator(v_room_id)
    or private.is_room_member(v_room_id);
end;
$$;

create or replace function private.broadcast_room_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := coalesce(to_jsonb(new), to_jsonb(old));
  v_room_id uuid;
begin
  v_room_id := coalesce(v_row ->> 'room_id', v_row ->> 'id')::uuid;
  perform realtime.broadcast_changes(
    'room:' || v_room_id::text,
    'room_changed',
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return null;
end;
$$;

create or replace function private.validate_role_config(
  p_seat_count integer,
  p_role_config jsonb,
  p_wolf_policy text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_role_id text;
  v_value jsonb;
  v_quantity numeric;
  v_total integer := 0;
begin
  if p_seat_count is null or p_seat_count < 7 or p_seat_count > 16 then
    perform private.raise_ms1a('INVALID_ROOM_CONFIG');
  end if;
  if p_wolf_policy not in ('RANDOM_ON_TIE', 'REVOTE_10S') then
    perform private.raise_ms1a('INVALID_ROOM_CONFIG');
  end if;
  if p_role_config is null or jsonb_typeof(p_role_config) <> 'object' then
    perform private.raise_ms1a('INVALID_ROOM_CONFIG');
  end if;

  for v_role_id, v_value in
    select entry.key, entry.value from jsonb_each(p_role_config) entry
  loop
    if not exists (
      select 1 from public.classic_roles role where role.id = v_role_id
    ) then
      perform private.raise_ms1a('INVALID_ROOM_CONFIG');
    end if;
    if jsonb_typeof(v_value) <> 'number' then
      perform private.raise_ms1a('INVALID_ROOM_CONFIG');
    end if;
    v_quantity := (v_value #>> '{}')::numeric;
    if v_quantity < 0 or v_quantity <> trunc(v_quantity) then
      perform private.raise_ms1a('INVALID_ROOM_CONFIG');
    end if;
    if v_role_id not in ('villager', 'werewolf') and v_quantity > 1 then
      perform private.raise_ms1a('INVALID_ROOM_CONFIG');
    end if;
    v_total := v_total + v_quantity::integer;
  end loop;

  if v_total <> p_seat_count then
    perform private.raise_ms1a('INVALID_ROOM_CONFIG');
  end if;
end;
$$;

create or replace function private.moderator_room_payload(p_room_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'room', jsonb_build_object(
      'id', room.id,
      'code', room.code,
      'seatCount', room.seat_count,
      'status', room.status,
      'phase', room.phase,
      'dayNumber', room.day_number,
      'wolfPolicy', room.wolf_policy,
      'revision', room.revision,
      'createdAt', room.created_at,
      'updatedAt', room.updated_at,
      'lockedAt', room.locked_at,
      'startedAt', room.started_at
    ),
    'roleConfig', coalesce((
      select jsonb_object_agg(config.role_id, config.quantity)
      from public.room_role_config config
      where config.room_id = room.id
    ), '{}'::jsonb),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', player.id,
        'seat', player.seat_number,
        'displayName', player.display_name,
        'revealConfirmed', player.reveal_confirmed,
        'joinedAt', player.joined_at
      ) order by player.seat_number)
      from public.room_players player
      where player.room_id = room.id
    ), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'playerId', assignment.player_id,
        'roleId', assignment.role_id,
        'assignedAt', assignment.assigned_at
      ) order by player.seat_number)
      from public.room_role_assignments assignment
      join public.room_players player on player.id = assignment.player_id
      where assignment.room_id = room.id
    ), '[]'::jsonb)
  )
  from public.rooms room
  where room.id = p_room_id;
$$;

create or replace function private.player_room_payload(p_room_id uuid, p_user_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'room', jsonb_build_object(
      'id', room.id,
      'code', room.code,
      'seatCount', room.seat_count,
      'status', room.status,
      'phase', room.phase,
      'dayNumber', room.day_number,
      'revision', room.revision,
      'createdAt', room.created_at,
      'updatedAt', room.updated_at
    ),
    'self', jsonb_build_object(
      'id', self_player.id,
      'seat', self_player.seat_number,
      'displayName', self_player.display_name,
      'revealConfirmed', self_player.reveal_confirmed,
      'joinedAt', self_player.joined_at
    ),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', player.id,
        'seat', player.seat_number,
        'displayName', player.display_name,
        'revealConfirmed', player.reveal_confirmed,
        'joinedAt', player.joined_at
      ) order by player.seat_number)
      from public.room_players player
      where player.room_id = room.id
    ), '[]'::jsonb),
    'assignment', (
      select jsonb_build_object(
        'playerId', assignment.player_id,
        'roleId', assignment.role_id,
        'assignedAt', assignment.assigned_at
      )
      from public.room_role_assignments assignment
      where assignment.room_id = room.id
        and assignment.player_id = self_player.id
    )
  )
  from public.rooms room
  join public.room_memberships membership
    on membership.room_id = room.id and membership.user_id = p_user_id
  join public.room_players self_player on self_player.id = membership.player_id
  where room.id = p_room_id;
$$;

create or replace function public.ms1a_create_room(
  p_request_id uuid,
  p_seat_count integer,
  p_role_config jsonb,
  p_wolf_policy text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room_id uuid;
  v_code text;
begin
  if p_request_id is null then
    perform private.raise_ms1a('INVALID_CREATE_REQUEST');
  end if;
  perform private.validate_role_config(p_seat_count, p_role_config, p_wolf_policy);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || ':' || p_request_id::text, 0)
  );

  select owner.room_id into v_room_id
  from private.room_owners owner
  where owner.user_id = v_user_id
    and owner.create_request_id = p_request_id;

  if v_room_id is not null then
    return private.moderator_room_payload(v_room_id);
  end if;

  for v_attempt in 1..100 loop
    v_code := pg_catalog.lpad(
      pg_catalog.floor(pg_catalog.random() * 1000000)::integer::text,
      6,
      '0'
    );
    begin
      insert into public.rooms (code, seat_count, wolf_policy)
      values (v_code, p_seat_count, p_wolf_policy)
      returning id into v_room_id;
      exit;
    exception
      when unique_violation then
        v_room_id := null;
    end;
  end loop;

  if v_room_id is null then
    perform private.raise_ms1a('ROOM_CODE_EXHAUSTED');
  end if;

  insert into private.room_owners (room_id, user_id, create_request_id)
  values (v_room_id, v_user_id, p_request_id);

  insert into public.room_role_config (room_id, role_id, quantity)
  select v_room_id, config.key, (config.value #>> '{}')::smallint
  from jsonb_each(p_role_config) config
  where (config.value #>> '{}')::integer > 0;

  return private.moderator_room_payload(v_room_id);
end;
$$;

create or replace function public.ms1a_lookup_room(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.rooms%rowtype;
  v_joined_count integer;
begin
  perform private.require_auth_uid();
  if p_code is null or p_code !~ '^[0-9]{6}$' then
    return jsonb_build_object(
      'exists', false,
      'joinable', false,
      'reason', 'ROOM_NOT_FOUND'
    );
  end if;

  select * into v_room from public.rooms room where room.code = p_code;
  if not found then
    return jsonb_build_object(
      'exists', false,
      'joinable', false,
      'reason', 'ROOM_NOT_FOUND'
    );
  end if;

  select count(*)::integer into v_joined_count
  from public.room_players player
  where player.room_id = v_room.id;

  return jsonb_build_object(
    'exists', true,
    'joinable', v_room.status = 'LOBBY' and v_joined_count < v_room.seat_count,
    'reason', case
      when v_room.status <> 'LOBBY' then 'ROOM_LOCKED'
      when v_joined_count >= v_room.seat_count then 'ROOM_FULL'
      else null
    end,
    'roomId', v_room.id,
    'roomCode', v_room.code,
    'seatCount', v_room.seat_count,
    'joinedCount', v_joined_count,
    'status', v_room.status
  );
end;
$$;

create or replace function public.ms1a_join_room(p_code text, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_existing_player_id uuid;
  v_player_id uuid;
  v_seat smallint;
  v_display_name text;
  v_normalized_name text;
  v_joined_count integer;
begin
  if p_code is null or p_code !~ '^[0-9]{6}$' then
    perform private.raise_ms1a('ROOM_NOT_FOUND');
  end if;

  select * into v_room
  from public.rooms room
  where room.code = p_code
  for update;
  if not found then
    perform private.raise_ms1a('ROOM_NOT_FOUND');
  end if;

  select membership.player_id into v_existing_player_id
  from public.room_memberships membership
  where membership.room_id = v_room.id
    and membership.user_id = v_user_id;
  if v_existing_player_id is not null then
    return private.player_room_payload(v_room.id, v_user_id);
  end if;

  if v_room.status <> 'LOBBY' then
    perform private.raise_ms1a('ROOM_LOCKED');
  end if;

  v_display_name := private.normalize_display_name(p_display_name);
  if v_display_name = '' or char_length(v_display_name) > 20 then
    perform private.raise_ms1a('INVALID_NAME');
  end if;
  v_normalized_name := lower(v_display_name);

  if exists (
    select 1 from public.room_players player
    where player.room_id = v_room.id
      and player.normalized_name = v_normalized_name
  ) then
    perform private.raise_ms1a('DUPLICATE_NAME');
  end if;

  select count(*)::integer into v_joined_count
  from public.room_players player
  where player.room_id = v_room.id;
  if v_joined_count >= v_room.seat_count then
    perform private.raise_ms1a('ROOM_FULL');
  end if;

  select candidate.seat_number::smallint into v_seat
  from generate_series(1, v_room.seat_count) candidate(seat_number)
  where not exists (
    select 1 from public.room_players player
    where player.room_id = v_room.id
      and player.seat_number = candidate.seat_number
  )
  order by candidate.seat_number
  limit 1;
  if v_seat is null then
    perform private.raise_ms1a('ROOM_FULL');
  end if;

  insert into public.room_players (
    room_id,
    seat_number,
    display_name,
    normalized_name
  ) values (
    v_room.id,
    v_seat,
    v_display_name,
    v_normalized_name
  ) returning id into v_player_id;

  insert into public.room_memberships (room_id, player_id, user_id)
  values (v_room.id, v_player_id, v_user_id);

  update public.rooms
  set revision = revision + 1,
      updated_at = statement_timestamp()
  where id = v_room.id;

  return private.player_room_payload(v_room.id, v_user_id);
exception
  when unique_violation then
    if exists (
      select 1 from public.room_memberships membership
      where membership.room_id = v_room.id
        and membership.user_id = v_user_id
    ) then
      return private.player_room_payload(v_room.id, v_user_id);
    end if;
    if exists (
      select 1 from public.room_players player
      where player.room_id = v_room.id
        and player.normalized_name = v_normalized_name
    ) then
      perform private.raise_ms1a('DUPLICATE_NAME');
    end if;
    perform private.raise_ms1a('ROOM_FULL');
    return null;
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
begin
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then
    perform private.raise_ms1a('NOT_MODERATOR');
  end if;
  return private.moderator_room_payload(p_room_id);
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
begin
  v_payload := private.player_room_payload(p_room_id, v_user_id);
  if v_payload is null then
    perform private.raise_ms1a('UNAUTHORIZED');
  end if;
  return v_payload;
end;
$$;

create or replace function public.ms1a_resume_current_room()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_result jsonb;
begin
  select candidate.payload into v_result
  from (
    select room.updated_at,
      jsonb_build_object(
        'kind', 'MODERATOR',
        'roomId', room.id,
        'roomCode', room.code
      ) as payload
    from private.room_owners owner
    join public.rooms room on room.id = owner.room_id
    where owner.user_id = v_user_id
    union all
    select room.updated_at,
      jsonb_build_object(
        'kind', 'PLAYER',
        'roomId', room.id,
        'roomCode', room.code,
        'playerId', membership.player_id
      ) as payload
    from public.room_memberships membership
    join public.rooms room on room.id = membership.room_id
    where membership.user_id = v_user_id
  ) candidate
  order by candidate.updated_at desc
  limit 1;
  return v_result;
end;
$$;

create or replace function public.ms1a_lock_and_assign_roles(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_player_count integer;
  v_assignment_count integer;
  v_role_config jsonb;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then
    perform private.raise_ms1a('ROOM_NOT_FOUND');
  end if;

  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then
    perform private.raise_ms1a('NOT_MODERATOR');
  end if;

  select count(*)::integer into v_assignment_count
  from public.room_role_assignments assignment
  where assignment.room_id = p_room_id;
  if v_assignment_count > 0 then
    perform private.raise_ms1a('ALREADY_DEALT');
  end if;
  if v_room.status <> 'LOBBY' then
    perform private.raise_ms1a('ROOM_LOCKED');
  end if;

  select count(*)::integer into v_player_count
  from public.room_players player
  where player.room_id = p_room_id;
  if v_player_count <> v_room.seat_count then
    perform private.raise_ms1a('ROOM_NOT_READY');
  end if;

  select coalesce(jsonb_object_agg(config.role_id, config.quantity), '{}'::jsonb)
  into v_role_config
  from public.room_role_config config
  where config.room_id = p_room_id;
  perform private.validate_role_config(
    v_room.seat_count,
    v_role_config,
    v_room.wolf_policy
  );

  with shuffled_deck as (
    select
      config.role_id,
      row_number() over (order by pg_catalog.random()) as position
    from public.room_role_config config
    cross join lateral generate_series(1, config.quantity) copy_number
    where config.room_id = p_room_id
  ), seated_players as (
    select
      player.id as player_id,
      row_number() over (order by player.seat_number) as position
    from public.room_players player
    where player.room_id = p_room_id
  )
  insert into public.room_role_assignments (room_id, player_id, role_id)
  select p_room_id, player.player_id, deck.role_id
  from seated_players player
  join shuffled_deck deck using (position);

  select count(*)::integer into v_assignment_count
  from public.room_role_assignments assignment
  where assignment.room_id = p_room_id;
  if v_assignment_count <> v_room.seat_count then
    perform private.raise_ms1a('INVALID_ASSIGNMENT');
  end if;

  if exists (
    select role_id, quantity
    from public.room_role_config
    where room_id = p_room_id
    except
    select role_id, count(*)::smallint
    from public.room_role_assignments
    where room_id = p_room_id
    group by role_id
  ) or exists (
    select role_id, count(*)::smallint
    from public.room_role_assignments
    where room_id = p_room_id
    group by role_id
    except
    select role_id, quantity
    from public.room_role_config
    where room_id = p_room_id
  ) then
    perform private.raise_ms1a('INVALID_ASSIGNMENT');
  end if;

  update public.room_players
  set reveal_confirmed = false
  where room_id = p_room_id;

  update public.rooms
  set status = 'ROLE_REVEAL',
      revision = revision + 1,
      locked_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where id = p_room_id;

  return private.moderator_room_payload(p_room_id);
end;
$$;

create or replace function public.ms1a_confirm_role_reveal(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_player_id uuid;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then
    perform private.raise_ms1a('ROOM_NOT_FOUND');
  end if;

  select membership.player_id into v_player_id
  from public.room_memberships membership
  where membership.room_id = p_room_id
    and membership.user_id = v_user_id;
  if v_player_id is null then
    perform private.raise_ms1a('UNAUTHORIZED');
  end if;
  if v_room.status <> 'ROLE_REVEAL' then
    perform private.raise_ms1a('ROOM_NOT_READY');
  end if;
  if not exists (
    select 1 from public.room_role_assignments assignment
    where assignment.room_id = p_room_id
      and assignment.player_id = v_player_id
  ) then
    perform private.raise_ms1a('INVALID_ASSIGNMENT');
  end if;

  update public.room_players
  set reveal_confirmed = true
  where room_id = p_room_id and id = v_player_id;

  update public.rooms
  set revision = revision + 1,
      updated_at = statement_timestamp()
  where id = p_room_id;

  return private.player_room_payload(p_room_id, v_user_id);
end;
$$;

create or replace function public.ms1a_start_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_auth_uid();
  v_room public.rooms%rowtype;
  v_player_count integer;
  v_confirmed_count integer;
  v_assignment_count integer;
begin
  select * into v_room
  from public.rooms room
  where room.id = p_room_id
  for update;
  if not found then
    perform private.raise_ms1a('ROOM_NOT_FOUND');
  end if;
  if not exists (
    select 1 from private.room_owners owner
    where owner.room_id = p_room_id and owner.user_id = v_user_id
  ) then
    perform private.raise_ms1a('NOT_MODERATOR');
  end if;
  if v_room.status = 'IN_GAME' then
    return private.moderator_room_payload(p_room_id);
  end if;
  if v_room.status <> 'ROLE_REVEAL' then
    perform private.raise_ms1a('ROOM_NOT_READY');
  end if;

  select
    count(*)::integer,
    count(*) filter (where reveal_confirmed)::integer
  into v_player_count, v_confirmed_count
  from public.room_players
  where room_id = p_room_id;
  select count(*)::integer into v_assignment_count
  from public.room_role_assignments
  where room_id = p_room_id;

  if v_player_count <> v_room.seat_count
    or v_confirmed_count <> v_room.seat_count
    or v_assignment_count <> v_room.seat_count then
    perform private.raise_ms1a('ROOM_NOT_READY');
  end if;

  update public.rooms
  set status = 'IN_GAME',
      phase = 'NIGHT',
      day_number = 1,
      revision = revision + 1,
      started_at = coalesce(started_at, statement_timestamp()),
      updated_at = statement_timestamp()
  where id = p_room_id;

  return private.moderator_room_payload(p_room_id);
end;
$$;

alter table public.classic_roles enable row level security;
alter table public.rooms enable row level security;
alter table private.room_owners enable row level security;
alter table public.room_role_config enable row level security;
alter table public.room_players enable row level security;
alter table public.room_memberships enable row level security;
alter table public.room_role_assignments enable row level security;

create policy classic_roles_authenticated_read
on public.classic_roles
for select
to authenticated
using (true);

create policy rooms_member_or_moderator_read
on public.rooms
for select
to authenticated
using (
  private.is_room_moderator(id)
  or private.is_room_member(id)
);

create policy room_role_config_moderator_read
on public.room_role_config
for select
to authenticated
using (private.is_room_moderator(room_id));

create policy room_players_member_or_moderator_read
on public.room_players
for select
to authenticated
using (
  private.is_room_moderator(room_id)
  or private.is_room_member(room_id)
);

create policy room_memberships_self_or_moderator_read
on public.room_memberships
for select
to authenticated
using (
  user_id = auth.uid()
  or private.is_room_moderator(room_id)
);

create policy room_role_assignments_self_or_moderator_read
on public.room_role_assignments
for select
to authenticated
using (private.can_read_assignment(room_id, player_id));

create policy ms1a_room_broadcast_member_or_moderator_read
on realtime.messages
for select
to authenticated
using (
  extension = 'broadcast'
  and private.can_receive_room_topic(realtime.topic())
);

create trigger ms1a_broadcast_rooms
after insert or update or delete on public.rooms
for each row execute function private.broadcast_room_change();

create trigger ms1a_broadcast_room_players
after insert or update or delete on public.room_players
for each row execute function private.broadcast_room_change();

revoke all on table public.classic_roles from anon, authenticated;
revoke all on table public.rooms from anon, authenticated;
revoke all on table private.room_owners from anon, authenticated;
revoke all on table public.room_role_config from anon, authenticated;
revoke all on table public.room_players from anon, authenticated;
revoke all on table public.room_memberships from anon, authenticated;
revoke all on table public.room_role_assignments from anon, authenticated;

grant select on table public.classic_roles to authenticated;
grant select on table public.rooms to authenticated;
grant select on table public.room_role_config to authenticated;
grant select on table public.room_players to authenticated;
grant select on table public.room_memberships to authenticated;
grant select on table public.room_role_assignments to authenticated;

grant usage on schema private to authenticated;

revoke execute on function private.raise_ms1a(text) from public, anon, authenticated;
revoke execute on function private.require_auth_uid() from public, anon, authenticated;
revoke execute on function private.normalize_display_name(text) from public, anon, authenticated;
revoke execute on function private.is_room_moderator(uuid) from public, anon;
revoke execute on function private.is_room_member(uuid) from public, anon;
revoke execute on function private.can_read_assignment(uuid, uuid) from public, anon;
revoke execute on function private.can_receive_room_topic(text) from public, anon;
revoke execute on function private.broadcast_room_change() from public, anon, authenticated;
revoke execute on function private.validate_role_config(integer, jsonb, text) from public, anon, authenticated;
revoke execute on function private.moderator_room_payload(uuid) from public, anon, authenticated;
revoke execute on function private.player_room_payload(uuid, uuid) from public, anon, authenticated;

grant execute on function private.is_room_moderator(uuid) to authenticated;
grant execute on function private.is_room_member(uuid) to authenticated;
grant execute on function private.can_read_assignment(uuid, uuid) to authenticated;
grant execute on function private.can_receive_room_topic(text) to authenticated;

revoke execute on function public.ms1a_create_room(uuid, integer, jsonb, text) from public, anon;
revoke execute on function public.ms1a_lookup_room(text) from public, anon;
revoke execute on function public.ms1a_join_room(text, text) from public, anon;
revoke execute on function public.ms1a_get_moderator_room(uuid) from public, anon;
revoke execute on function public.ms1a_get_player_room(uuid) from public, anon;
revoke execute on function public.ms1a_resume_current_room() from public, anon;
revoke execute on function public.ms1a_lock_and_assign_roles(uuid) from public, anon;
revoke execute on function public.ms1a_confirm_role_reveal(uuid) from public, anon;
revoke execute on function public.ms1a_start_room(uuid) from public, anon;

grant execute on function public.ms1a_create_room(uuid, integer, jsonb, text) to authenticated;
grant execute on function public.ms1a_lookup_room(text) to authenticated;
grant execute on function public.ms1a_join_room(text, text) to authenticated;
grant execute on function public.ms1a_get_moderator_room(uuid) to authenticated;
grant execute on function public.ms1a_get_player_room(uuid) to authenticated;
grant execute on function public.ms1a_resume_current_room() to authenticated;
grant execute on function public.ms1a_lock_and_assign_roles(uuid) to authenticated;
grant execute on function public.ms1a_confirm_role_reveal(uuid) to authenticated;
grant execute on function public.ms1a_start_room(uuid) to authenticated;

commit;
