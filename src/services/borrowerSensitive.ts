import crypto from "crypto";
import { config } from "../config";
import { db } from "../store/db";
import { Lead, logActivity, updateLead } from "./leads";

export interface BorrowerSensitiveData {
  dob?: string;
  ssn?: string;
  ssnLast4?: string;
  creditScore?: string;
  monthlyIncome?: string;
  assetSummary?: string;
  employer?: string;
  applicationCompletedAt?: string;
  coBorrower?: BorrowerSensitiveParty;
}

export interface BorrowerSensitiveParty {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  dob?: string;
  ssn?: string;
  ssnLast4?: string;
  creditScore?: string;
  monthlyIncome?: string;
  assetSummary?: string;
  employer?: string;
}

export interface BorrowerSensitiveRecord {
  configured: boolean;
  retentionDays: number;
  data: BorrowerSensitiveData;
  updatedAt: number | null;
  expiresAt: number | null;
  keyId: string | null;
}

interface SensitiveRow {
  lead_id: string;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  key_id: string;
  iv: string;
  auth_tag: string;
  ciphertext: string;
}

const PLAINTEXT_CUSTOM_KEYS = [
  "dob",
  "ssn",
  "ssn_last4",
  "credit_score",
  "monthly_income",
  "asset_summary",
  "employer",
  "income_source",
];

function rawKey(): string {
  return config.borrowerData.encryptionKey.trim();
}

export function borrowerSensitiveConfigured(): boolean {
  return Boolean(rawKey());
}

function keyMaterial(): Buffer {
  const raw = rawKey();
  if (!raw) throw new Error("BORROWER_DATA_KEY is not configured");
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
  } catch {
    // Fall through to a SHA-256 derivation for long passphrase-style secrets.
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function keyId(): string {
  return crypto.createHash("sha256").update(keyMaterial()).digest("hex").slice(0, 16);
}

function encrypt(data: BorrowerSensitiveData): { iv: string; authTag: string; ciphertext: string; keyId: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const plaintext = JSON.stringify(data);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    keyId: keyId(),
  };
}

function decrypt(row: SensitiveRow): BorrowerSensitiveData {
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyMaterial(), Buffer.from(row.iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return normalizeSensitiveData(JSON.parse(plaintext) as BorrowerSensitiveData);
}

function cleanString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s || undefined;
}

function digits(value: unknown, max: number): string | undefined {
  const s = cleanString(value)?.replace(/\D/g, "").slice(0, max);
  return s || undefined;
}

export function normalizeSensitiveData(input: BorrowerSensitiveData): BorrowerSensitiveData {
  const ssn = digits(input.ssn, 9);
  const ssnLast4 = ssn && ssn.length >= 4 ? ssn.slice(-4) : digits(input.ssnLast4, 4);
  const coBorrower = normalizeSensitiveParty(input.coBorrower);
  return {
    dob: cleanString(input.dob),
    ssn,
    ssnLast4,
    creditScore: digits(input.creditScore, 3),
    monthlyIncome: cleanString(input.monthlyIncome),
    assetSummary: cleanString(input.assetSummary),
    employer: cleanString(input.employer),
    applicationCompletedAt: cleanString(input.applicationCompletedAt),
    ...(Object.keys(coBorrower).length ? { coBorrower } : {}),
  };
}

function normalizeSensitiveParty(input?: BorrowerSensitiveParty): BorrowerSensitiveParty {
  if (!input) return {};
  const ssn = digits(input.ssn, 9);
  const ssnLast4 = ssn && ssn.length >= 4 ? ssn.slice(-4) : digits(input.ssnLast4, 4);
  return stripEmpty({
    firstName: cleanString(input.firstName),
    lastName: cleanString(input.lastName),
    email: cleanString(input.email),
    phone: cleanString(input.phone),
    dob: cleanString(input.dob),
    ssn,
    ssnLast4,
    creditScore: digits(input.creditScore, 3),
    monthlyIncome: cleanString(input.monthlyIncome),
    assetSummary: cleanString(input.assetSummary),
    employer: cleanString(input.employer),
  }) as BorrowerSensitiveParty;
}

function stripEmpty<T extends object>(data: T): T {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== "")) as T;
}

function retentionExpiresAt(now: number): number {
  const days = Number.isFinite(config.borrowerData.retentionDays) ? Math.max(1, config.borrowerData.retentionDays) : 2555;
  return now + days * 24 * 60 * 60_000;
}

function emptyRecord(): BorrowerSensitiveRecord {
  return {
    configured: borrowerSensitiveConfigured(),
    retentionDays: config.borrowerData.retentionDays,
    data: {},
    updatedAt: null,
    expiresAt: null,
    keyId: null,
  };
}

export function getBorrowerSensitiveData(leadId: string, opts: { audit?: boolean; author?: string } = {}): BorrowerSensitiveRecord {
  if (!borrowerSensitiveConfigured()) return emptyRecord();
  const row = db.prepare(`SELECT * FROM lead_sensitive_data WHERE lead_id = ?`).get(leadId) as SensitiveRow | undefined;
  if (!row) return emptyRecord();
  const data = decrypt(row);
  if (opts.audit) {
    logActivity(leadId, {
      type: "sensitive_data",
      direction: "system",
      channel: "system",
      body: "Portal sensitive borrower data viewed",
      status: "viewed",
      meta: { author: opts.author ?? null, keyId: row.key_id },
    });
  }
  return {
    configured: true,
    retentionDays: config.borrowerData.retentionDays,
    data,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    keyId: row.key_id,
  };
}

export function saveBorrowerSensitiveData(lead: Lead, data: BorrowerSensitiveData, author?: string): BorrowerSensitiveRecord {
  if (!borrowerSensitiveConfigured()) throw new Error("BORROWER_DATA_KEY is not configured");
  const now = Date.now();
  const normalized = stripEmpty(normalizeSensitiveData(data));
  const sealed = encrypt(normalized);
  const existing = db.prepare(`SELECT lead_id FROM lead_sensitive_data WHERE lead_id = ?`).get(lead.id);
  if (existing) {
    db.prepare(
      `UPDATE lead_sensitive_data
          SET updated_at = ?, expires_at = ?, key_id = ?, iv = ?, auth_tag = ?, ciphertext = ?
        WHERE lead_id = ?`,
    ).run(now, retentionExpiresAt(now), sealed.keyId, sealed.iv, sealed.authTag, sealed.ciphertext, lead.id);
  } else {
    db.prepare(
      `INSERT INTO lead_sensitive_data (lead_id, created_at, updated_at, expires_at, key_id, iv, auth_tag, ciphertext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(lead.id, now, now, retentionExpiresAt(now), sealed.keyId, sealed.iv, sealed.authTag, sealed.ciphertext);
  }

  const custom = { ...(lead.custom || {}) };
  for (const key of PLAINTEXT_CUSTOM_KEYS) delete custom[key];
  if (normalized.applicationCompletedAt) custom.application_completed_at = normalized.applicationCompletedAt;
  else delete custom.application_completed_at;
  updateLead(lead.id, { custom });

  logActivity(lead.id, {
    type: "sensitive_data",
    direction: "system",
    channel: "system",
    body: "Portal sensitive borrower data saved to encrypted storage",
    status: "saved",
    meta: { author: author ?? null, keyId: sealed.keyId, storedFields: Object.keys(normalized).sort() },
  });
  return getBorrowerSensitiveData(lead.id);
}
