// Project registry + persistent queue for TDA B-Roll Vault.
// - Every pack is a "project" with a name, saved for 48 hours.
// - Jobs run in a server-side FIFO queue — browser can close, job continues.
// - On startup: cleanup expired (>48h) projects, resume interrupted queue.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const PACKS_DIR = path.join(DATA_DIR, 'packs');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const RETENTION_MS = 48 * 60 * 60 * 1000; // 48 hours

function readQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch { return []; }
}

function writeQueue(q) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
}

export function enqueueJob(job) {
  const q = readQueue();
  q.push({ ...job, queuedAt: new Date().toISOString(), status: 'queued' });
  writeQueue(q);
  return job.id;
}

export function dequeueJob() {
  const q = readQueue();
  const idx = q.findIndex((j) => j.status === 'queued');
  if (idx === -1) return null;
  q[idx].status = 'running';
  q[idx].startedAt = new Date().toISOString();
  writeQueue(q);
  return q[idx];
}

export function markJobDone(id, ok = true, error = null) {
  const q = readQueue();
  const j = q.find((x) => x.id === id);
  if (j) {
    j.status = ok ? 'done' : 'failed';
    j.finishedAt = new Date().toISOString();
    if (error) j.error = error;
    writeQueue(q);
  }
}

export function getQueueStatus() {
  const q = readQueue();
  return {
    queued: q.filter((j) => j.status === 'queued').length,
    running: q.filter((j) => j.status === 'running').find((j) => j.id) || null,
    recent: q.slice(-10).reverse(),
  };
}

// On startup: anything stuck in "running" (crash/restart) goes back to queued.
export function recoverInterruptedJobs() {
  const q = readQueue();
  let recovered = 0;
  for (const j of q) {
    if (j.status === 'running') { j.status = 'queued'; recovered++; }
  }
  if (recovered) writeQueue(q);
  return recovered;
}

export function listProjects() {
  if (!fs.existsSync(PACKS_DIR)) return [];
  const now = Date.now();
  return fs.readdirSync(PACKS_DIR)
    .map((id) => {
      const statusPath = path.join(PACKS_DIR, id, 'status.json');
      if (!fs.existsSync(statusPath)) return null;
      try {
        const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        const createdAt = new Date(st.createdAt).getTime();
        const expiresAt = createdAt + RETENTION_MS;
        return {
          id,
          name: st.projectName || `Project ${id.slice(0, 8)}`,
          stage: st.stage,
          progress: st.progress || 0,
          stageDetail: st.stageDetail || '',
          error: st.error || null,
          createdAt: st.createdAt,
          expiresAt: new Date(expiresAt).toISOString(),
          hoursLeft: Math.max(0, Math.round((expiresAt - now) / 3600000)),
          expired: now > expiresAt,
          segments: st.result?.segments || st.totalSegments || 0,
          sizeBytes: st.result?.sizeBytes || 0,
          downloadUrl: st.stage === 'done' ? `/api/packs/${id}/download` : null,
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function cleanupExpired() {
  if (!fs.existsSync(PACKS_DIR)) return 0;
  const now = Date.now();
  let removed = 0;
  for (const id of fs.readdirSync(PACKS_DIR)) {
    const statusPath = path.join(PACKS_DIR, id, 'status.json');
    if (!fs.existsSync(statusPath)) continue;
    try {
      const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      const createdAt = new Date(st.createdAt).getTime();
      if (now - createdAt > RETENTION_MS) {
        fs.rmSync(path.join(PACKS_DIR, id), { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  return removed;
}

export { RETENTION_MS };
