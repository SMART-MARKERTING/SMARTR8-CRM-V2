import { Request } from "express";

export interface FeaturePermissionItem {
  id: string;
  label: string;
  group: "Workspace" | "Control Panel";
}

export const FEATURE_PERMISSION_CATALOG: FeaturePermissionItem[] = [
  { id: "dashboard", label: "Dashboard", group: "Workspace" },
  { id: "leads", label: "Leads", group: "Workspace" },
  { id: "leadpool", label: "Lead Pool", group: "Workspace" },
  { id: "pipeline", label: "Pipeline", group: "Workspace" },
  { id: "messages", label: "Conversations", group: "Workspace" },
  { id: "dialer", label: "Dialer", group: "Workspace" },
  { id: "powerdialer", label: "Power Dialer", group: "Workspace" },
  { id: "campaigns", label: "Text Campaigns", group: "Workspace" },
  { id: "tasks", label: "Tasks", group: "Workspace" },
  { id: "calendar", label: "Calendar", group: "Workspace" },
  { id: "documents", label: "File Folders", group: "Control Panel" },
  { id: "automations", label: "Automations", group: "Control Panel" },
  { id: "reports", label: "Reports", group: "Control Panel" },
  { id: "contacts", label: "Contacts", group: "Control Panel" },
  { id: "duplicates", label: "Duplicate Leads", group: "Control Panel" },
  { id: "pastclients", label: "Past Clients", group: "Control Panel" },
  { id: "deleted", label: "Deleted", group: "Control Panel" },
  { id: "email", label: "Email", group: "Control Panel" },
  { id: "fax", label: "Fax", group: "Control Panel" },
  { id: "admin", label: "Admin / Sub-Accounts", group: "Control Panel" },
  { id: "settings", label: "Settings", group: "Control Panel" },
];

export const ALL_FEATURE_PERMISSIONS = FEATURE_PERMISSION_CATALOG.map((item) => item.id);
const KNOWN_FEATURES = new Set(ALL_FEATURE_PERMISSIONS);

export function normalizePermissions(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : [];
  return Array.from(
    new Set(
      raw
        .map((item) => String(item || "").trim())
        .filter((item) => KNOWN_FEATURES.has(item)),
    ),
  );
}

export function parseStoredPermissions(raw: string | null | undefined, role: string): string[] {
  if (role === "admin") return ALL_FEATURE_PERMISSIONS.slice();
  if (raw === null || raw === undefined || raw === "") return ALL_FEATURE_PERMISSIONS.slice();
  try {
    return normalizePermissions(JSON.parse(raw));
  } catch {
    return normalizePermissions(raw);
  }
}

export function serializePermissions(value: unknown): string {
  return JSON.stringify(normalizePermissions(value));
}

export function userHasFeature(user: { role?: string; permissions?: string[] } | null | undefined, feature: string): boolean {
  if (!feature) return true;
  if (!user) return false;
  if (user.role === "admin") return true;
  return Array.isArray(user.permissions) && user.permissions.includes(feature);
}

export function featureForRequest(req: Request): string | null {
  const path = req.path.toLowerCase();
  const method = req.method.toUpperCase();

  if (path === "/" || path === "/v2" || path === "/v2/" || path === "/app" || path === "/console") return null;
  if (path.startsWith("/api/auth/") || path === "/api/ping") return null;
  if (path.startsWith("/webhooks/") || path.startsWith("/api/webhooks/") || path.startsWith("/api/sync/")) return null;
  if (path.startsWith("/media/") || path === "/sw.js") return null;
  if (path.startsWith("/api/users")) return "admin";

  if (path.startsWith("/api/admin") || path.startsWith("/api/audit-events")) return "settings";
  if (path.startsWith("/api/settings") || path.startsWith("/api/messaging-mode")) return "settings";
  if (path.startsWith("/api/dashboard") || path.startsWith("/api/notifications")) return "dashboard";
  if (path.startsWith("/api/pipeline")) return "pipeline";
  if (path.startsWith("/api/lead-pool")) return "leadpool";
  if (path.startsWith("/api/contacts")) return "contacts";
  if (path.startsWith("/api/conversations") || path.startsWith("/api/messages")) return "messages";
  if (path.startsWith("/api/duplicates")) return "duplicates";
  if (path.startsWith("/api/reports")) return "reports";
  if (path.startsWith("/api/email")) return "email";
  if (path.startsWith("/api/fax/media/")) return null;
  if (path.startsWith("/api/fax")) return "fax";
  if (path.startsWith("/api/automations")) return "automations";
  if (path.startsWith("/api/campaigns")) return "campaigns";
  if (path.startsWith("/api/applications")) return "leads";
  if (path.startsWith("/api/documents")) return "documents";
  if (path.startsWith("/api/call-summaries")) return "reports";
  if (path.startsWith("/api/whatsapp")) return "messages";

  if (path.startsWith("/webrtc/token") || path.startsWith("/api/numbers") || path.startsWith("/api/telnyx") || path.startsWith("/api/route-from") || path.startsWith("/api/lookup") || path.startsWith("/api/call-forwarding") || path.startsWith("/calls/conference")) return "dialer";
  if (path.startsWith("/calls/power-dialer")) return "powerdialer";
  if (path === "/calls/click-to-call" && method !== "GET") return "dialer";

  if (path.startsWith("/api/leads")) {
    if (path.includes("/todos")) return "tasks";
    if (path.includes("/calendar-invite")) return "calendar";
    if (path.includes("/documents")) return "documents";
    if (path.includes("/message") || path.includes("/blast")) return "messages";
    if (path.includes("/email")) return "email";
    if (path.includes("/call") || path.includes("/voicemail")) return "dialer";
    if (path.includes("/campaign")) return "campaigns";
    if (path.includes("/mismo") || path.includes("/application") || path.includes("/orders") || path.includes("/sensitive")) return "leads";
    return "leads";
  }

  return null;
}
