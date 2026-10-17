// B-Roll Vault — 4-second historical proof visuals.
// Script → 4s segments → real archival visuals (Wikimedia priority) + AI fallback → ZIP.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { DATA_DIR } from './config.js';
import { analyzeScript, heuristicAnalyze } from './gemini.js';
import { discoverForScene } from './footage.js';

const PACKS_DIR = path.join(DATA_DIR, 'packs');

// ~150 words/min speech → 4s ≈ 10 words per segment.
const WORDS_PER_SEGMENT = 10;

function segmentScript(script, scenes) {
  const segments = [];
  let segIdx = 0;
  for (const scene of scenes) {
    const words = (scene.narration || '').split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += WORDS_PER_SEGMENT) {
      const chunk = words.slice(i, i + WORDS_PER_SEGMENT).join(' ');
      segments.push({
        segId: segIdx++,
        sceneId: scene.sceneId,
        text: chunk,
        visualConcept: scene.visualConcept || chunk.slice(0, 120),
        // Proof mode: detect historical content for archival priority.
        isHistorical: /histor|century|19\d\d|20\d\d|ancient|empire|war|king|queen|president|civilization|archaeolog/i.test(chunk + ' ' + (scene.visualConcept || '')),
        startSec: segIdx * 4,
        durationSec: 4,
      });
    }
  }
  return segments;
}

export async function buildBrollPack(script, options = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(PACKS_DIR, id);
  const mediaDir = path.join(dir, 'media');
  const assetsDir = path.join(dir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });

  const save = (obj) => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(obj, null, 2));
  const status = { id, stage: 'analyzing', progress: 5, createdAt: new Date().toISOString(), error: null };
  save(status);

  try {
    let plan;
    try { plan = await analyzeScript(script, {}); }
    catch { plan = heuristicAnalyze(script); }
    const scenes = plan.scenes || [];
    if (!scenes.length) throw new Error('No scenes found');

    const segments = segmentScript(script, scenes);
    status.stage = 'collecting';
    status.totalSegments = segments.length;
    save(status);

    // Collect visuals: historical segments prefer Wikimedia archival.
    const usedUrls = new Set();
    const results = [];
    const BATCH = 4;
    for (let b = 0; b < segments.length; b += BATCH) {
      const batch = segments.slice(b, b + BATCH);
      const found = await Promise.all(batch.map((seg, bi) => {
        // Build a proof-oriented scene object for discovery.
        const proofScene = {
          sceneId: `seg-${seg.segId}`,
          narration: seg.text,
          visualConcept: seg.isHistorical
            ? `historical archival: ${seg.visualConcept}`
            : seg.visualConcept,
          visualType: 'broll',
          // Force Wikimedia priority for historical proof.
          preferArchival: seg.isHistorical,
        };
        return discoverForScene(proofScene, mediaDir, seg.segId, { exclude: usedUrls });
      }));
      for (const a of found) {
        if (a.status === 'ok' && a.fileUrl && !usedUrls.has(a.fileUrl)) {
          usedUrls.add(a.fileUrl);
          if (a.assetId) usedUrls.add(String(a.assetId));
        }
        results.push(a);
      }
      status.progress = 10 + Math.round(((b + batch.length) / segments.length) * 70);
      status.stageDetail = `Collected ${results.length}/${segments.length} b-roll clips…`;
      save(status);
    }

    // Organize: seg-001.mp4, seg-002.jpg… (4s each, in timeline order).
    status.stage = 'packing';
    save(status);
    const manifest = [];
    segments.forEach((seg, i) => {
      const a = results[i];
      const num = String(i + 1).padStart(3, '0');
      let filename = null;
      if (a && a.status === 'ok' && a.file && fs.existsSync(a.file)) {
        const ext = a.kind === 'video' ? '.mp4' : '.jpg';
        filename = `seg-${num}${ext}`;
        fs.copyFileSync(a.file, path.join(assetsDir, filename));
      }
      manifest.push({
        order: i + 1,
        startSec: seg.startSec,
        durationSec: 4,
        file: filename,
        kind: a?.kind || 'missing',
        provider: a?.provider || 'none',
        historical: seg.isHistorical,
        text: seg.text,
        attribution: a?.creator ? `${a.creator} via ${a.provider}` : '',
        pageUrl: a?.pageUrl || '',
      });
    });

    // TIMELINE.md — the editor's cut sheet.
    const guide = [
      `# B-Roll Vault — ${id.slice(0, 8)}`,
      ``,
      `Segments: ${segments.length} × 4 seconds = ~${segments.length * 4}s total`,
      `Created: ${new Date().toISOString()}`,
      ``,
      `## How to use`,
      `1. Files in \`assets/\` are numbered in timeline order (each = 4 seconds).`,
      `2. Lay them on your timeline back-to-back in CapCut/Premiere.`,
      `3. Record voice-over reading the "Say" text per segment.`,
      `4. 🏛️ = historical proof visual (archival/real). 🤖 = AI-generated.`,
      ``,
      ...manifest.flatMap((m) => [
        `## ${String(m.order).padStart(3, '0')} — 0:${String(m.startSec).padStart(2, '0')} (${m.historical ? '🏛️ proof' : m.provider.includes('AI') ? '🤖 AI' : '🎬 stock'})`,
        `- **File:** ${m.file || '⚠️ missing — pick manually'}`,
        `- **Say:** "${m.text}"`,
        m.attribution ? `- **Credit:** ${m.attribution}` : null,
        ``,
      ].filter(Boolean)),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'TIMELINE.md'), guide, 'utf8');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const zipPath = path.join(dir, `broll-pack-${id.slice(0, 8)}.zip`);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(assetsDir, false);
      archive.file(path.join(dir, 'TIMELINE.md'), { name: 'TIMELINE.md' });
      archive.file(path.join(dir, 'manifest.json'), { name: 'manifest.json' });
      archive.finalize();
    });

    const size = fs.statSync(zipPath).size;
    status.stage = 'done';
    status.progress = 100;
    status.result = {
      zip: `/api/packs/${id}/download`,
      segments: segments.length,
      totalSec: segments.length * 4,
      withVisual: manifest.filter((m) => m.file).length,
      historical: manifest.filter((m) => m.historical && m.file).length,
      sizeBytes: size,
    };
    save(status);
    return status;
  } catch (e) {
    status.stage = 'failed';
    status.error = e.message;
    save(status);
    throw e;
  }
}

export function getPackStatus(id) {
  const p = path.join(PACKS_DIR, id, 'status.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function getPackZipPath(id) {
  const st = getPackStatus(id);
  if (!st || st.stage !== 'done') return null;
  const zips = fs.readdirSync(path.join(PACKS_DIR, id)).filter((f) => f.endsWith('.zip'));
  return zips.length ? path.join(PACKS_DIR, id, zips[0]) : null;
}
