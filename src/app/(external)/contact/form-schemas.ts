import { z } from "zod";

const contactDetails = {
  email: z.string().trim().email({ message: "Please enter a valid email address." }),
  phone: z.string().trim().min(5, { message: "Phone number is required." }),
};

export const enquirySchema = z.object({
  ...contactDetails,
  name: z.string().trim().min(2, { message: "Name is required." }),
  message: z.string().trim().min(10, { message: "Message must be at least 10 characters." }),
});

const nurseryDate = new Intl.DateTimeFormat("sv-SE", {
  // Swedish numeric dates use the same YYYY-MM-DD order as the date input.
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const visitDateMessage = "Tours can only be scheduled for future weekdays (Monday - Friday).";

export const tourSchema = z.object({
  ...contactDetails,
  parentName: z.string().trim().min(2, { message: "Parent name is required." }),
  classroom: z.string().trim().min(1, { message: "Please select a classroom." }),
  visitDate: z.iso.date(visitDateMessage).refine((date) => {
    const day = new Date(date).getUTCDay();
    return date >= nurseryDate.format(new Date()) && day >= 1 && day <= 5;
  }, visitDateMessage),
  timeSlot: z.string().trim().min(1, { message: "Please select a time slot." }),
  childAge: z.string().trim().min(1, { message: "Please specify child age / age range." }),
  branch: z.string().trim().min(1, { message: "Please select a branch location." }),
});

export type EnquiryFormValues = z.infer<typeof enquirySchema>;
export type TourFormValues = z.infer<typeof tourSchema>;

export const publicContactSchema = z.discriminatedUnion("type", [
  enquirySchema.extend({ type: z.literal("ENQUIRY") }),
  tourSchema.extend({ type: z.literal("TOUR") }),
]);
