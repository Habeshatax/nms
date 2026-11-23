import { PGlite } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const staff = "11111111-1111-4111-8111-111111111111";
export const parent = "22222222-2222-4222-8222-222222222222";

export async function createFixture() {
  const db = new PGlite({ extensions: { uuid_ossp } });
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select current_user::text $$;
grant usage on schema auth, public to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant select,insert,update,delete on tables to anon,authenticated;
`);
  await db.exec(await readFile(root + "supabase/migrations/20260710153358_schema_init.sql", "utf8"));
  let chat = await readFile(root + "supabase/migrations/20260716130000_chat_schema.sql", "utf8");
  chat = chat.replace(
    "alter publication supabase_realtime add table public.chat_messages;",
    "-- Realtime publication omitted in embedded PostgreSQL fixture.",
  );
  await db.exec(chat);
  await db.exec(await readFile(root + "supabase/migrations/20261115004500_website_guest_enquiries.sql", "utf8"));
  await db.exec(`insert into auth.users(id,email) values ('${staff}','staff@example.invalid'),('${parent}','parent@example.invalid');
insert into public.user_roles(user_id,role_id) select '${staff}',id from public.roles where name='STAFF';
insert into public.parents(profile_id) values ('${parent}');`);
  await db.query(
    `select public.submit_website_enquiry('Legacy Parent','legacy@example.invalid','00000000000','[Nursery Tour Request] 2099-01-05 (10:00 AM - 11:00 AM)','Branch 2 legacy tour')`,
  );
  const legacy = (await one("select id from public.chat_threads limit 1")).id;
  return { db, legacy };
}
