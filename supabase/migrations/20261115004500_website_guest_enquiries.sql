-- Website visitors can contact admissions without a portal account.
alter table public.chat_threads
  alter column parent_id drop not null,
  add column guest_name text,
  add column guest_email text,
  add column guest_phone text,
  add constraint chat_threads_contact_check check (
    (parent_id is not null and num_nonnulls(guest_name, guest_email, guest_phone) = 0)
    or (parent_id is null and num_nonnulls(guest_name, guest_email, guest_phone) = 3)
  );

alter table public.chat_messages alter column sender_id drop not null;

-- Guest threads and their messages are accessed by staff through server-side actions.
create policy "Keep website threads out of portal sessions"
  on public.chat_threads as restrictive for all to anon, authenticated
  using (parent_id is not null)
  with check (parent_id is not null);

create policy "Require a profile for portal messages"
  on public.chat_messages as restrictive for insert to anon, authenticated
  with check (sender_id is not null);

create function public.submit_website_enquiry(
  contact_name text,
  contact_email text,
  contact_phone text,
  enquiry_subject text,
  enquiry_message text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  enquiry_thread_id uuid;
begin
  insert into public.chat_threads (subject, guest_name, guest_email, guest_phone)
  values (enquiry_subject, contact_name, contact_email, contact_phone)
  returning id into enquiry_thread_id;

  insert into public.chat_messages (thread_id, message)
  values (enquiry_thread_id, enquiry_message);
end;
$$;

revoke execute on function public.submit_website_enquiry(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_website_enquiry(text, text, text, text, text)
  to service_role;
