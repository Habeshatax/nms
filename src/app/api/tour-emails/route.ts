import { createHash, timingSafeEqual } from "node:crypto";

import { processTourEmails } from "@/lib/tours/email-dispatch";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.TOUR_EMAIL_CRON_SECRET;
  const supplied = request.headers.get("authorization") ?? "";
  if (
    !secret ||
    !timingSafeEqual(
      createHash("sha256").update(supplied).digest(),
      createHash("sha256").update(`Bearer ${secret}`).digest(),
    )
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    return Response.json(await processTourEmails(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Email processing unavailable" }, { status: 503 });
  }
}
