import type { SubmittedOrder, TransferDraft, UserSession } from "../types";

const wait = (ms = 650) => new Promise((resolve) => setTimeout(resolve, ms));

export async function loginWithPlaceholder(email: string, password: string): Promise<UserSession> {
  await wait();
  if (!email.trim() || !password.trim()) {
    throw new Error("Enter username/email and password.");
  }
  return {
    name: email.includes("@") ? email.split("@")[0] : email,
    email,
    role: "Master",
    workspace: "HaderaPay Workspace"
  };
}

export async function signupWithPlaceholder(input: {
  name: string;
  email: string;
  password: string;
  inviteCode: string;
}): Promise<UserSession> {
  await wait();
  if (!input.name.trim() || !input.email.trim() || input.password.length < 6 || !input.inviteCode.trim()) {
    throw new Error("Complete signup details and use a password with at least 6 characters.");
  }
  return {
    name: input.name,
    email: input.email,
    role: "Actor",
    workspace: "HaderaPay Workspace"
  };
}

export async function submitTransferOrderPlaceholder(draft: TransferDraft): Promise<SubmittedOrder> {
  await wait(800);
  if (!draft.senderName.trim() || !draft.receiverName.trim()) {
    throw new Error("Sender and receiver names are required.");
  }
  return {
    orderId: `ORD-${Math.floor(1000 + Math.random() * 9000)}`,
    status: "Pending Master Approval",
    createdAt: new Date().toISOString()
  };
}
