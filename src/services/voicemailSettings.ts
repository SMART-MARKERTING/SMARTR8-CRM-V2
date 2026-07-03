import { config } from "../config";
import { getMeta, setMeta } from "../store/db";
import { defaultFrom } from "./numbers";

const META_KEY = "voicemail:default_audio";

export interface DefaultVoicemailAudio {
  url: string;
  file: string | null;
  mime: string | null;
  size: number | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface PublicVoicemailAudioSettings extends DefaultVoicemailAudio {
  source: "uploaded" | "env" | "none";
  configured: boolean;
  envAudioUrlSet: boolean;
  telnyxVoiceAppSet: boolean;
  telnyxApiKeySet: boolean;
  telnyxFromNumberSet: boolean;
}

function empty(): DefaultVoicemailAudio {
  return {
    url: "",
    file: null,
    mime: null,
    size: null,
    updatedAt: null,
    updatedBy: null,
  };
}

function fromStored(raw: string | null): DefaultVoicemailAudio | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DefaultVoicemailAudio>;
    const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
    if (!url) return null;
    return {
      url,
      file: typeof parsed.file === "string" ? parsed.file : null,
      mime: typeof parsed.mime === "string" ? parsed.mime : null,
      size: typeof parsed.size === "number" && Number.isFinite(parsed.size) ? parsed.size : null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : null,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
    };
  } catch {
    return null;
  }
}

export function getStoredVoicemailAudio(): DefaultVoicemailAudio | null {
  return fromStored(getMeta(META_KEY));
}

export function getDefaultVoicemailAudioUrl(): string {
  return getStoredVoicemailAudio()?.url || config.voicemail.audioUrl || "";
}

export function saveDefaultVoicemailAudio(
  input: { url: string; file?: string | null; mime?: string | null; size?: number | null },
  author?: string,
): PublicVoicemailAudioSettings {
  const url = input.url.trim();
  if (!url) throw new Error("voicemail audio URL is required");
  const next: DefaultVoicemailAudio = {
    url,
    file: input.file || null,
    mime: input.mime || null,
    size: typeof input.size === "number" && Number.isFinite(input.size) ? input.size : null,
    updatedAt: Date.now(),
    updatedBy: author ?? null,
  };
  setMeta(META_KEY, JSON.stringify(next));
  return publicVoicemailAudioSettings(next);
}

export function publicVoicemailAudioSettings(stored = getStoredVoicemailAudio()): PublicVoicemailAudioSettings {
  const fallback = config.voicemail.audioUrl || "";
  const audio = stored || (fallback ? { ...empty(), url: fallback } : empty());
  const source: PublicVoicemailAudioSettings["source"] = stored ? "uploaded" : fallback ? "env" : "none";
  return {
    ...audio,
    source,
    envAudioUrlSet: Boolean(fallback),
    telnyxVoiceAppSet: Boolean(config.voice.applicationId),
    telnyxApiKeySet: Boolean(config.telnyx.apiKey),
    telnyxFromNumberSet: Boolean(defaultFrom()),
    configured: Boolean(audio.url && config.voice.applicationId && config.telnyx.apiKey && defaultFrom()),
  };
}
