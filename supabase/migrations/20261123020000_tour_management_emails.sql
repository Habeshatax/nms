begin;

alter table public.chat_threads
  add column tour_status text check (tour_status in ('REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED')),
  add column tour_date date,
  add column tour_time_slot text check (tour_time_slot in ('10:00 AM - 11:00 AM', '02:00 PM - 03:00 PM')),
  add column tour_branch text check (tour_branch in ('BRANCH_1', 'BRANCH_2')),
  add column tour_revision integer not null default 0 check (tour_revision >= 0),
  add column tour_request_key uuid unique;

-- Keep historical requests visible without generating historical emails.
update public.chat_threads set tour_status = 'REQUESTED'
where subject like '[Nursery Tour Request]%';

create index chat_threads_tour_status_date_idx on public.chat_threads (tour_status, tour_date)
  where tour_status is not null;

create table public.tour_email_outbox (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  revision integer not null,
  recipient_kind text not null check (recipient_kind in ('PARENT', 'BRANCH', 'PREVIOUS_BRANCH')),
  event text not null check (event in ('REQUESTED', 'CONFIRMED', 'RESCHEDULED', 'COMPLETED', 'CANCELLED')),
  snapshot jsonb not null,
  provider_payload jsonb,
  state text not null default 'PENDING' check (state in ('PENDING', 'SENDING', 'SENT', 'FAILED', 'REVIEW')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  locked_until timestamptz,
  lock_token uuid,
  sent_at timestamptz,
  provider_id text,
  last_error text,
  created_at timestamptz not null default now(),
  unique (thread_id, revision, recipient_kind)
);
alter table public.tour_email_outbox enable row level security;
revoke all on public.tour_email_outbox from public, anon, authenticated;
grant select, insert, update, delete on public.tour_email_outbox to service_role;
create index tour_email_outbox_pending_idx on public.tour_email_outbox (available_at, created_at)
  where state in ('PENDING', 'SENDING');

create function public.enqueue_tour_emails(p_thread public.chat_threads, p_event text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  contact_name text := p_thread.guest_name;
  contact_email text := p_thread.guest_email;
  contact_phone text := p_thread.guest_phone;
  email_snapshot jsonb;
begin
  if p_thread.parent_id is not null then
    select concat_ws(' ', pr.first_name, pr.last_name), pr.email, pr.phone
      into contact_name, contact_email, contact_phone
      from public.parents pa join public.profiles pr on pr.id = pa.profile_id
      where pa.id = p_thread.parent_id;
  end if;
  email_snapshot := jsonb_build_object(
    'threadId', p_thread.id, 'name', contact_name, 'email', contact_email, 'phone', contact_phone,
    'branch', p_thread.tour_branch, 'visitDate', p_thread.tour_date,
    'timeSlot', p_thread.tour_time_slot, 'status', p_thread.tour_status
  );
  if contact_email is not null and contact_email <> '' then
    insert into public.tour_email_outbox (thread_id, revision, recipient_kind, event, snapshot)
      values (p_thread.id, p_thread.tour_revision, 'PARENT', p_event, email_snapshot);
  end if;
  insert into public.tour_email_outbox (thread_id, revision, recipient_kind, event, snapshot)
    values (p_thread.id, p_thread.tour_revision, 'BRANCH', p_event, email_snapshot);
end;
$$;

create function public.submit_tour_request(
  contact_name text, contact_email text, contact_phone text, request_key uuid,
  visit_date date, time_slot text, nursery_branch text, message_body text
)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  new_thread public.chat_threads;
  existing_id uuid;
begin
  if request_key is null or visit_date is null or time_slot is null or nursery_branch is null
    or length(trim(contact_name)) < 2 or contact_email is null or contact_phone is null
    or message_body is null then
    raise exception 'Invalid tour request';
  end if;
  if visit_date < (now() at time zone 'Europe/London')::date
    or extract(isodow from visit_date) > 5 then
    raise exception 'Tours require a current or future weekday';
  end if;

  insert into public.chat_threads (
    subject, guest_name, guest_email, guest_phone, tour_status,
    tour_date, tour_time_slot, tour_branch, tour_request_key
  ) values (
    '[Nursery Tour Request] ' || visit_date || ' (' || time_slot || ')',
    contact_name, contact_email, contact_phone, 'REQUESTED',
    visit_date, time_slot, nursery_branch, request_key
  ) on conflict (tour_request_key) do nothing returning * into new_thread;

  if new_thread.id is null then
    select id into existing_id from public.chat_threads where tour_request_key = request_key;
    return existing_id;
  end if;
  insert into public.chat_messages (thread_id, message) values (new_thread.id, message_body);
  perform public.enqueue_tour_emails(new_thread, 'REQUESTED');
  return new_thread.id;
end;
$$;

create function public.update_tour_request(
  target_thread_id uuid, expected_revision integer, next_status text,
  visit_date date, time_slot text, nursery_branch text, actor_id uuid
)
returns public.chat_threads language plpgsql security invoker set search_path = '' as $$
declare
  current_thread public.chat_threads;
  updated_thread public.chat_threads;
  email_event text;
begin
  -- The server supplies the authenticated actor. Check their staff role again in the transaction.
  if not exists (
    select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
    where ur.user_id = actor_id and r.name in ('STAFF', 'NURSERY_MANAGER', 'SUPER_ADMIN')
  ) then raise exception 'Staff access required'; end if;

  select * into current_thread from public.chat_threads where id = target_thread_id for update;
  if current_thread.id is null or current_thread.tour_status is null then
    raise exception 'Tour request unavailable';
  end if;
  if expected_revision is null or current_thread.tour_revision <> expected_revision then
    raise exception 'TOUR_CONFLICT';
  end if;
  if next_status is null or visit_date is null or time_slot is null or nursery_branch is null then
    raise exception 'Tour details are required';
  end if;
  if next_status in ('REQUESTED', 'CONFIRMED') and (
    visit_date < (now() at time zone 'Europe/London')::date or extract(isodow from visit_date) > 5
  ) then raise exception 'Active tours require a current or future weekday'; end if;

  if (current_thread.tour_status, current_thread.tour_date, current_thread.tour_time_slot,
      current_thread.tour_branch) is not distinct from (next_status, visit_date, time_slot, nursery_branch) then
    return current_thread;
  end if;
  email_event := next_status;
  if current_thread.tour_status = next_status then email_event := 'RESCHEDULED'; end if;

  update public.chat_threads set
    tour_status = next_status, tour_date = visit_date, tour_time_slot = time_slot,
    tour_branch = nursery_branch, tour_revision = tour_revision + 1,
    subject = '[Nursery Tour Request] ' || visit_date || ' (' || time_slot || ')'
    where id = target_thread_id returning * into updated_thread;
  insert into public.chat_messages (thread_id, sender_id, message) values (
    target_thread_id, actor_id,
    'Tour updated to ' || next_status || E'\nVisit date: ' || visit_date || E'\nTime: ' || time_slot ||
    E'\nBranch: ' || nursery_branch
  );
  perform public.enqueue_tour_emails(updated_thread, email_event);
  if current_thread.tour_branch is not null and current_thread.tour_branch <> nursery_branch then
    -- Notify the old setting that this visit has moved, using its own branch details.
    insert into public.tour_email_outbox (thread_id, revision, recipient_kind, event, snapshot)
      select thread_id, revision, 'PREVIOUS_BRANCH', 'CANCELLED',
        snapshot || jsonb_build_object('branch', current_thread.tour_branch, 'status', 'CANCELLED')
      from public.tour_email_outbox
      where thread_id = target_thread_id and revision = updated_thread.tour_revision and recipient_kind = 'BRANCH';
  end if;
  return updated_thread;
end;
$$;

create function public.claim_tour_email(target_thread_id uuid default null)
returns setof public.tour_email_outbox language plpgsql security invoker set search_path = '' as $$
begin
  update public.tour_email_outbox set state = 'REVIEW', last_error = 'Retry limit reached after an interrupted send'
    where state = 'SENDING' and locked_until < now() and attempts >= 8
      and (target_thread_id is null or thread_id = target_thread_id);
  return query
    update public.tour_email_outbox q set state = 'SENDING', attempts = q.attempts + 1,
      first_attempt_at = coalesce(q.first_attempt_at, now()),
      locked_until = now() + interval '2 minutes', lock_token = gen_random_uuid()
    where q.id = (
      select pending.id from public.tour_email_outbox pending
      where (target_thread_id is null or pending.thread_id = target_thread_id)
        and pending.attempts < 8 and pending.available_at <= now()
        and (pending.state = 'PENDING' or (pending.state = 'SENDING' and pending.locked_until < now()))
        and not exists (
          select 1 from public.tour_email_outbox earlier
          where earlier.thread_id = pending.thread_id and earlier.revision < pending.revision
            and earlier.state in ('PENDING', 'SENDING')
        )
      order by pending.created_at, pending.id limit 1 for update skip locked
    ) returning q.*;
end;
$$;

revoke execute on function public.enqueue_tour_emails(public.chat_threads, text) from public, anon, authenticated;
revoke execute on function public.submit_tour_request(text, text, text, uuid, date, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.update_tour_request(uuid, integer, text, date, text, text, uuid)
  from public, anon, authenticated;
revoke execute on function public.claim_tour_email(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_tour_emails(public.chat_threads, text) to service_role;
grant execute on function public.submit_tour_request(text, text, text, uuid, date, text, text, text) to service_role;
grant execute on function public.update_tour_request(uuid, integer, text, date, text, text, uuid) to service_role;
grant execute on function public.claim_tour_email(uuid) to service_role;

-- Prevent portal clients from bypassing the staff actions through table updates.
create policy "Tour updates require server staff actions"
  on public.chat_threads as restrictive for update to anon, authenticated
  using (tour_status is null) with check (tour_status is null);
create policy "Portal clients cannot create staff tour records"
  on public.chat_threads as restrictive for insert to anon, authenticated
  with check (tour_status is null and tour_request_key is null);

notify pgrst, 'reload schema';
commit;
