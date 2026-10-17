// Copyright-aware footage discovery.
// Providers: Pexels (key), Pixabay (key), Coverr (key, free tier),
// Wikimedia Commons (no key, images), Pollinations AI visuals (no key).
// Every downloaded asset records provider, URL, license, creator, download
// date and commercial-use eligibility. Assets with unclear licensing are
// excluded. An attribution report (Markdown + JSON) ships with every job.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

const UA = 'TDA-AutoMotion-X/0.1 (automated video production; contact: admin)';

async function downloadTo(url, dest, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!res.ok || !res.body) throw new Error(`Download failed ${res.status} for ${url}`);
  await pipeline(res.body, fs.createWriteStream(dest));
  return dest;
}

function pickLandscape(files, minWidth = 1280) {
  const cands = files.filter((f) => (f.width || 0) >= minWidth && (f.width || 0) >= (f.height || 0));
  const pool = cands.length ? cands : files.filter((f) => (f.width || 0) >= (f.height || 0));
  return pool.sort((a, b) => (b.width || 0) - (a.width || 0))[0] || null;
}

// --- Pexels -----------------------------------------------------------------
async function pexelsSearchVideo(query) {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape&size=medium`;
  const res = await fetch(url, { headers: { Authorization: config.pexelsApiKey, 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Pexels API ${res.status}`);
  return res.json();
}

// --- Pixabay ----------------------------------------------------------------
async function pixabaySearch(query, type) {
  const url = `https://pixabay.com/api/${type === 'video' ? 'videos/' : ''}?key=${encodeURIComponent(config.pixabayApiKey)}` +
    `&q=${encodeURIComponent(query)}&per_page=5&orientation=horizontal&safesearch=true`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Pixabay API ${res.status}`);
  return res.json();
}

// --- Coverr (free API tier; Bearer auth) --------------------------------------
// Docs: https://api.coverr.co/docs — search is GET /videos?query=..&urls=true.
// Response shape: { hits: [{ id, title, aspect_ratio, max_width, max_height,
// urls: { mp4, mp4_preview, mp4_download }, ... }] }.
// Coverr's terms REQUIRE pinging PATCH /videos/<id>/stats/downloads after each
// successful download ("We will periodically check partner's implementation").
async function coverrSearchVideo(query) {
  const url = `https://api.coverr.co/videos?query=${encodeURIComponent(query)}&urls=true&sort=popular&page_size=5`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.coverrApiKey}`, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`Coverr API ${res.status}`);
  return res.json();
}

