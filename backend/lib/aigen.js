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
export function writeScenePrompt(seg, aspect = '16:9') {
  const text = seg.text || '';
  const concept = seg.visualConcept || text.slice(0, 120);
  // Detect the scene's mood/subject for tailored prompting.
  const isHistorical = seg.isHistorical;
  const isEmotional = /love|fear|hope|dream|sad|happy|anger|brave|courage/i.test(text);
  const isAction = /run|fight|battle|chase|explode|race|war|attack/i.test(text);
  const isNature = /mountain|river|forest|ocean|sky|desert|tree|bird|sun|moon/i.test(text);
  const isPerson = /man|woman|child|king|queen|person|people|face|human/i.test(text);

  let style, composition;
  if (isHistorical) {
    style = 'cinematic historical film still, period-accurate details, dramatic lighting';
    composition = 'epic wide composition';
  } else if (isAction) {
    style = 'dynamic cinematic action shot, dramatic motion feel, high contrast';
    composition = 'dramatic low-angle dynamic framing';
  } else if (isEmotional) {
    style = 'emotional cinematic portrait, soft dramatic lighting, shallow depth of field';
    composition = 'intimate close-up composition';
  } else if (isNature) {
    style = 'breathtaking cinematic nature photography, golden hour, ultra detailed';
    composition = 'sweeping wide landscape composition';
  } else if (isPerson) {
    style = 'cinematic character shot, dramatic rim lighting, photorealistic';
    composition = 'medium shot, rule-of-thirds composition';
  } else {
    style = 'cinematic photorealistic film still, dramatic lighting';
    composition = 'balanced cinematic composition';
  }
  return `${style}, ${composition}: ${concept.slice(0, 250)}. Ultra detailed, ${aspect} aspect ratio, no text, no watermark, no logo, no blur`;
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

// Generate an AI image: Gemini (primary) → Cloudflare Flux → Pollinations.
export async function generateAiImage(prompt, dest, { width = 1280, height = 720, aspect = '16:9' } = {}) {
  // 1) Gemini image generation (user's key already configured — best quality).
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 90000);
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${geminiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: `Generate a ${aspect} aspect ratio cinematic image (${width}x${height}): ${prompt}` }] }],
                generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
              }),
              signal: ctrl.signal,
            }
          );
          const data = await res.json();
          const parts = data?.candidates?.[0]?.content?.parts || [];
          const imgPart = parts.find((p) => p.inlineData?.data);
          if (!imgPart) throw new Error(data?.error?.message || 'No image in Gemini response');
          fs.writeFileSync(dest, Buffer.from(imgPart.inlineData.data, 'base64'));
          return { provider: 'Gemini AI', file: dest };
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        console.error('[aigen] Gemini image failed:', e.message);
        if (attempt === 1) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  // Try Flux first.
  if (accountId && token) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        try {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt }),
              signal: ctrl.signal,
            }
          );
          const data = await res.json();
          const b64 = data?.result?.image;
          if (!b64) throw new Error('No image in Flux response');
          fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
          return { provider: 'Cloudflare Flux', file: dest };
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        if (attempt === 1) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  // Fallback: Pollinations.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&seed=${Math.floor(Math.random() * 1e9)}`;
      await downloadTo(url, dest, 90000);
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
