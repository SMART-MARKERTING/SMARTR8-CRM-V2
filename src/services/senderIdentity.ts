import { brand, EmailSenderProfile } from "../brand";
import { config } from "../config";
import { User, getUser, primaryAdmin } from "./auth";

export interface SenderIdentity extends EmailSenderProfile {
  userId: string | null;
  username: string;
  email: string;
  replyTo: string;
  signature: string;
}

function configuredAddresses(): Set<string> {
  const raw = [config.email.fromEmail, config.email.fromAliases, config.email.replyTo, ...brand.sendingEmails]
    .filter(Boolean)
    .join(",");
  return new Set(raw.split(/[,;\n]+/).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

export function userEmailIsSendable(email: string | null | undefined): boolean {
  const value = String(email || "").trim().toLowerCase();
  if (!value || !value.includes("@")) return false;
  const domain = value.split("@").pop() || "";
  return domain === config.email.userDomain || configuredAddresses().has(value);
}

export function senderIdentityForUser(user: User | null | undefined): SenderIdentity {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim() || user?.name || brand.sender;
  const firstName = user?.first_name || name.split(/\s+/)[0] || "Mykoal";
  const lastName = user?.last_name || name.split(/\s+/).slice(1).join(" ");
  const email = userEmailIsSendable(user?.email) ? String(user?.email) : config.email.fromEmail || brand.fromEmailDefault;
  return {
    userId: user?.id || null,
    username: user?.username || "admin",
    name,
    firstName,
    lastName,
    email,
    replyTo: email || config.email.replyTo || config.email.fromEmail,
    signature: String(user?.email_signature || "").trim(),
  };
}

export function senderIdentityForOwner(ownerUserId: string | null | undefined): SenderIdentity {
  return senderIdentityForUser((ownerUserId && getUser(ownerUserId)) || primaryAdmin());
}

export function personalizeSenderTemplate(template: string | undefined, sender: SenderIdentity): string {
  if (!template) return "";
  const values: Record<string, string> = {
    user_first_name: sender.firstName || sender.name,
    user_last_name: sender.lastName || "",
    user_name: sender.name,
    user_email: sender.email,
    sender_first_name: sender.firstName || sender.name,
    sender_last_name: sender.lastName || "",
    sender_name: sender.name,
    sender_email: sender.email,
  };
  let output = template.replace(/\{\{\s*(user_first_name|user_last_name|user_name|user_email|sender_first_name|sender_last_name|sender_name|sender_email)\s*\}\}/gi, (_match, key: string) => values[key.toLowerCase()] || "");
  if (sender.name.toLowerCase() !== brand.sender.toLowerCase()) {
    output = output.replace(/Mykoal DeShazo/g, sender.name).replace(/\bMykoal\b/g, sender.firstName || sender.name);
  }
  return output;
}
