# Tour management and booking emails

This feature is prepared on `feature/tour-management-emails`. It requires the new migration and application code together. Apply it first to a separate preview database with fictional records and a separate preview app. Use that database's URL, anonymous key and service role key. The production nursery database and `nms-app` are outside this preview setup.

The feature defaults to `TOUR_MANAGEMENT_ENABLED=false`. Until enabled, the app keeps its existing booking save and Messages behaviour. Enable the feature only on the isolated preview app after its migration is applied.

## Messages

Staff can filter all messages, all tours, or Requested, Confirmed, Completed and Cancelled tours. Opening a tour reveals its status, date, UK time slot and branch. Saving updates the conversation subject and adds an audit message under the authenticated staff member. Revision checks reject overlapping edits so staff can refresh before saving again.

Existing `[Nursery Tour Request]` conversations become Requested without queuing retrospective emails. The editor reads older dates/time slots from the subject and branch details from the message. Staff must complete missing details before saving. The original request message remains available in the history.

## Automatic emails

A tour submission atomically saves the conversation, first message and two email jobs. Public tour retries reuse a request key while their form data is unchanged. Status/schedule changes atomically save an audit message and queue updated emails. An unchanged save creates no additional jobs. Branch transfers notify the parent, new branch and previous branch.

Parents receive acknowledgement, confirmation, rescheduling, cancellation or completion emails. Requested emails clearly say that staff confirmation is still needed. Branch 1 notifications go to `bubblydnursery@gmail.com`; Branch 2 notifications go to `bubblyd2nursery@gmail.com`. The parent and branch messages are separate emails. Plain text templates include the tour reference, UK date/time, setting address and reply address.

Staff can open **View booking emails** to review message content and queue states. SENT means accepted by the email provider. Delivery/bounce webhooks are not part of this feature.

## Preview configuration

Copy the variables from `.env.tour-emails.example` into the preview app configuration, alongside its separate Supabase credentials.

* `TOUR_MANAGEMENT_ENABLED=true` enables tour management on the preview app. The default `false` keeps it inactive.
* `TOUR_EMAIL_MODE=disabled` is the default. Requests and changes queue emails. Staff can review them without any provider calls.
* `TOUR_EMAIL_MODE=test` requires `TOUR_EMAIL_API_KEY`, `TOUR_EMAIL_FROM` and `TOUR_EMAIL_TEST_RECIPIENT`. Every email goes to the test inbox. Use a Resend-verified sender address in `TOUR_EMAIL_FROM`, optionally formatted as `Bubbly Day Nursery <sender@verified-domain>`.
* `TOUR_EMAIL_MODE=send` uses actual recipients. Configure it only as part of a separately approved rollout.
* `TOUR_EMAIL_CRON_SECRET` must be a long random value generated for the preview app. Never use a Supabase service role key for this value.

The worker sends after a saved request/update. For retries and interrupted requests, configure the preview scheduler to POST to `/api/tour-emails` once per minute with `Authorization: Bearer <TOUR_EMAIL_CRON_SECRET>`. The endpoint uses the app's configured database. Deploy it on the preview app first. It returns aggregate counts without contact details.

## Queue recovery

Jobs are claimed with SKIP LOCKED and a two-minute lease. Each attempt has a new lock token. The exact provider payload is frozen before the first send, and retries keep the same Resend idempotency key. Temporary failures retry with backoff up to eight attempts. Older ambiguous attempts stop for review before Resend's 24-hour idempotency window expires. A later revision waits for earlier pending/sending revisions of that tour.

FAILED or REVIEW jobs require staff/developer investigation. This version does not automatically reset those jobs or replay historical notifications. Verify provider acceptance before deliberately resending an uncertain message.

## Preview acceptance checks

1. Apply the new migration to the isolated preview database. Build/start the preview app using that database's credentials, enabled tour management and disabled email mode.
2. Sign in as preview staff. Confirm older tours are visible and editable, ordinary enquiries retain their existing controls, and status filtering works.
3. Submit a fictional tour. Confirm exactly one thread, one message and two pending jobs. Repeat the same request key and confirm no duplicates.
4. Preview the parent acknowledgement and branch notification. Confirm the request is described as awaiting confirmation.
5. Confirm and reschedule the tour. Verify date/time, status badges, history and email snapshots. Save unchanged details and check that no jobs are added.
6. Open a tour in two staff sessions. Save in one and confirm the second receives the refresh/conflict message.
7. Cancel/complete a tour, including a historical one. Confirm email wording and history. Move a tour between branches and check all three notification recipients.
8. Confirm an ordinary parent cannot update tour fields or read the email queue using direct table access or server actions.
9. Enable test mode with a test inbox and verified Resend sender. Run the worker and check that parent and both branch notifications go only to the test inbox. Verify duplicate worker calls do not duplicate provider submissions. Exercise failed sends and interrupted leases.
10. Review mobile and dark-mode Messages screenshots and verify the public booking success/error messages. A production rollout needs a separate deployment decision after preview review.

Build, browser and isolated database checks are pending. No production migration, deployment or email send was performed while preparing this branch.
