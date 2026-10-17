// Central configuration. All secrets come from environment variables —
// never hardcode API keys in source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

// Minimal .env loader (no extra dependency): backend/.env fills variables
// not already set in the real environment. Real env always wins.
try {
  const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
} catch { /* no .env file — environment variables only */ }

export const config = {
  port: parseInt(process.env.PORT || '8787', 10),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  geminiTtsModel: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
  pexelsApiKey: process.env.PEXELS_API_KEY || '',
  pixabayApiKey: process.env.PIXABAY_API_KEY || '',
  coverrApiKey: process.env.COVERR_API_KEY || '',
  githubModelsToken: process.env.GITHUB_MODELS_TOKEN || '',
  // Rendering defaults
  width: 1920,
  height: 1080,
  fps: 30,
};

export function serviceStatus() {
  return {
    gemini: config.geminiApiKey ? 'configured' : 'missing — heuristic fallback mode',
    geminiTts: config.geminiApiKey ? 'configured' : 'missing — translate-tts fallback mode',
    pexels: config.pexelsApiKey ? 'configured' : 'missing — skipped',
    pixabay: config.pixabayApiKey ? 'configured' : 'missing — skipped',
    coverr: config.coverrApiKey ? 'configured' : 'missing — skipped',
    aiVisuals: (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN)
      ? 'available — Cloudflare Flux (free tier)'
      : 'available — Pollinations, no key required',
    wikimedia: 'available — no key required',
    cloudBackup: (process.env.R2_BUCKET && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY)
      ? `active — R2 48h retention`
      : 'not configured — browser backup only',
  };
}
