import { createFixture, parent, root, staff } from "./fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.on("uncaughtException", (error) => {
  console.error("FAIL", error.message);
  process.exit(1);
});

const { db, legacy } = await createFixture();
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log("PASS", name);
}
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const count = async (table, condition = "true", args = []) =>
  Number((await one(`select count(*) as n from public.${table} where ${condition}`, args)).n);
await test("new migration applies to existing schema and legacy tour", async () => {
  await db.exec(await readFile(root + "supabase/migrations/20261123020000_tour_management_emails.sql", "utf8"));
  assert.equal(
    (await one("select tour_status from public.chat_threads where id=$1", [legacy])).tour_status,
    "REQUESTED",
  );
  assert.equal(await count("tour_email_outbox"), 0);
});
const key = "33333333-3333-4333-8333-333333333333";
const submit = async (id = key, slot = "10:00 AM - 11:00 AM") => {
  await db.exec("set role service_role");
  try {
    return (
      await one(
        `select public.submit_tour_request('Fictional Parent','fictional@example.invalid','00000000000',$1,'2099-01-05',$2,'BRANCH_1','Fictional request') as id`,
        [id, slot],
      )
    ).id;
  } finally {
    await db.exec("reset role");
  }
};
let id;
await test("submission atomically creates thread, message and two email jobs", async () => {
  id = await submit();
  assert.equal(await count("chat_messages", "thread_id=$1", [id]), 1);
  assert.equal(await count("tour_email_outbox", "thread_id=$1", [id]), 2);
});
await test("retrying the same request key creates no duplicate booking or emails", async () => {
  assert.equal(await submit(), id);
  assert.equal(await count("chat_messages", "thread_id=$1", [id]), 1);
  assert.equal(await count("tour_email_outbox", "thread_id=$1", [id]), 2);
});
await test("invalid time slot rolls back submission", async () => {
  const invalid = "44444444-4444-4444-8444-444444444444";
  await assert.rejects(submit(invalid, "invalid slot"));
  assert.equal(await count("chat_threads", "tour_request_key=$1", [invalid]), 0);
});
await test("queue failure rolls back booking and first message", async () => {
  await db.exec(`create function public.fail_test_queue() returns trigger language plpgsql as $$begin raise exception 'simulated queue failure'; end$$;
 create trigger fail_test_queue before insert on public.tour_email_outbox for each row execute function public.fail_test_queue();`);
  const failed = "55555555-5555-4555-8555-555555555555";
  await assert.rejects(submit(failed));
  assert.equal(await count("chat_threads", "tour_request_key=$1", [failed]), 0);
  await db.exec("drop trigger fail_test_queue on public.tour_email_outbox; drop function public.fail_test_queue();");
});
async function update(
  revision,
  status = "CONFIRMED",
  date = "2099-01-05",
  slot = "10:00 AM - 11:00 AM",
  branch = "BRANCH_1",
  actor = staff,
  target = id,
) {
  await db.exec("set role service_role");
  try {
    return await one("select * from public.update_tour_request($1,$2,$3,$4,$5,$6,$7)", [
      target,
      revision,
      status,
      date,
      slot,
      branch,
      actor,
    ]);
  } finally {
    await db.exec("reset role");
  }
}
await test("staff confirmation updates revision, history and queued snapshots", async () => {
  const row = await update(0);
  assert.equal(row.tour_revision, 1);
  assert.equal(row.tour_status, "CONFIRMED");
  assert.equal(await count("chat_messages", "thread_id=$1", [id]), 2);
  assert.equal(await count("tour_email_outbox", "thread_id=$1", [id]), 4);
});
await test("unchanged save does not add email jobs or advance revision", async () => {
  assert.equal((await update(1)).tour_revision, 1);
  assert.equal(await count("tour_email_outbox", "thread_id=$1", [id]), 4);
});
await test("stale staff revision rejects the update", async () => {
  await assert.rejects(update(0), /TOUR_CONFLICT/);
  assert.equal((await one("select tour_revision from public.chat_threads where id=$1", [id])).tour_revision, 1);
});
await test("non-staff actor cannot update a tour", async () => {
  await assert.rejects(
    update(1, "CONFIRMED", "2099-01-05", "10:00 AM - 11:00 AM", "BRANCH_1", parent),
    /Staff access required/,
  );
});
await test("rescheduling and branch transfer queue parent, new and old branch notifications", async () => {
  const row = await update(1, "CONFIRMED", "2099-01-06", "02:00 PM - 03:00 PM", "BRANCH_2");
  assert.equal(row.tour_revision, 2);
  const jobs = (
    await db.query(
      "select recipient_kind,event,snapshot from public.tour_email_outbox where thread_id=$1 and revision=2",
      [id],
    )
  ).rows;
  assert.equal(jobs.length, 3);
  const old = jobs.find((j) => j.recipient_kind === "PREVIOUS_BRANCH");
  assert.equal(old.event, "CANCELLED");
  assert.equal(old.snapshot.branch, "BRANCH_1");
  assert.equal(old.snapshot.status, "CANCELLED");
  assert.equal(jobs.find((j) => j.recipient_kind === "PARENT").event, "RESCHEDULED");
  assert.equal(
    (await one("select snapshot from public.tour_email_outbox where thread_id=$1 and revision=0 limit 1", [id]))
      .snapshot.visitDate,
    "2099-01-05",
  );
});
await test("cancel and complete retain history and create corresponding emails", async () => {
  await update(2, "CANCELLED", "2099-01-06", "02:00 PM - 03:00 PM", "BRANCH_2");
  const row = await update(3, "COMPLETED", "2020-01-01", "02:00 PM - 03:00 PM", "BRANCH_2");
  assert.equal(row.tour_revision, 4);
  assert.equal(row.tour_status, "COMPLETED");
});
await test("older tour can be completed and new general enquiries remain ordinary messages", async () => {
  await update(0, "COMPLETED", "2020-01-01", "10:00 AM - 11:00 AM", "BRANCH_2", staff, legacy);
  await db.query(
    `select public.submit_website_enquiry('Enquiry','enquiry@example.invalid','00000000000','General enquiry','Fictional general enquiry')`,
  );
  const row = await one("select id,tour_status from public.chat_threads where guest_email='enquiry@example.invalid'");
  assert.equal(row.tour_status, null);
  assert.equal(await count("tour_email_outbox", "thread_id=$1", [row.id]), 0);
});
await test("portal roles have no access to outbox or privileged RPCs", async () => {
  const access = await one(`select has_table_privilege('authenticated','public.tour_email_outbox','SELECT') as can_read,
 has_function_privilege('anon','public.submit_tour_request(text,text,text,uuid,date,text,text,text)','EXECUTE') as can_submit,
 has_function_privilege('authenticated','public.update_tour_request(uuid,integer,text,date,text,text,uuid)','EXECUTE') as can_update`);
  assert.equal(access.can_read, false);
  assert.equal(access.can_submit, false);
  assert.equal(access.can_update, false);
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${parent}',false);`);
  assert.equal((await db.query("select * from public.chat_threads where id=$1", [id])).rows.length, 0);
  await assert.rejects(db.query("select * from public.tour_email_outbox"));
  await db.exec("reset role");
});
await test("two claims lease different jobs while later revisions wait", async () => {
  const a = await one("select * from public.claim_tour_email($1)", [id]);
  const b = await one("select * from public.claim_tour_email($1)", [id]);
  assert.notEqual(a.id, b.id);
  assert.equal(a.revision, 0);
  assert.equal(b.revision, 0);
  assert.equal((await db.query("select * from public.claim_tour_email($1)", [id])).rows.length, 0);
  await db.query("update public.tour_email_outbox set state='SENT' where id=any($1::uuid[])", [[a.id, b.id]]);
  const next = await one("select * from public.claim_tour_email($1)", [id]);
  assert.equal(next.revision, 1);
});
await test("expired lease gets new token and stale worker cannot update", async () => {
  const old = await one("select * from public.tour_email_outbox where thread_id=$1 and state='SENDING' limit 1", [id]);
  await db.query("update public.tour_email_outbox set locked_until=now()-interval '1 minute' where id=$1", [old.id]);
  const fresh = await one("select * from public.claim_tour_email($1)", [id]);
  assert.equal(fresh.id, old.id);
  assert.notEqual(fresh.lock_token, old.lock_token);
  const changed = await db.query(
    "update public.tour_email_outbox set state='SENT' where id=$1 and lock_token=$2 returning id",
    [old.id, old.lock_token],
  );
  assert.equal(changed.rows.length, 0);
});
await test("interrupted send at retry limit becomes reviewable", async () => {
  await db.query(
    "update public.tour_email_outbox set attempts=8,locked_until=now()-interval '1 minute' where thread_id=$1 and state='SENDING'",
    [id],
  );
  await db.query("select * from public.claim_tour_email($1)", [id]);
  assert.ok(await count("tour_email_outbox", "thread_id=$1 and state='REVIEW'", [id]));
});
await test("deleting a fictional tour cascades its emails and messages", async () => {
  await db.query("delete from public.chat_threads where id=$1", [id]);
  assert.equal(await count("tour_email_outbox", "thread_id=$1", [id]), 0);
  assert.equal(await count("chat_messages", "thread_id=$1", [id]), 0);
});
console.log(`Database tests passed: ${passed}`);
await db.close();
