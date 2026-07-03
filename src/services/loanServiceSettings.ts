import { config } from "../config";
import { getMeta, setMeta } from "../store/db";

export type SettlementVendorKind = "title" | "flood";
export type SettlementVendorMode = "manual" | "live";

export interface SettlementVendorSettings {
  kind: SettlementVendorKind;
  enabled: boolean;
  mode: SettlementVendorMode;
  vendorName: string;
  apiBase: string;
  apiKey: string;
  username: string;
  password: string;
  accountId: string;
  defaultProduct: string;
  notes: string;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface PublicSettlementVendorSettings extends Omit<SettlementVendorSettings, "apiKey" | "password"> {
  configured: boolean;
  liveReady: boolean;
  apiKeySet: boolean;
  passwordSet: boolean;
  apiKeyPreview: string;
  passwordPreview: string;
}

const META_PREFIX = "loan_services:";

function blank(kind: SettlementVendorKind): SettlementVendorSettings {
  return {
    kind,
    enabled: false,
    mode: "manual",
    vendorName: kind === "title" ? "Title vendor" : "Flood vendor",
    apiBase: "",
    apiKey: "",
    username: "",
    password: "",
    accountId: "",
    defaultProduct: kind === "title" ? "title_commitment" : "flood_determination",
    notes: "",
    updatedAt: null,
    updatedBy: null,
  };
}

function envSettings(kind: SettlementVendorKind): SettlementVendorSettings {
  const base = blank(kind);
  if (kind === "title") {
    base.apiBase = config.loanServices.titleApiBase;
    base.apiKey = config.loanServices.titleApiKey;
  } else {
    base.apiBase = config.loanServices.floodApiBase;
    base.apiKey = config.loanServices.floodApiKey;
  }
  if (base.apiBase || base.apiKey) {
    base.enabled = true;
    base.mode = "manual";
    base.vendorName = kind === "title" ? "Configured title vendor" : "Configured flood vendor";
  }
  return base;
}

function cleanMode(value: unknown): SettlementVendorMode {
  return value === "live" ? "live" : "manual";
}

function cleanString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function cleanSecret(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const clean = value.trim();
  return clean || fallback;
}

function fromStored(kind: SettlementVendorKind, raw: string | null): SettlementVendorSettings | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SettlementVendorSettings>;
    return {
      ...blank(kind),
      ...parsed,
      kind,
      enabled: Boolean(parsed.enabled),
      mode: cleanMode(parsed.mode),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : null,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
    };
  } catch {
    return null;
  }
}

export function getSettlementVendorSettings(kind: SettlementVendorKind): SettlementVendorSettings {
  return fromStored(kind, getMeta(META_PREFIX + kind)) || envSettings(kind);
}

export function liveReady(settings: SettlementVendorSettings): boolean {
  return Boolean(settings.enabled && settings.mode === "live" && settings.apiBase && (settings.apiKey || (settings.username && settings.password)));
}

export function serviceConfigured(settings: SettlementVendorSettings): boolean {
  return Boolean(settings.enabled || liveReady(settings));
}

function preview(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 6) return "set";
  return `${secret.slice(0, 3)}...${secret.slice(-3)}`;
}

export function publicSettlementVendorSettings(settings: SettlementVendorSettings): PublicSettlementVendorSettings {
  const { apiKey, password, ...rest } = settings;
  return {
    ...rest,
    configured: serviceConfigured(settings),
    liveReady: liveReady(settings),
    apiKeySet: Boolean(apiKey),
    passwordSet: Boolean(password),
    apiKeyPreview: preview(apiKey),
    passwordPreview: password ? "set" : "",
  };
}

export function listSettlementVendorSettings(): {
  title: PublicSettlementVendorSettings;
  flood: PublicSettlementVendorSettings;
} {
  return {
    title: publicSettlementVendorSettings(getSettlementVendorSettings("title")),
    flood: publicSettlementVendorSettings(getSettlementVendorSettings("flood")),
  };
}

export function saveSettlementVendorSettings(
  kind: SettlementVendorKind,
  input: Record<string, unknown>,
  author?: string,
): PublicSettlementVendorSettings {
  const existing = getSettlementVendorSettings(kind);
  const next: SettlementVendorSettings = {
    ...existing,
    enabled: Boolean(input.enabled),
    mode: cleanMode(input.mode),
    vendorName: cleanString(input.vendorName, existing.vendorName || blank(kind).vendorName),
    apiBase: cleanString(input.apiBase, existing.apiBase).replace(/\/+$/, ""),
    apiKey: cleanSecret(input.apiKey, existing.apiKey),
    username: cleanString(input.username, existing.username),
    password: cleanSecret(input.password, existing.password),
    accountId: cleanString(input.accountId, existing.accountId),
    defaultProduct: cleanString(input.defaultProduct, existing.defaultProduct || blank(kind).defaultProduct),
    notes: cleanString(input.notes, existing.notes),
    updatedAt: Date.now(),
    updatedBy: author ?? null,
  };
  if (input.clearApiKey === true) next.apiKey = "";
  if (input.clearPassword === true) next.password = "";
  setMeta(META_PREFIX + kind, JSON.stringify(next));
  return publicSettlementVendorSettings(next);
}
