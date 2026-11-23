import "server-only";

import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";

import { renderTourEmail, tourEmailEvents, tourEmailSnapshotSchema } from "./email-content";
import { tourBranches } from "./schema";

const providerPayloadSchema = z.object({
  from: z.string().min(1),
  to: z.array(z.email()).length(1),
  reply_to: z.email(),
  subject: z.string(),
  text: z.string(),
});
const emailJobSchema = z.object({
  id: z.uuid(),
  thread_id: z.uuid(),
  recipient_kind: z.enum(["PARENT", "BRANCH", "PREVIOUS_BRANCH"]),
  event: z.enum(tourEmailEvents),
  snapshot: z.unknown(),
  provider_payload: z.unknown().nullable(),
  attempts: z.number(),
  first_attempt_at: z.string(),
  lock_token: z.uuid(),
});

export function tourManagementEnabled() {
  return process.env.TOUR_MANAGEMENT_ENABLED === "true";
}

export function tourEmailMode() {
  if (!tourManagementEnabled()) return "disabled";
  const mode = process.env.TOUR_EMAIL_MODE;
  return mode === "send" || mode === "test" ? mode : "disabled";
}

export async function processTourEmails(threadId?: string) {
  const mode = tourEmailMode();
  const result = { mode, accepted: 0, deferred: 0, needsReview: 0 };
  if (mode === "disabled") return result;

  const apiKey = process.env.TOUR_EMAIL_API_KEY;
  const sender = process.env.TOUR_EMAIL_FROM;
  const testRecipient = process.env.TOUR_EMAIL_TEST_RECIPIENT;
  if (!apiKey || !sender || (mode === "test" && !z.email().safeParse(testRecipient).success)) {
    throw new Error("Tour email configuration is incomplete.");
  }

  const admin = createAdminClient();
  for (let index = 0; index < 10; index++) {
    const { data, error } = await admin.rpc("claim_tour_email", { target_thread_id: threadId ?? null });
    if (error) throw new Error("Could not claim pending tour emails.");
    if (!data?.length) break;
    const job = emailJobSchema.parse(data[0]);
    const save = async (values: Record<string, unknown>) => {
      const { data: rows, error: saveError } = await admin
        .from("tour_email_outbox")
        .update(values)
        .eq("id", job.id)
        .eq("lock_token", job.lock_token)
        .select("id");
      if (saveError || rows?.length !== 1) throw new Error("Could not record tour email progress.");
    };

    // Resend retains idempotency keys for 24 hours. Ambiguous sends older than that need review.
    if (Date.now() - Date.parse(job.first_attempt_at) >= 23 * 60 * 60 * 1000) {
      await save({ state: "REVIEW", last_error: "Idempotency retry window expired", locked_until: null });
      result.needsReview++;
      continue;
    }

    let payload: z.infer<typeof providerPayloadSchema>;
    try {
      if (job.provider_payload) {
        payload = providerPayloadSchema.parse(job.provider_payload);
      } else {
        const snapshot = tourEmailSnapshotSchema.parse(job.snapshot);
        const branch = tourBranches[snapshot.branch];
        const recipient = job.recipient_kind === "PARENT" ? snapshot.email : branch.email;
        payload = providerPayloadSchema.parse({
          from: sender,
          to: [mode === "test" ? testRecipient : recipient],
          reply_to: branch.email,
          ...renderTourEmail(snapshot, job.event, job.recipient_kind === "PARENT" ? "PARENT" : "BRANCH"),
        });
        // Freeze the exact request before sending so a retry uses the same payload and key.
        await save({ provider_payload: payload });
      }
    } catch {
      await save({
        state: "FAILED",
        last_error: "Invalid email details or unsaved provider payload",
        locked_until: null,
      });
      result.needsReview++;
      continue;
    }

    // Test mode must never send a previously prepared production payload to its original recipient.
    if (mode === "test" && payload.to[0] !== testRecipient) {
      await save({ state: "REVIEW", last_error: "Stored recipient differs from test inbox", locked_until: null });
      result.needsReview++;
      continue;
    }

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `nursery-tour/${job.id}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        await save({
          state: retryable && job.attempts < 8 ? "PENDING" : "FAILED",
          available_at: new Date(Date.now() + Math.min(30, 2 ** job.attempts) * 60_000).toISOString(),
          last_error: `Email provider HTTP ${response.status}`,
          locked_until: null,
        });
        result.deferred++;
        continue;
      }
      const sent = z.object({ id: z.string() }).parse(await response.json());
      await save({
        state: "SENT",
        sent_at: new Date().toISOString(),
        provider_id: sent.id,
        last_error: null,
        locked_until: null,
      });
      result.accepted++;
    } catch {
      // Leave uncertain attempts retryable with their immutable payload and provider idempotency key.
      await save({
        state: job.attempts < 8 ? "PENDING" : "REVIEW",
        available_at: new Date(Date.now() + Math.min(30, 2 ** job.attempts) * 60_000).toISOString(),
        last_error: "Email send outcome could not be confirmed",
        locked_until: null,
      });
      result.deferred++;
    }
  }
  return result;
}