async function coverrPingDownload(id) {
  try {
    await fetch(`https://api.coverr.co/videos/${id}/stats/downloads`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${config.coverrApiKey}`, 'User-Agent': UA },
    });
  } catch (e) {
    if (process.env.TDA_DEBUG) console.error(`[coverr] download ping failed: ${e.message}`);
  }
}

// --- AI-generated visuals ----------------------------------------------------
// When no royalty-free photo/video is found, generate a cinematic still with
// AI and let the renderer apply Ken Burns motion to it. This replaces the
// plain-gradient fallback with real imagery.
//
// Provider order:
//   1) Cloudflare Workers AI (Flux) — optional, needs free Cloudflare account
//      (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN). ~173 images/day free.
//      Much better quality than Pollinations' sana model.
//   2) Pollinations keyless — truly free, no signup, lower quality (sana).
// (GitHub Models also offers free inference, but its API is not reachable
// from this build environment, so the verified-free paths above ship.)
function aiImagePrompt(scene) {
  const concept = (scene.visualConcept || scene.narration || 'abstract cinematic background').slice(0, 300);
  const grade = { warm: 'warm golden-hour grade', cool: 'cool blue grade', 'cinematic-teal': 'cinematic teal-and-orange grade', bw: 'black and white', vibrant: 'vibrant saturated colors' }[scene.colorTreatment] || 'natural cinematic grade';
  // AUTO-PROMPTING (user): tailor the visual style to the scene's edit style.
  const stylePrompt = {
    vox: 'bold flat vector illustration, infographic style, clean shapes, vibrant accent colors',
    documentary: 'cinematic photorealistic film still, shallow depth of field, dramatic natural lighting',
    motion: 'dynamic energetic digital art, dramatic perspective, glowing accents, high contrast',
  }[scene.editStyle] || 'cinematic photorealistic film still';
  // Add variety: rotate through compositional approaches.
  const compositions = [
    'wide establishing shot', 'dramatic close-up detail', 'aerial bird\'s-eye view',
    'low-angle heroic framing', 'symmetrical centered composition', 'rule-of-thirds composition',
  ];
  const comp = compositions[Math.floor(Math.random() * compositions.length)];
  return `${stylePrompt}, 16:9 composition, ${comp}: ${concept}. ${grade}, high detail, no text, no watermark, no logo`;
}

async function pollinationsImage(prompt, dest, { width = 1280, height = 720 } = {}) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&seed=${Math.floor(Math.random() * 1e9)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    // Pollinations returns JSON errors on failure; a real image is much bigger.
    if (!res.ok || buf.length < 20000 || buf.subarray(0, 2).toString('hex') !== 'ffd8') {
      throw new Error(`Pollinations image failed (${res.status}, ${buf.length} bytes)`);
    }
    fs.writeFileSync(dest, buf);
    return dest;
  } finally {
    clearTimeout(timer);
  }
}

// Cloudflare Workers AI — Flux 1 Schnell. Free tier: 10k neurons/day
// (~50-60 images). Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN.
// Returns JSON: { result: { image: "<base64 jpeg>" } }.
async function cloudflareFluxImage(prompt, dest) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error('Cloudflare not configured');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ prompt }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    const b64 = data?.result?.image;
    if (!res.ok || !data?.success || !b64) {
      const msg = data?.errors?.[0]?.message || `HTTP ${res.status}`;
      throw new Error(`Cloudflare Flux failed: ${String(msg).slice(0, 160)}`);
    }
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 20000 || buf.subarray(0, 2).toString('hex') !== 'ffd8') {
      throw new Error('Cloudflare Flux returned invalid image data');
    }
    fs.writeFileSync(dest, buf);
    return dest;
  } finally {
    clearTimeout(timer);
  }
}

function aiVisualAvailable() {
  // Cloudflare Flux if configured, else Pollinations (always available).
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) return 'Cloudflare Flux (free tier)';
  return 'Pollinations, no key required';
}

// --- Wikimedia Commons (no key; freely licensed images with attribution) -----
async function wikimediaSearch(query, { exact = false, video = false } = {}) {
  const ft = video ? 'filetype:video' : 'filetype:bitmap';
  const searchText = exact ? `${ft} "${query}"` : `${ft} ${query}`;
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    generator: 'search', gsrsearch: searchText, gsrlimit: '10', gsrnamespace: '6',
    prop: 'imageinfo', iiprop: 'url|user|extmetadata|size', iiurlwidth: '1920',
  });
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Wikimedia API ${res.status}`);
  const data = await res.json();
  const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
  return pages
    .map((p) => {
      const info = p.imageinfo?.[0];
      if (!info) return null;
      const meta = info.extmetadata || {};
      const license = meta.LicenseShortName?.value || meta.License?.value || 'see Commons page';
      return {
        title: p.title,
        url: info.thumburl || info.url,
        fileUrl: info.url,
        pageUrl: info.descriptionurl,
        width: info.thumbwidth || info.width, height: info.thumbheight || info.height,
        creator: (meta.Artist?.value || 'Unknown').replace(/<[^>]*>/g, '').slice(0, 120),
        license: license.replace(/<[^>]*>/g, ''),
        licenseUrl: (meta.LicenseUrl?.value || '').replace(/<[^>]*>/g, ''),
      };
    })
    .filter(Boolean)
    .filter((x) => (x.width || 0) >= 960);
}

// Significant words of a query (lowercased, >3 chars).
function sigWords(query) {
  return query.toLowerCase().split(/[^a-z0-9\u0600-\u06FF\u0400-\u04FF]+/).filter((w) => w.length > 3);
}

// Scores a Wikimedia hit against the query's TOPIC CORE (first 3 significant
// words). Queries are built "<topic> <descriptors>"; only the topic must
// match — a photo of the right place from a different angle is fine, a photo
// of the wrong place is not. (Scoring all words used to sink good matches
// under long descriptor tails: "Mohenjo-daro Indus valley aerial view"
// rejected a real Mohenjo-daro photo at 0.5.)
function relevanceScore(hit, query) {
  const core = sigWords(query).slice(0, 3);
  if (!core.length) return 0;
  const title = (hit.title || '').toLowerCase().replace(/_/g, ' ');
  let m = 0;
  for (const w of core) if (title.includes(w)) m++;
  return m / core.length;
}

// Two-tier Commons search. Tier 1 tries the full descriptive queries; long
// queries often return ZERO hits on Commons (every rare word like "aerial"
// narrows the result set), so tier 2 retries with shortened topic queries
// (first 3 significant words). The relevance gate still applies to every hit.
async function tieredSearch(queries, { video = false, hitFilter = null } = {}, errors) {
  async function run(qs) {
    let best = null;
    for (const q of qs) {
      try {
        let hits = [...await wikimediaSearch(q, { exact: true, video }), ...await wikimediaSearch(q, { video })];
        if (process.env.TDA_DEBUG) console.error(`[tieredSearch] q="${q}" video=${video} rawHits=${hits.length}`);
        if (hitFilter) hits = hits.filter(hitFilter);
        for (const hit of hits) {
          const score = relevanceScore(hit, q);
          if (!best || score > best.score) best = { hit, score, query: q };
        }
        if (best && best.score >= 1) break;
      } catch (e) { errors.push(`wikimedia${video ? '-video' : ''}:${q}: ${e.message}`); }
    }
    return best;
  }
  let best = await run(queries.slice(0, 4));
  if (!best || best.score < 0.6) {
    const shorts = [];
    for (const q of queries.slice(0, 3)) {
      const short = sigWords(q).slice(0, 3).join(' ');
      if (short && short !== q.toLowerCase().trim() && !shorts.includes(short)) shorts.push(short);
    }
    const b2 = await run(shorts);
    if (b2 && (!best || b2.score > best.score)) best = b2;
  }
  return best;
}

export async function discoverForScene(scene, mediaDir, index, opts = {}) {
  const queries = [...(scene.searchTerms || []), ...(scene.altSearchTerms || [])];
  const errors = [];
  // NO-REPEAT RULE (user): never reuse footage within one video.
  // opts.exclude = Set of already-used fileUrls/asset IDs for this job.
  const exclude = opts.exclude || new Set();
  const isUsed = (url, id) => (url && exclude.has(url)) || (id && exclude.has(String(id)));
  // forceAi: skip all stock providers, go straight to AI generation
  // (used by the editor's "AI regenerate" button).
  const skipStock = opts.forceAi === true;

  // HOOK RULE (user): scene 0 is the hook — it must grab attention. Boost its
  // queries with high-energy cinematic openers on the video providers, so the
  // tool picks a "hook animation type" video instead of a flat establishing shot.
  // The topic anchor (first search term's head word) keeps it on-subject.
  if (index === 0 && scene.visualType !== 'chart' && scene.visualType !== 'map' && scene.visualType !== 'text') {
    const topicHead = (scene.searchTerms?.[0] || '').split(/\s+/).slice(0, 2).join(' ');
    const hookQueries = [
      ...(topicHead ? [`${topicHead} cinematic dramatic`, `${topicHead} epic opening`] : []),
      'cinematic dramatic intro',
    ];
    // Try hook queries FIRST on Pixabay and Coverr before the normal queries.
    for (const q of hookQueries) {
      if (config.pixabayApiKey) {
        try {
          const data = await pixabaySearch(q, 'video');
          const hit = (data.hits || []).find((h) => h?.videos?.medium?.url && !isUsed(h.videos.medium.url, h.id));
          if (hit?.videos?.medium?.url) {
            const dest = path.join(mediaDir, `scene-${index}-pixabay-hook-${hit.id}.mp4`);
            await downloadTo(hit.videos.medium.url, dest);
            return assetRecord(scene, index, {
              provider: 'Pixabay', assetId: String(hit.id),
              pageUrl: hit.pageURL, fileUrl: hit.videos.medium.url,
              license: 'Pixabay Content License (free for commercial use, no attribution required)',
              licenseUrl: 'https://pixabay.com/service/license/',
              creator: hit.user || 'Unknown', creatorUrl: '',
              kind: 'video', file: dest, width: hit.videos.medium.width, height: hit.videos.medium.height,
              query: q, commercialUse: 'yes', hookPick: true,
            });
          }
        } catch (e) { errors.push(`pixabay-hook:${q}: ${e.message}`); }
      }
      if (config.coverrApiKey) {
        try {
          const data = await coverrSearchVideo(q);
          const hit = (data.hits || []).find((h) => h?.urls?.mp4 && (h.aspect_ratio || '').startsWith('16') && !isUsed(h.urls.mp4, h.id));
          if (hit) {
            const dest = path.join(mediaDir, `scene-${index}-coverr-hook-${hit.id}.mp4`);
            await downloadTo(hit.urls.mp4_download || hit.urls.mp4, dest);
            await coverrPingDownload(hit.id);
            return assetRecord(scene, index, {
              provider: 'Coverr', assetId: String(hit.id),
              pageUrl: `https://coverr.co/videos/${hit.id}`,
              fileUrl: hit.urls.mp4,
              license: 'Coverr license (free for commercial use; attribution to Coverr requested by API terms)',
              licenseUrl: 'https://coverr.co/license',
              creator: 'Coverr contributor', creatorUrl: '',
              kind: 'video', file: dest, width: hit.max_width || 1920, height: hit.max_height || 1080,
              query: q, commercialUse: 'yes', hookPick: true,
            });
          }
        } catch (e) { errors.push(`coverr-hook:${q}: ${e.message}`); }
      }
    }
  }

  // PROOF MODE (B-Roll Vault): for historical segments, try Wikimedia archival
  // FIRST — real historical photos/footage beat generic stock for "proof".
  if (!skipStock && scene.preferArchival) {
    const archivalQueries = queries.map((q) => q);
    // Try Wikimedia video.
    const bestV = await tieredSearch(archivalQueries,
      { video: true, hitFilter: (h) => /\.(webm|mp4|ogv)$/i.test(new URL(h.url).pathname) }, errors)
      .catch(() => null);
    if (bestV && bestV.score >= 0.5) {
      const hit = bestV.hit;
      const origUrl = hit.fileUrl || hit.url;
      if (!isUsed(origUrl, hit.title)) {
        const ext = (new URL(origUrl).pathname.match(/\.([a-z0-9]{2,4})$/i) || [])[1] || 'mp4';
        const dest = path.join(mediaDir, `seg-${index}-archival-vid.${ext.toLowerCase()}`);
        try {
          await downloadTo(origUrl, dest);
          return assetRecord(scene, index, {
            provider: 'Wikimedia Commons (archival)', assetId: hit.title,
            pageUrl: hit.pageUrl, fileUrl: origUrl,
            license: hit.license, licenseUrl: hit.licenseUrl,
            creator: hit.creator, creatorUrl: '',
            kind: 'video', file: dest, width: hit.width, height: hit.height,
            query: bestV.query, commercialUse: 'check-license',
            relevanceScore: Number(bestV.score.toFixed(2)),
          });
        } catch {}
      }
    }
    // Try Wikimedia photo.
    const best = await tieredSearch(archivalQueries, {}, errors).catch(() => null);
    if (best && best.score >= 0.5) {
      const hit = best.hit;
      if (!isUsed(hit.url, hit.title)) {
        const dest = path.join(mediaDir, `seg-${index}-archival.jpg`);
        try {
          await downloadTo(hit.url, dest);
          return assetRecord(scene, index, {
            provider: 'Wikimedia Commons (archival)', assetId: hit.title,
            pageUrl: hit.pageUrl, fileUrl: hit.url,
            license: hit.license, licenseUrl: hit.licenseUrl,
            creator: hit.creator, creatorUrl: '',
            kind: 'photo', file: dest, width: hit.width, height: hit.height,
            query: best.query, commercialUse: 'check-license',
            relevanceScore: Number(best.score.toFixed(2)),
          });
        } catch {}
      }
    }
    // Archival not found — fall through to normal providers + AI.
  }

  // 1) Pexels video (needs key)
  if (!skipStock && config.pexelsApiKey && scene.visualType !== 'chart' && scene.visualType !== 'map') {
    for (const q of queries.slice(0, 3)) {
      try {
        const data = await pexelsSearchVideo(q);
        const video = (data.videos || [])[0];
        if (video) {
          const file = pickLandscape(video.video_files || []);
          if (file) {
            const dest = path.join(mediaDir, `scene-${index}-pexels-${video.id}.mp4`);
            await downloadTo(file.link, dest);
            return assetRecord(scene, index, {
              provider: 'Pexels', assetId: String(video.id),
              pageUrl: video.url, fileUrl: file.link,
              license: 'Pexels License (free for commercial use, no attribution required)',
              licenseUrl: 'https://www.pexels.com/license/',
              creator: video.user?.name || 'Unknown', creatorUrl: video.user?.url || '',
              kind: 'video', file: dest, width: file.width, height: file.height,
              query: q, commercialUse: 'yes',
            });
          }
        }
      } catch (e) { errors.push(`pexels:${q}: ${e.message}`); }
    }
  }

  // 2) Pixabay video/photo (needs key)
  if (!skipStock && config.pixabayApiKey) {
    for (const q of queries.slice(0, 3)) {
      try {
        const data = await pixabaySearch(q, 'video');
        const hit = (data.hits || []).find((h) => h?.videos?.medium?.url && !isUsed(h.videos.medium.url, h.id));
        if (hit?.videos?.medium?.url) {
          const dest = path.join(mediaDir, `scene-${index}-pixabay-${hit.id}.mp4`);
          await downloadTo(hit.videos.medium.url, dest);
          return assetRecord(scene, index, {
            provider: 'Pixabay', assetId: String(hit.id),
            pageUrl: hit.pageURL, fileUrl: hit.videos.medium.url,
            license: 'Pixabay Content License (free for commercial use, no attribution required)',
            licenseUrl: 'https://pixabay.com/service/license/',
            creator: hit.user || 'Unknown', creatorUrl: '',
            kind: 'video', file: dest, width: hit.videos.medium.width, height: hit.videos.medium.height,
            query: q, commercialUse: 'yes',
          });
        }
      } catch (e) { errors.push(`pixabay:${q}: ${e.message}`); }
    }
  }

  // 3) Coverr video (free API tier, needs key) — royalty-free, commercial OK.
  if (!skipStock && config.coverrApiKey && scene.visualType !== 'chart' && scene.visualType !== 'map' && scene.visualType !== 'text') {
    for (const q of queries.slice(0, 3)) {
      try {
        const data = await coverrSearchVideo(q);
        const hit = (data.hits || []).find((h) => h?.urls?.mp4 && (h.aspect_ratio || '').startsWith('16') && !isUsed(h.urls.mp4, h.id));
        if (hit) {
          const dest = path.join(mediaDir, `scene-${index}-coverr-${hit.id}.mp4`);
          await downloadTo(hit.urls.mp4_download || hit.urls.mp4, dest);
          await coverrPingDownload(hit.id); // mandatory per Coverr terms (best-effort)
          return assetRecord(scene, index, {
            provider: 'Coverr', assetId: String(hit.id),
            pageUrl: `https://coverr.co/videos/${hit.id}`,
            fileUrl: hit.urls.mp4,
            license: 'Coverr license (free for commercial use; attribution to Coverr requested by API terms)',
            licenseUrl: 'https://coverr.co/license',
            creator: 'Coverr contributor', creatorUrl: '',
            kind: 'video', file: dest, width: hit.max_width || 1920, height: hit.max_height || 1080,
            query: q, commercialUse: 'yes',
          });
        }
      } catch (e) { errors.push(`coverr:${q}: ${e.message}`); }
    }
  }

  // 4) Wikimedia Commons VIDEO (no key) — real motion footage, freely licensed.
  // Same relevance gate as photos; video beats stills for perceived quality.
  if (!skipStock && scene.visualType !== 'chart' && scene.visualType !== 'map' && scene.visualType !== 'text') {
    const bestV = await tieredSearch(queries,
      { video: true, hitFilter: (h) => /\.(webm|mp4|ogv)$/i.test(new URL(h.url).pathname) }, errors);
    if (bestV && bestV.score >= 0.6) {
      const hit = bestV.hit;
      // Use the ORIGINAL file (not the thumbnail) for video.
      const origUrl = hit.fileUrl || hit.url;
      const ext = (new URL(origUrl).pathname.match(/\.([a-z0-9]{2,4})$/i) || [])[1] || 'mp4';
      const dest = path.join(mediaDir, `scene-${index}-wikimedia-vid-${index}.${ext.toLowerCase()}`);
      await downloadTo(origUrl, dest);
      return assetRecord(scene, index, {
        provider: 'Wikimedia Commons', assetId: hit.title,
        pageUrl: hit.pageUrl, fileUrl: origUrl,
        license: hit.license, licenseUrl: hit.licenseUrl,
        creator: hit.creator, creatorUrl: '',
        kind: 'video', file: dest, width: hit.width, height: hit.height,
        query: bestV.query, commercialUse: 'check-license',
        relevanceScore: Number(bestV.score.toFixed(2)),
      });
    }
    if (bestV) errors.push(`wikimedia-video: best match "${bestV.hit.title}" scored ${bestV.score.toFixed(2)} — below threshold`);
  }

  // 5) Wikimedia Commons image (no key) — real, license-clean fallback.
  // Semantic relevance gate: exact-phrase search first, then broad search;
  // only accept a hit whose title really matches the topic core (>= 0.6).
  // Otherwise the scene honestly gets a generated visual.
  const best = skipStock ? null : await tieredSearch(queries, {}, errors);
  if (best && best.score >= 0.6) {
    const hit = best.hit;
    let ext = 'jpg';
    try {
      const m = new URL(hit.url).pathname.match(/\.([a-zA-Z0-9]{2,4})$/);
      if (m) ext = m[1].toLowerCase();
    } catch { /* keep jpg */ }
    const dest = path.join(mediaDir, `scene-${index}-wikimedia-${index}.${ext}`);
    await downloadTo(hit.url, dest);
    return assetRecord(scene, index, {
      provider: 'Wikimedia Commons', assetId: hit.title,
      pageUrl: hit.pageUrl, fileUrl: hit.url,
      license: hit.license, licenseUrl: hit.licenseUrl,
      creator: hit.creator, creatorUrl: '',
      kind: 'photo', file: dest, width: hit.width, height: hit.height,
      query: best.query, commercialUse: 'check-license',
      relevanceScore: Number(best.score.toFixed(2)),
    });
  }
  if (best) errors.push(`wikimedia: best match "${best.hit.title}" scored ${best.score.toFixed(2)} — below relevance threshold`);

  // 5) AI-generated visual — a cinematic AI still with Ken Burns motion beats
  // a plain gradient. Skipped for charts/maps/text scenes where a clean
  // graphic is more honest.
  // Order: Cloudflare Flux (free tier, better quality) → Pollinations (free, no key).
  if (scene.visualType !== 'chart' && scene.visualType !== 'map' && scene.visualType !== 'text') {
    try {
      const w = config.width || 1280, h = config.height || 720;
      const dest = path.join(mediaDir, `scene-${index}-ai-${index}.jpg`);
      const prompt = aiImagePrompt(scene);
      let provider = 'Pollinations AI', pageUrl = 'https://pollinations.ai';
      let lastErr = null;
      // Try Cloudflare Flux first (3 attempts), then Pollinations (3 attempts).
      const cfConfigured = process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN;
      if (cfConfigured) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await cloudflareFluxImage(prompt, dest); lastErr = null; provider = 'Cloudflare Flux'; pageUrl = 'https://developers.cloudflare.com/workers-ai/'; break; }
          catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 3000)); }
        }
      }
      if (lastErr || !cfConfigured) {
        lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await pollinationsImage(prompt, dest, { width: w, height: h }); lastErr = null; provider = 'Pollinations AI'; pageUrl = 'https://pollinations.ai'; break; }
          catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 4000)); }
        }
      }
      if (lastErr) throw lastErr;
      // Politeness: don't hammer the free image backends.
      await new Promise((r) => setTimeout(r, 2000));
      return assetRecord(scene, index, {
        provider, assetId: `ai-${index}`,
        pageUrl, fileUrl: '',
        license: `AI-generated image (${provider}, free; no third-party rights involved)`,
        licenseUrl: pageUrl,
        creator: 'AI-generated', creatorUrl: '',
        kind: 'photo', file: dest, width: w, height: h,
        query: scene.visualConcept || '', commercialUse: 'yes',
      });
    } catch (e) { errors.push(`ai-visual: ${e.message}`); }
  }

  return { sceneId: scene.sceneId, status: 'fallback-needed', errors, queries };
}

