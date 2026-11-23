import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log("PASS", name);
}
const snapshot = {
  threadId: "11111111-1111-4111-8111-111111111111",
  name: "Fictional Parent",
  email: "parent@example.invalid",
  phone: "00000000000",
  branch: "BRANCH_1",
  visitDate: "2099-01-05",
  timeSlot: "10:00 AM - 11:00 AM",
  status: "REQUESTED",
};
function job(overrides = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    thread_id: snapshot.threadId,
    recipient_kind: "PARENT",
    event: "REQUESTED",
    snapshot: { ...snapshot },
    provider_payload: null,
    attempts: 1,
    first_attempt_at: new Date().toISOString(),
    lock_token: "33333333-3333-4333-8333-333333333333",
    ...overrides,
  };
}
function harness({ jobs = [], env = {}, response, stale = false } = {}) {
  const variables = {
    TOUR_MANAGEMENT_ENABLED: "true",
    TOUR_EMAIL_MODE: "test",
    TOUR_EMAIL_API_KEY: "fictional-key",
    TOUR_EMAIL_FROM: "Nursery <sender@example.invalid>",
    TOUR_EMAIL_TEST_RECIPIENT: "test@example.invalid",
    ...env,
  };
  const calls = [],
    saves = [],
    cache = new Map();
  let claims = 0,
    clients = 0;
  const queue = [...jobs];
  const admin = {
    rpc: async () => {
      claims++;
      return { data: queue.length ? [queue.shift()] : [], error: null };
    },
    from: () => ({
      update: (values) => {
        const query = {
          eq: () => query,
          select: async () => {
            saves.push(values);
            return { data: stale ? [] : [{ id: "saved" }], error: null };
          },
        };
        return query;
      },
    }),
  };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const localRequire = (name) => {
      if (name === "server-only") return {};
      if (name === "@/lib/supabase/admin")
        return {
          createAdminClient: () => {
            clients++;
            return admin;
          },
        };
      if (name === "@/lib/tours/email-dispatch") return load(path.join(root, "src/lib/tours/email-dispatch.ts"));
      if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), name + ".ts"));
      return require(name);
    };
    vm.runInNewContext(
      compiled,
      {
        module,
        exports: module.exports,
        require: localRequire,
        process: { env: variables },
        Date,
        Intl,
        AbortSignal,
        Response,
        Request,
        console,
        fetch: async (url, options) => {
          calls.push({ url, ...options, payload: JSON.parse(options.body) });
          return response ? response(url, options) : Response.json({ id: "fictional-provider-id" });
        },
      },
      { filename },
    );
    return module.exports;
  }
  return {
    load,
    dispatch: load(path.join(root, "src/lib/tours/email-dispatch.ts")),
    calls,
    saves,
    get claims() {
      return claims;
    },
    get clients() {
      return clients;
    },
    route: () => load(path.join(root, "src/app/api/tour-emails/route.ts")),
  };
}
await test("feature disabled makes no database or provider calls", async () => {
  const h = harness({ env: { TOUR_MANAGEMENT_ENABLED: "false" } });
  assert.equal((await h.dispatch.processTourEmails()).mode, "disabled");
  assert.equal(h.clients, 0);
  assert.equal(h.calls.length, 0);
});
await test("disabled email mode makes no database or provider calls", async () => {
  const h = harness({ env: { TOUR_EMAIL_MODE: "disabled" } });
  await h.dispatch.processTourEmails();
  assert.equal(h.clients, 0);
});
await test("missing credentials or test inbox fail before claiming jobs", async () => {
  for (const env of [{ TOUR_EMAIL_API_KEY: "" }, { TOUR_EMAIL_FROM: "" }, { TOUR_EMAIL_TEST_RECIPIENT: "" }]) {
    const h = harness({ env });
    await assert.rejects(h.dispatch.processTourEmails(), /incomplete/);
    assert.equal(h.claims, 0);
  }
});
await test("all parent and branch recipients are redirected to test inbox", async () => {
  const h = harness({
    jobs: [
      job(),
      job({ recipient_kind: "BRANCH" }),
      job({ recipient_kind: "PREVIOUS_BRANCH", snapshot: { ...snapshot, branch: "BRANCH_2" } }),
    ],
  });
  assert.equal((await h.dispatch.processTourEmails()).accepted, 3);
  assert.ok(h.calls.every((c) => c.payload.to[0] === "test@example.invalid"));
  assert.equal(h.calls[0].payload.reply_to, "bubblydnursery@gmail.com");
  assert.equal(h.calls[2].payload.reply_to, "bubblyd2nursery@gmail.com");
  assert.match(h.calls[0].payload.text, /awaiting confirmation/);
  assert.ok(h.saves.some((s) => s.state === "SENT" && s.provider_id === "fictional-provider-id"));
});
await test("send mode resolves parent and each branch separately", async () => {
  const h = harness({
    env: { TOUR_EMAIL_MODE: "send" },
    jobs: [
      job(),
      job({ recipient_kind: "BRANCH" }),
      job({ recipient_kind: "BRANCH", snapshot: { ...snapshot, branch: "BRANCH_2" } }),
    ],
  });
  await h.dispatch.processTourEmails();
  assert.deepEqual(
    h.calls.map((c) => c.payload.to[0]),
    ["parent@example.invalid", "bubblydnursery@gmail.com", "bubblyd2nursery@gmail.com"],
  );
});
await test("all event templates include UK date time reference and current status", async () => {
  const h = harness();
  const { renderTourEmail, tourEmailEvents } = h.load(path.join(root, "src/lib/tours/email-content.ts"));
  for (const event of tourEmailEvents) {
    const email = renderTourEmail(snapshot, event, "PARENT");
    assert.match(email.text, /5 January 2099/);
    assert.match(email.text, /UK time/);
    assert.match(email.text, /Status: Requested/);
    assert.ok(email.text.includes(snapshot.threadId));
    assert.ok(email.subject.length > 5);
  }
});
await test("HTTP 429 and 500 defer with backoff; permanent 400 stops", async () => {
  for (const code of [429, 500, 400]) {
    const h = harness({ jobs: [job()], response: () => Response.json({ error: "fictional" }, { status: code }) });
    await h.dispatch.processTourEmails();
    const saved = h.saves.at(-1);
    assert.equal(saved.state, code === 400 ? "FAILED" : "PENDING");
    assert.ok(Date.parse(saved.available_at) > Date.now());
    assert.match(saved.last_error, new RegExp(String(code)));
  }
});
await test("uncertain network result retries and final uncertain attempt needs review", async () => {
  for (const attempts of [1, 8]) {
    const h = harness({
      jobs: [job({ attempts })],
      response: () => {
        throw new Error("simulated disconnected response");
      },
    });
    await h.dispatch.processTourEmails();
    assert.equal(h.saves.at(-1).state, attempts === 8 ? "REVIEW" : "PENDING");
  }
});
await test("retry uses identical stored body and provider idempotency key", async () => {
  const first = harness({
    jobs: [job()],
    response: () => {
      throw new Error("simulated response loss");
    },
  });
  await first.dispatch.processTourEmails();
  const payload = first.saves.find((s) => s.provider_payload).provider_payload;
  const second = harness({
    jobs: [
      job({ attempts: 2, provider_payload: payload, snapshot: { ...snapshot, name: "Changed after first attempt" } }),
    ],
  });
  await second.dispatch.processTourEmails();
  assert.equal(second.calls[0].body, first.calls[0].body);
  assert.equal(second.calls[0].headers["Idempotency-Key"], first.calls[0].headers["Idempotency-Key"]);
});
await test("old ambiguous attempts stop before provider idempotency expires", async () => {
  const h = harness({ jobs: [job({ first_attempt_at: new Date(Date.now() - 23 * 3600000 - 1000).toISOString() })] });
  assert.equal((await h.dispatch.processTourEmails()).needsReview, 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.saves.at(-1).state, "REVIEW");
});
await test("test mode blocks stored production recipients", async () => {
  const h = harness({
    jobs: [
      job({
        provider_payload: {
          from: "sender@example.invalid",
          to: ["parent@example.invalid"],
          reply_to: "bubblydnursery@gmail.com",
          subject: "Fictional",
          text: "Fictional",
        },
      }),
    ],
  });
  await h.dispatch.processTourEmails();
  assert.equal(h.calls.length, 0);
  assert.equal(h.saves.at(-1).state, "REVIEW");
});
await test("invalid email snapshot stops without provider call", async () => {
  const h = harness({ jobs: [job({ snapshot: { ...snapshot, email: "invalid" } })] });
  await h.dispatch.processTourEmails();
  assert.equal(h.calls.length, 0);
  assert.equal(h.saves.at(-1).state, "FAILED");
});
await test("lost lease cannot send unsaved provider payload", async () => {
  const h = harness({ jobs: [job()], stale: true });
  await assert.rejects(h.dispatch.processTourEmails(), /record tour email progress/);
  assert.equal(h.calls.length, 0);
});
await test("worker limits one invocation to ten jobs", async () => {
  const h = harness({ jobs: Array.from({ length: 12 }, () => job()) });
  assert.equal((await h.dispatch.processTourEmails()).accepted, 10);
  assert.equal(h.claims, 10);
});
await test("worker endpoint denies missing incorrect and unconfigured bearer secret", async () => {
  for (const [secret, auth] of [
    ["secret", ""],
    ["secret", "Bearer wrong"],
    ["", "Bearer secret"],
  ]) {
    const h = harness({ env: { TOUR_EMAIL_CRON_SECRET: secret } });
    const res = await h
      .route()
      .POST(new Request("http://localhost/api/tour-emails", { method: "POST", headers: { authorization: auth } }));
    assert.equal(res.status, 401);
    assert.equal(h.claims, 0);
  }
});
await test("authorized endpoint returns counts without contact details and disables caching", async () => {
  const h = harness({ env: { TOUR_EMAIL_CRON_SECRET: "fictional-secret" } });
  const res = await h.route().POST(
    new Request("http://localhost/api/tour-emails", {
      method: "POST",
      headers: { authorization: "Bearer fictional-secret" },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { mode: "test", accepted: 0, deferred: 0, needsReview: 0 });
});
await test("endpoint masks internal errors with service unavailable", async () => {
  const h = harness({ env: { TOUR_EMAIL_CRON_SECRET: "fictional-secret", TOUR_EMAIL_API_KEY: "" } });
  const res = await h.route().POST(
    new Request("http://localhost/api/tour-emails", {
      method: "POST",
      headers: { authorization: "Bearer fictional-secret" },
    }),
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "Email processing unavailable" });
});
console.log(`Email and endpoint checks: ${passed} passed. No network calls were made.`);
