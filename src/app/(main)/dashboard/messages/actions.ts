"use server";

import { after } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { renderTourEmail, tourEmailSnapshotSchema, type TourEmailEvent } from "@/lib/tours/email-content";
import { processTourEmails, tourEmailMode, tourManagementEnabled } from "@/lib/tours/email-dispatch";
import { tourUpdateSchema, type TourThread } from "@/lib/tours/schema";

async function getThreadAccess(threadId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Unauthorized: Log in required.");
  }

  const adminClient = createAdminClient();
  const { data: roleMappings, error: rolesError } = await supabase
    .from("user_roles")
    .select("roles(name)")
    .eq("user_id", user.id);

  if (rolesError) {
    throw new Error("Failed to verify message access.");
  }

  const roleNames = ((roleMappings ?? []) as unknown as Array<{ roles: { name: string } | null }>).map(
    (mapping) => mapping.roles?.name,
  );
  const isStaff = roleNames.some((role) => role === "NURSERY_MANAGER" || role === "STAFF" || role === "SUPER_ADMIN");

  if (!isStaff) {
    const { data: thread, error } = await adminClient
      .from("chat_threads")
      .select("id, parents!chat_threads_parent_id_fkey!inner(id)")
      .eq("id", threadId)
      .eq("parents.profile_id", user.id)
      .maybeSingle();

    if (error || !thread) {
      throw new Error("This conversation is unavailable.");
    }
  }

  return { adminClient, userId: user.id, isStaff };
}

export async function getThreadMessagesAction(threadId: string) {
  const { adminClient } = await getThreadAccess(threadId);
  const { data: messages, error } = await adminClient
    .from("chat_messages")
    .select("*, sender:profiles!chat_messages_sender_id_fkey(first_name, last_name, email)")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message || "Failed to load thread messages.");
  }

  return { success: true, messages: messages || [] };
}

export async function sendChatMessageAction(threadId: string, messageText: string) {
  const { adminClient, userId } = await getThreadAccess(threadId);
  const { data: newMessage, error } = await adminClient
    .from("chat_messages")
    .insert({
      thread_id: threadId,
      sender_id: userId,
      message: messageText.trim(),
      is_read: false,
    })
    .select("*, sender:profiles!chat_messages_sender_id_fkey(first_name, last_name, email)")
    .single();

  if (error) {
    throw new Error(error.message || "Failed to send chat message.");
  }

  return { success: true, message: newMessage };
}

export async function deleteThreadAction(threadId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Unauthorized: Log in required.");
  }

  const { data: roleMappings } = await supabase.from("user_roles").select("roles(name)").eq("user_id", user.id);

  const roleNames =
    (roleMappings as unknown as Array<{ roles: { name: string } | null }>)
      ?.map((rm) => rm.roles?.name)
      .filter(Boolean) || [];
  const isStaff =
    roleNames.includes("NURSERY_MANAGER") || roleNames.includes("STAFF") || roleNames.includes("SUPER_ADMIN");

  if (!isStaff) {
    throw new Error("Forbidden: Only staff can delete message threads.");
  }

  const adminClient = createAdminClient();

  // First delete associated messages
  await adminClient.from("chat_messages").delete().eq("thread_id", threadId);

  // Then delete thread
  const { error } = await adminClient.from("chat_threads").delete().eq("id", threadId);

  if (error) {
    throw new Error(error.message || "Failed to delete message thread.");
  }

  return { success: true };
}

export async function deleteMessageAction(messageId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Unauthorized: Log in required.");
  }

  const { data: roleMappings } = await supabase.from("user_roles").select("roles(name)").eq("user_id", user.id);

  const roleNames =
    (roleMappings as unknown as Array<{ roles: { name: string } | null }>)
      ?.map((rm) => rm.roles?.name)
      .filter(Boolean) || [];
  const isStaff =
    roleNames.includes("NURSERY_MANAGER") || roleNames.includes("STAFF") || roleNames.includes("SUPER_ADMIN");

  if (!isStaff) {
    throw new Error("Forbidden: Only staff can delete messages.");
  }

  const adminClient = createAdminClient();
  const { error } = await adminClient.from("chat_messages").delete().eq("id", messageId);

  if (error) {
    throw new Error(error.message || "Failed to delete message.");
  }

  return { success: true };
}

export async function updateTourAction(input: unknown) {
  if (!tourManagementEnabled()) return { success: false as const, message: "Tour management is disabled." };
  const parsed = tourUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false as const, message: parsed.error.issues[0]?.message ?? "Check the tour details." };
  }
  const data = parsed.data;
  const { adminClient, userId, isStaff } = await getThreadAccess(data.threadId);
  if (!isStaff) return { success: false as const, message: "Only nursery staff can manage tours." };

  const { data: thread, error } = await adminClient
    .rpc("update_tour_request", {
      target_thread_id: data.threadId,
      expected_revision: data.revision,
      next_status: data.status,
      visit_date: data.visitDate,
      time_slot: data.timeSlot,
      nursery_branch: data.branch,
      actor_id: userId,
    })
    .single();
  if (error) {
    return {
      success: false as const,
      message: error.message.includes("TOUR_CONFLICT")
        ? "Another staff member updated this tour. Refresh Messages to load the latest details."
        : "The tour could not be updated. Check its details and try again.",
    };
  }
  after(async () => {
    try {
      await processTourEmails(data.threadId);
    } catch {
      console.error("Tour email processing deferred to scheduled retry");
    }
  });
  return { success: true as const, thread: thread as TourThread };
}

export async function getTourEmailDetailsAction(threadId: string) {
  if (!tourManagementEnabled()) throw new Error("Tour management is disabled.");
  const { adminClient, isStaff } = await getThreadAccess(threadId);
  if (!isStaff) throw new Error("Only nursery staff can view booking emails.");
  const { data, error } = await adminClient
    .from("tour_email_outbox")
    .select("id,recipient_kind,event,state,attempts,last_error,sent_at,created_at,snapshot")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error("Booking email details are unavailable.");

  return {
    mode: tourEmailMode(),
    items: (data ?? []).map((item) => {
      const parsed = tourEmailSnapshotSchema.safeParse(item.snapshot);
      const content = parsed.success
        ? renderTourEmail(
            parsed.data,
            item.event as TourEmailEvent,
            item.recipient_kind === "PARENT" ? "PARENT" : "BRANCH",
          )
        : { subject: "Booking email needs attention", text: "The saved tour details are incomplete." };
      return {
        id: String(item.id),
        recipientKind: String(item.recipient_kind),
        event: String(item.event),
        state: String(item.state),
        attempts: Number(item.attempts),
        error: item.last_error as string | null,
        sentAt: item.sent_at as string | null,
        ...content,
      };
    }),
  };
}
