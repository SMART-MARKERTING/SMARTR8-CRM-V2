import { createHmac } from "crypto";
import { config } from "../config";
import { log } from "../logger";
import { getMeta, setMeta } from "../store/db";
import { mediaPathFor, publicMediaUrl, writeMediaFile } from "./media";

const META_KEY = "elevenlabs:settings";
const API_BASE = "https://api.elevenlabs.io/v1";

export interface ElevenLabsSettings {
  enabled: boolean;
  apiKey: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
  defaultVoicemailText: string;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface PublicElevenLabsSettings extends Omit<ElevenLabsSettings, "apiKey"> {
  configured: boolean;
  apiKeySet: boolean;
  apiKeyPreview: string;
}

export interface GeneratedVoiceAudio {
  file: string;
  url: string;
  cached: boolean;
}

function blank(): ElevenLabsSettings {
  return {
    enabled: false,
    apiKey: "",
    voiceId: "",
    modelId: "eleven_multilingual_v2",
    outputFormat: "mp3_44100_128",
    stability: 0.45,
    similarityBoost: 0.75,
    style: 0,
    useSpeakerBoost: true,
    defaultVoicemailText:
      "Hi {{first_name}}, this is Mykoal with Adaxa Home. I just wanted to follow up about your mortgage options. I will also send you a quick text with the next step.",
    updatedAt: null,
    updatedBy: null,
  };
}

function envSettings(): ElevenLabsSettings {
  return {
    ...blank(),
    enabled: Boolean(config.elevenLabs.apiKey && config.elevenLabs.voiceId),
    apiKey: config.elevenLabs.apiKey,
    voiceId: config.elevenLabs.voiceId,
    modelId: config.elevenLabs.modelId || "eleven_multilingual_v2",
    outputFormat: cleanOutputFormat(config.elevenLabs.outputFormat),
  };
}

function cleanString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function cleanSecret(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const clean = value.trim();
  return clean || fallback;
}

function cleanNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanOutputFormat(value: unknown): string {
  const s = cleanString(value, "mp3_44100_128");
  return /^mp3_\d+_\d+$/.test(s) ? s : "mp3_44100_128";
}

function fromStored(raw: string | null): ElevenLabsSettings | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ElevenLabsSettings>;
    const fallback = envSettings();
    return {
      ...blank(),
      ...fallback,
      ...parsed,
      enabled: Boolean(parsed.enabled),
      apiKey: cleanSecret(parsed.apiKey, fallback.apiKey),
      voiceId: cleanString(parsed.voiceId, fallback.voiceId),
      modelId: cleanString(parsed.modelId, fallback.modelId || "eleven_multilingual_v2"),
      outputFormat: cleanOutputFormat(parsed.outputFormat || fallback.outputFormat),
      stability: cleanNumber(parsed.stability, fallback.stability, 0, 1),
      similarityBoost: cleanNumber(parsed.similarityBoost, fallback.similarityBoost, 0, 1),
      style: cleanNumber(parsed.style, fallback.style, 0, 1),
      useSpeakerBoost: parsed.useSpeakerBoost !== false,
      defaultVoicemailText: cleanString(parsed.defaultVoicemailText, fallback.defaultVoicemailText),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : null,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
    };
  } catch {
    return null;
  }
}

function preview(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "set";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function getElevenLabsSettings(): ElevenLabsSettings {
  return fromStored(getMeta(META_KEY)) || envSettings();
}

export function elevenLabsConfigured(settings = getElevenLabsSettings()): boolean {
  return Boolean(settings.enabled && settings.apiKey && settings.voiceId);
}

export function publicElevenLabsSettings(settings = getElevenLabsSettings()): PublicElevenLabsSettings {
  const { apiKey, ...rest } = settings;
  return {
    ...rest,
    configured: elevenLabsConfigured(settings),
    apiKeySet: Boolean(apiKey),
    apiKeyPreview: preview(apiKey),
  };
}

export function saveElevenLabsSettings(input: Record<string, unknown>, author?: string): PublicElevenLabsSettings {
  const existing = getElevenLabsSettings();
  const next: ElevenLabsSettings = {
    ...existing,
    enabled: Boolean(input.enabled),
    apiKey: cleanSecret(input.apiKey, existing.apiKey),
    voiceId: cleanString(input.voiceId, existing.voiceId),
    modelId: cleanString(input.modelId, existing.modelId || "eleven_multilingual_v2"),
    outputFormat: cleanOutputFormat(input.outputFormat || existing.outputFormat),
    stability: cleanNumber(input.stability, existing.stability, 0, 1),
    similarityBoost: cleanNumber(input.similarityBoost, existing.similarityBoost, 0, 1),
    style: cleanNumber(input.style, existing.style, 0, 1),
    useSpeakerBoost: input.useSpeakerBoost !== false,
    defaultVoicemailText: cleanString(input.defaultVoicemailText, existing.defaultVoicemailText),
    updatedAt: Date.now(),
    updatedBy: author ?? null,
  };
  if (input.clearApiKey === true) next.apiKey = "";
  setMeta(META_KEY, JSON.stringify(next));
  return publicElevenLabsSettings(next);
}

function cacheFileName(settings: ElevenLabsSettings, text: string): string {
  const hash = createHmac("sha256", settings.apiKey || "elevenlabs")
    .update(JSON.stringify({
      text,
      voiceId: settings.voiceId,
      modelId: settings.modelId,
      outputFormat: settings.outputFormat,
      stability: settings.stability,
      similarityBoost: settings.similarityBoost,
      style: settings.style,
      useSpeakerBoost: settings.useSpeakerBoost,
    }))
    .digest("hex")
    .slice(0, 24);
  return `elevenlabs-${hash}.mp3`;
}

export async function generateVoicemailAudio(
  text: string,
  opts: { baseUrl: string; settings?: ElevenLabsSettings },
): Promise<GeneratedVoiceAudio> {
  const settings = opts.settings || getElevenLabsSettings();
  const cleanText = text.trim();
  if (!cleanText) throw new Error("voicemail script is empty");
  if (!opts.baseUrl) throw new Error("PUBLIC_BASE_URL is required to serve generated voicemail audio");
  if (!elevenLabsConfigured(settings)) throw new Error("ElevenLabs is not configured");

  const file = cacheFileName(settings, cleanText);
  const url = publicMediaUrl(file, opts.baseUrl);
  if (mediaPathFor(file)) return { file, url, cached: true };

  const endpoint = `${API_BASE}/text-to-speech/${encodeURIComponent(settings.voiceId)}?output_format=${encodeURIComponent(settings.outputFormat)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "xi-api-key": settings.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: cleanText,
      model_id: settings.modelId,
      voice_settings: {
        stability: settings.stability,
        similarity_boost: settings.similarityBoost,
        style: settings.style,
        use_speaker_boost: settings.useSpeakerBoost,
      },
    }),
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed ${response.status}: ${raw.slice(0, 500)}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) throw new Error("ElevenLabs returned an empty audio file");
  await writeMediaFile(file, audio);
  log.info("elevenlabs voicemail audio generated", { file, voiceId: settings.voiceId, bytes: audio.length });
  return { file, url, cached: false };
}
