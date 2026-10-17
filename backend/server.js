import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, serviceStatus } from './lib/config.js';
import { buildBrollPack, getPackStatus, getPackZipPath } from './lib/brollpack.js';

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
  const { script } = req.body || {};
  if (!script || typeof script !== 'string' || script.trim().length < 20) {
    return res.status(400).json({ error: 'Please paste a script of at least 20 characters.' });
  }
  if (script.length > 20000) {
    return res.status(400).json({ error: 'Script too long (max 20,000 characters).' });
  }
  const id = crypto.randomBytes(8).toString('hex');
  buildBrollPack(script.trim(), { packId: id }).catch(() => {});
  res.status(201).json({ id, stage: 'analyzing' });
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
app.listen(PORT, () => console.log(`TDA B-Roll Vault listening on ${PORT}`));
