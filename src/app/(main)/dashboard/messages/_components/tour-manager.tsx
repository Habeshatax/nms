"use client";

import * as React from "react";

import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  tourBranches,
  tourStatuses,
  tourStatusLabels,
  tourTimeSlots,
  type TourBranch,
  type TourStatus,
  type TourThread,
} from "@/lib/tours/schema";

import { getTourEmailDetailsAction, updateTourAction } from "../actions";

interface TourManagerProps {
  thread: TourThread;
  messageText: string;
  onUpdated: (thread: TourThread) => void;
}

type EmailDetails = Awaited<ReturnType<typeof getTourEmailDetailsAction>>;
const emailStateLabels: Record<string, string> = {
  PENDING: "Queued",
  SENDING: "Sending",
  SENT: "Accepted by email provider",
  FAILED: "Failed",
  REVIEW: "Needs review",
};

export function TourManager({ thread, messageText, onUpdated }: TourManagerProps) {
  // Older tours stored their date/time in the subject and their branch in the first message.
  const legacyDate = thread.subject.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
  const legacyTime = tourTimeSlots.find((slot) => thread.subject.includes(slot)) ?? tourTimeSlots[0];
  const legacyBranch = messageText.includes("Branch 2")
    ? "BRANCH_2"
    : messageText.includes("Branch 1")
      ? "BRANCH_1"
      : "";
  const [status, setStatus] = React.useState<TourStatus>(thread.tour_status ?? "REQUESTED");
  const [visitDate, setVisitDate] = React.useState(thread.tour_date ?? legacyDate);
  const [timeSlot, setTimeSlot] = React.useState(thread.tour_time_slot ?? legacyTime);
  const [branch, setBranch] = React.useState<TourBranch | "">(thread.tour_branch ?? legacyBranch);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [emails, setEmails] = React.useState<EmailDetails | null>(null);
  const [loadingEmails, setLoadingEmails] = React.useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await updateTourAction({
        threadId: thread.id,
        revision: thread.tour_revision ?? 0,
        status,
        visitDate,
        timeSlot,
        branch,
      });
      if (!result.success) {
        setError(result.message);
        return;
      }
      toast.success("Tour updated");
      onUpdated(result.thread);
    } catch {
      setError("The tour could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function loadEmails() {
    setLoadingEmails(true);
    try {
      setEmails(await getTourEmailDetailsAction(thread.id));
    } catch {
      toast.error("Could not load booking emails");
    } finally {
      setLoadingEmails(false);
    }
  }

  return (
    <section aria-label="Tour management" className="flex flex-col gap-4">
      <h3 className="font-semibold">Tour details</h3>
      <form onSubmit={save} className="flex flex-col gap-4">
        <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`tour-status-${thread.id}`}>Status</FieldLabel>
            <NativeSelect
              id={`tour-status-${thread.id}`}
              value={status}
              disabled={saving}
              onChange={(event) => setStatus(event.target.value as TourStatus)}
            >
              {tourStatuses.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {tourStatusLabels[value]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`tour-date-${thread.id}`}>Visit date</FieldLabel>
            <Input
              id={`tour-date-${thread.id}`}
              type="date"
              value={visitDate}
              disabled={saving}
              required
              onChange={(event) => setVisitDate(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`tour-slot-${thread.id}`}>Time slot</FieldLabel>
            <NativeSelect
              id={`tour-slot-${thread.id}`}
              value={timeSlot}
              disabled={saving}
              onChange={(event) => setTimeSlot(event.target.value)}
            >
              {tourTimeSlots.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {value}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>Times are local to London.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`tour-branch-${thread.id}`}>Nursery branch</FieldLabel>
            <NativeSelect
              id={`tour-branch-${thread.id}`}
              value={branch}
              disabled={saving}
              required
              onChange={(event) => setBranch(event.target.value as TourBranch)}
            >
              <NativeSelectOption value="" disabled>
                Select a branch
              </NativeSelectOption>
              {Object.entries(tourBranches).map(([key, value]) => (
                <NativeSelectOption key={key} value={key}>
                  {value.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </FieldGroup>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={saving} className="self-start">
          {saving ? "Saving tour..." : "Save tour details"}
        </Button>
      </form>
      <Button type="button" variant="outline" disabled={loadingEmails} onClick={loadEmails} className="self-start">
        {loadingEmails ? "Loading emails..." : "View booking emails"}
      </Button>
      {emails && (
        <div className="flex flex-col gap-3">
          <Alert>
            <AlertDescription>
              {emails.mode === "disabled"
                ? "Email sending is disabled. New booking emails remain queued for review."
                : emails.mode === "test"
                  ? "Test mode sends all booking emails to the configured test inbox."
                  : "Automatic booking emails are enabled."}
            </AlertDescription>
          </Alert>
          {emails.items.length === 0 && (
            <p className="text-sm text-muted-foreground">No booking emails queued for this tour.</p>
          )}
          {emails.items.map((email) => (
            <details key={email.id} className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm">
                {email.recipientKind === "PARENT"
                  ? "Parent"
                  : email.recipientKind === "PREVIOUS_BRANCH"
                    ? "Previous branch"
                    : "Branch"}{" "}
                — {email.subject} <Badge variant="outline">{emailStateLabels[email.state] ?? email.state}</Badge>
              </summary>
              {email.error && <p className="mt-2 text-sm text-destructive">{email.error}</p>}
              <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm">{email.text}</pre>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
