// Permanent project storage via GitHub Releases.
// Render free tier has EPHEMERAL disk — files vanish on restart.
// Solution: upload finished ZIPs to GitHub Releases (permanent, downloadable).
// Project list = GitHub releases. 48h expiry = delete old releases.
import fs from 'node:fs';

const GH_OWNER = 'gamlite20-ops';
const GH_REPO = 'tda-broll-vault';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';

const ghHeaders = {
  'Authorization': `Bearer ${GH_TOKEN}`,
  'Accept': 'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
  'User-Agent': 'TDA-BRoll-Vault/1.0',
};

export async function uploadPackToGitHub(packId, projectName, zipPath, meta) {
  if (!GH_TOKEN) {
    console.error('[github] No GITHUB_TOKEN — skipping permanent upload');
    return null;
  }
  try {
    const tag = `pack-${packId}`;
    // 1. Create release
    const relRes = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases`, {
      method: 'POST',
      headers: ghHeaders,
      body: JSON.stringify({
        tag_name: tag,
        name: `${projectName} (${packId.slice(0, 8)})`,
        body: `B-Roll pack: ${meta.segments} segments × 4s\nCreated: ${new Date().toISOString()}\nExpires: 48h from creation (auto-deleted)`,
      }),
    });
    const rel = await relRes.json();
    if (!rel.id) throw new Error(rel.message || 'Release creation failed');

    // 2. Upload ZIP asset
    const zipData = fs.readFileSync(zipPath);
    const fileName = `broll-pack-${packId.slice(0, 8)}.zip`;
    const upRes = await fetch(
      `https://uploads.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/${rel.id}/assets?name=${fileName}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GH_TOKEN}`,
          'Content-Type': 'application/zip',
          'User-Agent': 'TDA-BRoll-Vault/1.0',
        },
        body: zipData,
      }
    );
    const asset = await upRes.json();
    if (!asset.browser_download_url) throw new Error(asset.message || 'Asset upload failed');

    console.log(`[github] Pack ${packId} uploaded: ${asset.browser_download_url}`);
    return {
      releaseId: rel.id,
      downloadUrl: asset.browser_download_url,
      tag,
    };
  } catch (e) {
    console.error('[github] Upload failed:', e.message);
    return null;
  }
}

export async function listGitHubProjects() {
  if (!GH_TOKEN) return [];
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases?per_page=50`,
      { headers: ghHeaders }
    );
    const releases = await res.json();
    if (!Array.isArray(releases)) return [];
    const now = Date.now();
    return releases
      .filter((r) => r.tag_name?.startsWith('pack-'))
      .map((r) => {
        const createdAt = new Date(r.created_at).getTime();
        const expiresAt = createdAt + 48 * 60 * 60 * 1000;
        const asset = r.assets?.[0];
        return {
          id: r.tag_name.replace('pack-', ''),
          name: r.name || r.tag_name,
          createdAt: r.created_at,
          expiresAt: new Date(expiresAt).toISOString(),
          hoursLeft: Math.max(0, Math.round((expiresAt - now) / 3600000)),
          expired: now > expiresAt,
          downloadUrl: asset?.browser_download_url || null,
          sizeBytes: asset?.size || 0,
          releaseId: r.id,
          stage: 'done',
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (e) {
    console.error('[github] List failed:', e.message);
    return [];
  }
}

export async function deleteGitHubRelease(releaseId) {
  if (!GH_TOKEN) return false;
  try {
    await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/${releaseId}`, {
      method: 'DELETE',
      headers: ghHeaders,
    });
    // Also delete the tag
    return true;
  } catch { return false; }
}

export async function cleanupExpiredGitHub() {
  const projects = await listGitHubProjects();
  let removed = 0;
  for (const p of projects) {
    if (p.expired) {
      await deleteGitHubRelease(p.releaseId);
      removed++;
    }
  }
  return removed;
}
