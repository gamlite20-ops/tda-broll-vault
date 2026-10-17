// AI-first visual generation for B-Roll Vault.
// Every 4s segment: analyze → write prompt → generate AI image → animate to 4s video.
// Maximum AI visuals (user requirement). Real stock only as rare fallback.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Aspect ratio presets.
export const RATIOS = {
  '16:9': { w: 1280, h: 720, label: '16:9 — YouTube landscape' },
  '9:16': { w: 720, h: 1280, label: '9:16 — Shorts/Reels/TikTok' },
  '1:1': { w: 1080, h: 1080, label: '1:1 — Instagram square' },
};
// Write a detailed AI prompt from the scene's text (the tool "thinks" per scene).
// QUALITY RULES: bright, clear, illustrative — never dark/muddy. Every prompt
// must visualize the SPECIFIC concept in the text, not generic "cinematic" filler.
export function writeScenePrompt(seg, aspect = '16:9') {
  const text = seg.text || '';
  const concept = seg.visualConcept || text.slice(0, 120);
  // Detect the scene's mood/subject for tailored prompting.
  const isHistorical = seg.isHistorical;
  const isEmotional = /love|fear|hope|dream|sad|happy|anger|brave|courage/i.test(text);
  const isAction = /run|fight|battle|chase|explode|race|war|attack/i.test(text);
  const isNature = /mountain|river|forest|ocean|sky|desert|tree|bird|sun|moon/i.test(text);
  const isPerson = /man|woman|child|king|queen|person|people|face|human/i.test(text);
  const isTech = /ai|artificial intelligence|robot|computer|machine|data|algorithm|neural|digital|technology|software|internet/i.test(text);

  let style, composition;
  if (isHistorical) {
    style = 'cinematic historical film still, period-accurate details, warm natural lighting, clear subject';
    composition = 'epic wide composition';
  } else if (isTech) {
    style = 'bright clean futuristic 3D illustration, vibrant blue and white palette, glowing accents, ultra sharp, professional explainer-video style';
    composition = 'clear centered composition with strong focal point';
  } else if (isAction) {
    style = 'dynamic action illustration, vibrant colors, high energy, sharp details';
    composition = 'dramatic dynamic framing';
  } else if (isEmotional) {
    style = 'warm emotional illustration, soft beautiful lighting, expressive, shallow depth of field';
    composition = 'intimate close-up composition';
  } else if (isNature) {
    style = 'breathtaking nature photography, golden hour, ultra detailed, vibrant';
    composition = 'sweeping wide landscape composition';
  } else if (isPerson) {
    style = 'professional character illustration, bright flattering lighting, photorealistic, sharp focus';
    composition = 'medium shot, rule-of-thirds composition';
  } else {
    style = 'bright clean professional illustration, vibrant colors, sharp details, modern explainer-video style';
    composition = 'balanced clear composition';
  }
  // Extract the core visual subject: strip question words, focus on nouns/concepts.
  const subject = concept.slice(0, 250).replace(/^(have you ever wondered|welcome to|think about it|but remember|so here'?s)/i, '').trim();
  return `${style}, ${composition}: ${subject}. Bright daylight quality lighting, vivid colors, highly detailed, sharp focus, ${aspect} aspect ratio, no text, no words, no watermark, no logo, no blur, no darkness`;
}

async function downloadTo(url, dest, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'TDA-BRoll-Vault/1.0' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 20000) throw new Error('Image too small');
    fs.writeFileSync(dest, buf);
    return dest;
  } finally {
    clearTimeout(timer);
  }
}

// Generate an AI image: Cloudflare FLUX.2 (primary, best FREE) → Pollinations.
// NOTE: Gemini image generation requires a PAID tier ("free tier: Not available"),
// so it is intentionally skipped — Cloudflare is the best free option.
export async function generateAiImage(prompt, dest, { width = 1280, height = 720, aspect = '16:9' } = {}) {
  // Try Cloudflare Flux models (best FREE option — Gemini image needs paid tier).
  // Order: newest/best first.
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const FLUX_MODELS = [
    '@cf/black-forest-labs/flux-1-schnell',  // Proven working, good quality
  ];
  if (accountId && token) {
    for (const model of FLUX_MODELS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        try {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt }),
              signal: ctrl.signal,
            }
          );
          const data = await res.json();
          const b64 = data?.result?.image;
          if (!b64) throw new Error(data?.errors?.[0]?.message || 'No image in Flux response');
          fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
          const shortName = model.split('/').pop();
          return { provider: `Cloudflare ${shortName}`, file: dest };
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        console.error(`[aigen] ${model} failed, trying next:`, e.message?.slice(0, 100));
      }
    }
  }
  // Fallback: Pollinations (reliable, ~5s).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&seed=${Math.floor(Math.random() * 1e9)}`;
      await downloadTo(url, dest, 60000);
      // Verify it's a JPEG.
      const head = fs.readFileSync(dest).subarray(0, 2).toString('hex');
      if (head !== 'ffd8') throw new Error('Not a valid JPEG');
      return { provider: 'Pollinations AI', file: dest };
    } catch (e) {
      if (attempt === 1) throw e;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

// Animate a still image into a 4s video clip (Ken Burns) — "AI video".
export async function imageToVideo(imagePath, outPath, durationSec = 4, seed = 0, { width = 1280, height = 720 } = {}) {
  // Vary the motion: zoom-in, zoom-out, pan-left, pan-right.
  const motions = ['zin', 'zout', 'panl', 'panr'];
  const motion = motions[seed % motions.length];
  const fps = 30;
  const frames = durationSec * fps;
  const size = `${width}x${height}`;
  let zp;
  if (motion === 'zin') {
    zp = `zoompan=z='min(zoom+0.0012,1.25)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}`;
  } else if (motion === 'zout') {
    zp = `zoompan=z='max(1.25-0.0012*on,1.0)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}`;
  } else if (motion === 'panl') {
    zp = `zoompan=z=1.15:d=${frames}:x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}`;
  } else {
    zp = `zoompan=z=1.15:d=${frames}:x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)':s=${size}:fps=${fps}`;
  }
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-loop', '1', '-i', imagePath,
    '-vf', `${zp},format=yuv420p`,
    '-t', String(durationSec),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-an',
    outPath,
  ], { timeout: 120000 });
  return outPath;
}
