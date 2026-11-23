# Nursery tour email activation

The owner requested enabling the booking email workflow after sender verification and delivery testing. The sending identity is `Bubbly Day Nursery <bookings@updates.bubblydnursery.co.uk>`, with reply-to addresses provided by the branch configuration. The Resend domain `updates.bubblydnursery.co.uk` and all its issued DNS records were verified on 23 November 2026. A direct provider test and a test using the restricted sending key installed on the nursery VPS were both reported delivered to the owner's controlled Gmail inbox; the owner supplied an Inbox screenshot.

The current app has email mode explicitly disabled in its Docker environment. Changing only `.env` does not override that flag. `scripts/activate-tour-emails.py` recreates the app from its existing local image with send mode enabled, preserving the reviewed networks, proxy labels, environment, restart policy and resource limits. The current container's `.env` is copied into a root-only backup and then into the new container; its sending key is not put in command arguments or printed. The old container remains available for rollback with its disabled email configuration.

## Queue preparation

Only two queued notifications existed during review. Both belonged to `SYSTEM TEST - please disregard`, with the deliberately fictional parent address `booking-verification@example.invalid`. Those two known, unattempted jobs were moved from PENDING to REVIEW with the reason `Excluded from live sending: fictional SYSTEM TEST booking; no email sent.` Their records, thread and history were retained. No customer messages were suppressed. These reviewed jobs must not be reset for live sending.

The helper checks the ready queue again and rejects activation if pending jobs have `.invalid` parent emails or names beginning with `SYSTEM TEST`. This is a bounded activation check, not a general recipient-validation feature.

## Run on the existing VPS

Download the activation helper from its reviewed Git commit, then run it using Python 3 as the VPS administrator. It requires a running `nms-app`, `/root/nms/.env`, the reviewed Docker topology, an active `cron` service, `flock` and `/etc/cron.d`. If a nursery scheduler already exists or sending is already enabled it stops for inspection.

It first starts a candidate without proxy hostnames and validates runtime configuration, public pages, unauthenticated worker rejection and queue readiness. It then switches containers, checks the public contact page and invokes the authenticated worker once. Finally it persists the runtime flags to the host `.env` and installs `/etc/cron.d/nms-tour-emails` for one-minute retries using a non-overlapping flock. Worker logs contain aggregate results only. The endpoint bearer secret is generated locally and read inside the container, not embedded in cron or the command line.

A successful run prints `Automatic nursery booking emails ENABLED`, the rollback container and a backup directory. A failed activation restores the previous container and host configuration and removes its new scheduler. The candidate and new app use the already deployed application image; the helper does not rebuild or alter website source.

`process-tour-emails.cjs` is also committed for subsequent application images. It calls the existing protected worker endpoint and fails if send mode/secret is missing or processing is unavailable. Successful provider acceptance is not a delivery receipt; use the Resend delivery events to verify individual messages. Failed or REVIEW queue jobs still require investigation.

## Verification

Run `python3 tests/tours/email-activation.py` for ten offline tests covering environment preservation, candidate checks before switching, existing-image reuse, scheduler configuration and key isolation, failure recovery, inactive cron, existing schedulers and repeated activation. Run `node --check scripts/process-tour-emails.cjs` for worker syntax validation. These tests mock Docker and network calls and do not claim the VPS activation has completed.

After actual activation, verify the helper output, open Messages in the signed-in browser, and inspect the worker log after a minute. Test through a clearly controlled real email address if an additional end-to-end booking is needed. Avoid editing the old fictional system-test conversation during live operation.

A later execution of the original tour-deployment helper deliberately sets email mode back to disabled. Future deployments must account for the scheduler and explicitly preserve or re-enable the reviewed live email configuration. Never assume a sender key or runtime file inside a container survives replacement unless copied or deployed again.
