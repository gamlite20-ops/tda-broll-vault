import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, serviceStatus } from './lib/config.js';
import { buildBrollPack, getPackStatus, getPackZipPath } from './lib/brollpack.js';
import {
  enqueueJob, dequeueJob, markJobDone, getQueueStatus,
  recoverInterruptedJobs, listProjects, cleanupExpired, RETENTION_MS,
} from './lib/projects.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Serve frontend.
const FRONT = new URL('../frontend/dist', import.meta.url).pathname;
if (fs.existsSync(FRONT)) app.use(express.static(FRONT));

app.get('/api/status', (req, res) => {
  res.json({ ok: true, service: 'tda-broll-vault', services: serviceStatus(), time: new Date().toISOString() });
});

app.post('/api/packs', (req, res) => {
  const { script, aspect, projectName } = req.body || {};
  if (!script || typeof script !== 'string' || script.trim().length < 20) {
    return res.status(400).json({ error: 'Please paste a script of at least 20 characters.' });
  }
  if (script.length > 20000) {
    return res.status(400).json({ error: 'Script too long (max 20,000 characters).' });
  }
  const id = crypto.randomBytes(8).toString('hex');
  const name = (projectName || '').trim().slice(0, 80) || `Project ${new Date().toLocaleString()}`;
  // Add to persistent FIFO queue — worker picks it up automatically.
  // Browser can close; the server keeps working.
  enqueueJob({ id, script: script.trim(), aspect: aspect || '16:9', projectName: name });
  res.status(201).json({ id, stage: 'queued', projectName: name });
  // Kick the worker in case it's idle.
  processQueue().catch(() => {});
});

// All saved projects (48h retention) — the "project save folder".
app.get('/api/projects', (req, res) => {
  res.json(listProjects());
});

app.get('/api/queue', (req, res) => {
  res.json({ ...getQueueStatus(), retentionHours: RETENTION_MS / 3600000 });
});

app.get('/api/packs/:id', (req, res) => {
  const st = getPackStatus(req.params.id);
  if (!st) return res.status(404).json({ error: 'Pack not found' });
  res.json(st);
});

app.get('/api/packs/:id/download', (req, res) => {
  const zip = getPackZipPath(req.params.id);
  if (!zip) return res.status(404).json({ error: 'Pack not ready yet' });
  res.download(zip);
});

// SPA fallback.
app.get('*', (req, res) => {
  const idx = path.join(FRONT, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 10000;

// Background FIFO worker — processes queued packs one at a time.
// Runs server-side: closing the browser does NOT stop it.
let workerBusy = false;
async function processQueue() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    while (true) {
      const job = dequeueJob();
      if (!job) break;
      console.log(`[queue] Starting pack ${job.id} (${job.projectName})`);
      try {
        await buildBrollPack(job.script, {
          packId: job.id,
          aspect: job.aspect,
          projectName: job.projectName,
        });
        markJobDone(job.id, true);
        console.log(`[queue] Pack ${job.id} done`);
      } catch (e) {
        markJobDone(job.id, false, e.message);
        console.error(`[queue] Pack ${job.id} failed:`, e.message);
      }
    }
  } finally {
    workerBusy = false;
  }
}

app.listen(PORT, () => {
  console.log(`TDA B-Roll Vault listening on ${PORT}`);
  // Startup: cleanup expired projects, recover interrupted queue jobs.
  const cleaned = cleanupExpired();
  if (cleaned) console.log(`[startup] Cleaned ${cleaned} expired project(s)`);
  const recovered = recoverInterruptedJobs();
  if (recovered) console.log(`[startup] Re-queued ${recovered} interrupted job(s)`);
  processQueue().catch(() => {});
  // Hourly cleanup of expired (>48h) projects.
  setInterval(() => {
    const n = cleanupExpired();
    if (n) console.log(`[cleanup] Removed ${n} expired project(s)`);
  }, 60 * 60 * 1000);
});
