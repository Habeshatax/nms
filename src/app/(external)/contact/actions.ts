"use server";

import { after } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { processTourEmails, tourManagementEnabled } from "@/lib/tours/email-dispatch";
import { tourBranches } from "@/lib/tours/schema";

import { publicContactSchema } from "./form-schemas";

export async function submitContactFormAction(input: unknown) {
  const result = publicContactSchema.safeParse(input);
  if (!result.success) {
    return { success: false, message: result.error.issues[0]?.message ?? "Please check the form and try again." };
  }

  const data = result.data;
  const name = data.type === "TOUR" ? data.parentName : data.name;
  const email = data.email.toLowerCase();
  const subject =
    data.type === "TOUR"
      ? `[Nursery Tour Request] ${data.visitDate} (${data.timeSlot})`
      : `[Website General Enquiry] ${name}`;

  const details =
    data.type === "TOUR"
      ? [
          "🎒 NURSERY TOUR BOOKING REQUEST",
          "",
          `• Parent Name: ${name}`,
          `• Email: ${email}`,
          `• Phone: ${data.phone}`,
          `• Preferred Visit Date: ${data.visitDate}`,
          `• Time Slot: ${data.timeSlot}`,
          `• Classroom Interest: ${data.classroom}`,
          `• Child's Age / Start: ${data.childAge}`,
          `• Branch Location: ${data.branch}`,
        ]
      : [
          "✉️ WEBSITE GENERAL ENQUIRY",
          "",
          `• Sender: ${name}`,
          `• Email: ${email}`,
          `• Phone: ${data.phone}`,
          "",
          "Message Details:",
          data.message,
        ];

  try {
    const messageBody = [...details, "", "Submitted via Bubbly Day Nursery public website."].join("\n");
    const admin = createAdminClient();
    const isManagedTour = data.type === "TOUR" && tourManagementEnabled();
    const response =
      data.type === "TOUR" && isManagedTour
        ? await admin.rpc("submit_tour_request", {
            contact_name: name,
            contact_email: email,
            contact_phone: data.phone,
            request_key: data.requestId,
            visit_date: data.visitDate,
            time_slot: data.timeSlot,
            nursery_branch: data.branch === tourBranches.BRANCH_2.formValue ? "BRANCH_2" : "BRANCH_1",
            message_body: messageBody,
          })
        : await admin.rpc("submit_website_enquiry", {
            contact_name: name,
            contact_email: email,
            contact_phone: data.phone,
            enquiry_subject: subject,
            enquiry_message: messageBody,
          });
    const { error } = response;

    if (!error) {
      if (isManagedTour && response.data) {
        const threadId = String(response.data);
        after(async () => {
          try {
            await processTourEmails(threadId);
          } catch {
            console.error("Tour email processing deferred to scheduled retry");
          }
        });
      }
      return { success: true };
    }

    console.error("Failed to save website enquiry", { type: data.type, code: error.code });
  } catch {
    console.error("Could not connect to Supabase to save website enquiry", { type: data.type });
  }

  return { success: false, message: "We couldn't save your request. Please try again." };
}