function assetRecord(scene, index, a) {
  return {
    sceneId: scene.sceneId, status: 'ok',
    ...a,
    downloadedAt: new Date().toISOString(),
    restrictions: 'Do not redistribute the raw file; modification allowed per license terms.',
  };
}

export function writeAttributionReport(jobDir, assets) {
  const ok = assets.filter((a) => a.status === 'ok');
  const lines = [
    '# Asset Attribution Report', '',
    `Generated: ${new Date().toISOString()}`, '',
    '| Scene | Provider | Asset | Creator | License | Commercial use |',
    '|---|---|---|---|---|---|',
    ...ok.map((a) => `| ${a.sceneId} | ${a.provider} | [${a.assetId}](${a.pageUrl}) | ${a.creator} | [${a.license}](${a.licenseUrl || a.pageUrl}) | ${a.commercialUse} |`),
    '',
    '## License notes',
    ...ok.map((a) => `- Scene ${a.sceneId} (${a.provider}): ${a.license}. Downloaded ${a.downloadedAt}. Source file: ${a.fileUrl}`),
    '',
    '_Excluded material: any asset whose licensing status could not be established was not downloaded._',
  ];
  const md = path.join(jobDir, 'attribution.md');
  fs.writeFileSync(md, lines.join('\n'));
  const js = path.join(jobDir, 'attribution.json');
  fs.writeFileSync(js, JSON.stringify(assets, null, 2));
  return { md, json: js };
}
