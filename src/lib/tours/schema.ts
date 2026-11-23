import { z } from "zod";

export const tourStatuses = ["REQUESTED", "CONFIRMED", "COMPLETED", "CANCELLED"] as const;
export type TourStatus = (typeof tourStatuses)[number];
export const tourStatusLabels: Record<TourStatus, string> = {
  REQUESTED: "Requested",
  CONFIRMED: "Confirmed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};
export const tourTimeSlots = ["10:00 AM - 11:00 AM", "02:00 PM - 03:00 PM"] as const;
export const tourBranches = {
  BRANCH_1: {
    name: "Branch 1 - Galleywall Road",
    address: "Manor Methodist Church, Galleywall Road, London, SE16 3PB",
    email: "bubblydnursery@gmail.com",
    formValue: "Branch 1 (Manor Methodist Church, Galleywall Road, SE16 3PB)",
  },
  BRANCH_2: {
    name: "Branch 2 - Corbetts Lane",
    address: "St Gertrudes Church Hall, Corbetts Lane, London, SE16 2BQ",
    email: "bubblyd2nursery@gmail.com",
    formValue: "Branch 2 (St Gertrudes Church Hall, Corbetts Lane, London, SE16 2BQ)",
  },
} as const;
export type TourBranch = keyof typeof tourBranches;

export function londonToday() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/London" }).format(new Date());
}

export function isActiveTourDate(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return date >= londonToday() && day >= 1 && day <= 5;
}

export const tourUpdateSchema = z
  .object({
    threadId: z.uuid(),
    revision: z.number().int().nonnegative(),
    status: z.enum(tourStatuses),
    visitDate: z.iso.date(),
    timeSlot: z.enum(tourTimeSlots),
    branch: z.enum(["BRANCH_1", "BRANCH_2"]),
  })
  .refine((data) => !["REQUESTED", "CONFIRMED"].includes(data.status) || isActiveTourDate(data.visitDate), {
    message: "Choose a current or future weekday for an active tour.",
    path: ["visitDate"],
  });

export interface TourThread {
  id: string;
  subject: string;
  tour_status?: TourStatus | null;
  tour_date?: string | null;
  tour_time_slot?: string | null;
  tour_branch?: TourBranch | null;
  tour_revision?: number;
}
