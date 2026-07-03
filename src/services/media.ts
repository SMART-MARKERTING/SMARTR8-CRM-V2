import path from "path";
import fs from "fs";
import { writeFile } from "fs/promises";
import { config } from "../config";

// Media files live on the persistent disk and are served through /media/:file.
export const MEDIA_DIR = path.resolve(config.tokenDir, "media");

try {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
} catch {
  // Upload/generation callers surface real write errors.
}

const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
};

export function mimeForExt(ext: string): string {
  return EXT_MIME[ext.toLowerCase()] || "application/octet-stream";
}

export function supportedMediaExt(ext: string): boolean {
  return Boolean(EXT_MIME[ext.toLowerCase()]);
}

export function mediaPathFor(id: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  const full = path.resolve(MEDIA_DIR, id);
  if (!full.startsWith(MEDIA_DIR + path.sep) || !fs.existsSync(full)) return null;
  return full;
}

export async function writeMediaFile(id: string, buf: Buffer): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid media file name");
  const full = path.resolve(MEDIA_DIR, id);
  if (!full.startsWith(MEDIA_DIR + path.sep)) throw new Error("invalid media path");
  await writeFile(full, buf);
}

export function publicMediaUrl(file: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/media/${encodeURIComponent(file)}`;
}
