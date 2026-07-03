/* 0001_texting_layer.sql
   Additive texting layer for the smartr8-leads D1.

   IMPORTANT: this migration ONLY adds new tables. It never alters the
   Pages-owned `leads` or `tcpa_consents` tables. All phone numbers are stored
   in E.164 (a leading +1 is added when missing before insert/lookup).

   NOTE: the D1 web console rejects double-dash SQL comments, so this file uses
   block comments only. */

/* One thread per lead/phone. */
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id      TEXT PRIMARY KEY,
  lead_id              TEXT REFERENCES leads(lead_id),
  phone_e164           TEXT NOT NULL,
  last_message_at      INTEGER,
  last_message_preview TEXT,
  unread               INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'open',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone_e164);
CREATE INDEX IF NOT EXISTS idx_conversations_lead ON conversations(lead_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last ON conversations(last_message_at);

/* Every inbound + outbound message. direction = in|out, channel = imessage|sms. */
CREATE TABLE IF NOT EXISTS messages (
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(conversation_id),
  lead_id         TEXT,
  phone_e164      TEXT NOT NULL,
  direction       TEXT NOT NULL,
  channel         TEXT NOT NULL,
  body            TEXT,
  status          TEXT,
  provider_id     TEXT,
  temp_guid       TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone_e164, created_at);

/* SHARED suppression list — single source of truth. The GoHighLevel connector
   must check this table too. phone_e164 is the primary key. */
CREATE TABLE IF NOT EXISTS opt_out (
  phone_e164 TEXT PRIMARY KEY,
  lead_id    TEXT,
  reason     TEXT,
  keyword    TEXT,
  source     TEXT,
  created_at INTEGER NOT NULL
);

/* Audit row for EVERY send attempt, including holds/skips/dedupes. */
CREATE TABLE IF NOT EXISTS send_audit (
  audit_id   TEXT PRIMARY KEY,
  lead_id    TEXT,
  phone_e164 TEXT,
  channel    TEXT,
  body       TEXT,
  status     TEXT,
  reason     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_send_audit_lead ON send_audit(lead_id, created_at);

/* SIDECAR for per-contact texting metadata so update_contact / capability probes
   never mutate the Pages-owned `leads` table. */
CREATE TABLE IF NOT EXISTS contact_texting (
  lead_id          TEXT PRIMARY KEY,
  imessage_capable INTEGER,
  probed           INTEGER NOT NULL DEFAULT 0,
  probed_at        INTEGER,
  tags             TEXT,
  lead_status      TEXT,
  updated_at       INTEGER
);
