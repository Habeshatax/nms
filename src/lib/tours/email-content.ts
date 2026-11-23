import { z } from "zod";

import { tourBranches, tourStatuses, tourStatusLabels, tourTimeSlots } from "./schema";

export const tourEmailSnapshotSchema = z.object({
  threadId: z.uuid(),
  name: z.string().nullable(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  branch: z.enum(["BRANCH_1", "BRANCH_2"]),
  visitDate: z.iso.date(),
  timeSlot: z.enum(tourTimeSlots),
  status: z.enum(tourStatuses),
});
export type TourEmailSnapshot = z.infer<typeof tourEmailSnapshotSchema>;
export const tourEmailEvents = ["REQUESTED", "CONFIRMED", "RESCHEDULED", "COMPLETED", "CANCELLED"] as const;
export type TourEmailEvent = (typeof tourEmailEvents)[number];

const eventCopy: Record<TourEmailEvent, { subject: string; message: string }> = {
  REQUESTED: {
    subject: "Nursery tour request received",
    message:
      "Thank you for requesting a nursery tour. Your preferred date and time are awaiting confirmation from our team.",
  },
  CONFIRMED: {
    subject: "Your nursery tour is confirmed",
    message: "Your nursery tour is confirmed. We look forward to welcoming you at the setting below.",
  },
  RESCHEDULED: {
    subject: "Your nursery tour details have changed",
    message: "Our team has updated your nursery tour details. Please check the date, time and current status below.",
  },
  COMPLETED: {
    subject: "Thank you for visiting Bubbly Day Nursery",
    message:
      "Our team has marked your nursery tour as completed. Please contact us if you have any questions about next steps.",
  },
  CANCELLED: {
    subject: "Your nursery tour has been cancelled",
    message:
      "Our team has marked your nursery tour as cancelled. Please contact us if you would like to arrange another visit.",
  },
};

export function renderTourEmail(
  snapshot: TourEmailSnapshot,
  event: TourEmailEvent,
  recipientKind: "PARENT" | "BRANCH",
) {
  const branch = tourBranches[snapshot.branch];
  const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeZone: "Europe/London" }).format(
    new Date(`${snapshot.visitDate}T12:00:00Z`),
  );
  const copy = eventCopy[event];
  const isParent = recipientKind === "PARENT";
  const greeting = isParent ? `Hello ${snapshot.name || "there"},` : `Hello ${branch.name} team,`;
  const introduction = isParent ? copy.message : `A nursery tour has been updated. Event: ${event.toLowerCase()}.`;
  const details = [
    `Date: ${date}`,
    `Time: ${snapshot.timeSlot} (UK time)`,
    `Status: ${tourStatusLabels[snapshot.status]}`,
    `Setting: ${branch.name}`,
    `Address: ${branch.address}`,
    `Reference: ${snapshot.threadId}`,
  ];
  if (!isParent) {
    details.push(
      `Parent: ${snapshot.name || "Not provided"}`,
      `Email: ${snapshot.email || "Not provided"}`,
      `Phone: ${snapshot.phone || "Not provided"}`,
    );
  }
  return {
    subject: isParent ? copy.subject : `[Nursery tour] ${copy.subject}`,
    text: [
      greeting,
      "",
      introduction,
      "",
      ...details,
      "",
      isParent
        ? `Questions or changes? Please reply to ${branch.email}.`
        : "Open Messages in the staff dashboard to manage this request.",
      "",
      "Bubbly Day Nursery",
    ].join("\n"),
  };
}
