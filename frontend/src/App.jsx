import { useState, useEffect, useRef } from 'react';

const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) { const t = await r.text(); throw new Error(t.slice(0, 200) || `HTTP ${r.status}`); }
  return r.json();
};

function fmtLeft(hoursLeft) {
  if (hoursLeft >= 24) return `${Math.floor(hoursLeft / 24)}d ${hoursLeft % 24}h left`;
  if (hoursLeft >= 1) return `${hoursLeft}h left`;
  return 'expiring soon';
}

export default function App() {
  const [script, setScript] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [projectName, setProjectName] = useState('');
  const [packId, setPackId] = useState(null);
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState([]);
  const [queue, setQueue] = useState(null);
  const timer = useRef(null);

  const loadProjects = async () => {
    try {
      const ps = await api('/api/projects');
      setProjects(ps);
    } catch {}
    try {
      const q = await api('/api/queue');
      setQueue(q);
    } catch {}
  };

  useEffect(() => {
    loadProjects();
    const t = setInterval(loadProjects, 10000);
    return () => clearInterval(t);
  }, []);

  const start = async () => {
    setErr('');
    if (script.trim().length < 20) { setErr('Script kam se kam 20 characters ki ho.'); return; }
    setBusy(true);
    try {
      const r = await api('/api/packs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: script.trim(), aspect, projectName: projectName.trim() }),
      });
      setPackId(r.id);
      loadProjects();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  useEffect(() => {
    if (!packId) return;
    const poll = async () => {
      try {
        const s = await api('/api/packs/' + packId);
        setStatus(s);
        if (s.stage === 'done' || s.stage === 'failed') {
          clearInterval(timer.current);
          setBusy(false);
          loadProjects();
        }
      } catch (e) { setErr(e.message); }
    };
    poll();
    timer.current = setInterval(poll, 3000);
    return () => clearInterval(timer.current);
  }, [packId]);

  const words = script.trim().split(/\s+/).filter(Boolean).length;
  const estSegs = Math.ceil(words / 10);

  return (
    <div className="vault">
      <header>
        <div className="brand">◈ TDA B-Roll Vault</div>
        <p className="tagline">Har 4 second ke liye AI visuals — project 48 hours tak saved</p>
      </header>

      {!packId && (
        <main className="panel">
          <label className="field-label">Project ka naam</label>
          <input
            className="name-input"
            placeholder="e.g. AI Explainer Video — Part 1"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            maxLength={80}
          />
          <label className="field-label">Apni script paste karo ({words} words → ~{estSegs} segments × 4s)</label>
          <textarea
            className="script-input"
            rows={10}
            placeholder="Yahan apni script likho ya paste karo…"
            value={script}
            onChange={(e) => setScript(e.target.value)}
          />
          <div className="hints">
            <span>🤖 Har 4s segment → AI visual</span>
            <span>📦 ZIP mein tarteeb-wise: seg-001, seg-002…</span>
            <span>⏰ 48 hours tak saved rahega</span>
          </div>
          <label className="field-label">Visual ratio</label>
          <div className="ratio-row">
            {[
              ['16:9', '16:9 — YouTube'],
              ['9:16', '9:16 — Shorts/Reels'],
              ['1:1', '1:1 — Square'],
            ].map(([v, label]) => (
              <button key={v}
                className={'ratio-btn' + (aspect === v ? ' active' : '')}
                onClick={() => setAspect(v)}>{label}</button>
            ))}
          </div>
          {err && <div className="error">{err}</div>}
          <button className="primary big" disabled={busy || words < 5} onClick={start}>
            {busy ? 'Queue mein daal rahe…' : '📦 Build B-Roll Pack'}
          </button>
          <p className="muted small" style={{ marginTop: 8 }}>
            🤖 Script submit karo — server khud visuals banayega. Browser band kardo, kaam chalta rahega.
            {queue && queue.queued > 0 && ` Queue mein ${queue.queued} project(s) hain.`}
          </p>
        </main>
      )}

      {packId && status && status.stage !== 'done' && status.stage !== 'failed' && (
        <main className="panel">
          <h2>📦 {status.stage === 'queued' ? 'Queue mein hai…' : 'Ban raha hai…'}</h2>
          <div className="progress big"><div className="bar" style={{ width: (status.progress || 5) + '%' }} /></div>
          <p>{status.stageDetail || status.stage}</p>
          <p className="muted small">Browser band karsakte ho — server kaam karta rahega. "My Projects" mein aakar download karlena.</p>
          <button onClick={() => { setPackId(null); setStatus(null); }}>← My Projects dekho</button>
        </main>
      )}

      {status?.stage === 'failed' && (
        <main className="panel"><div className="error">{status.error || 'Failed'}</div>
          <button onClick={() => { setPackId(null); setStatus(null); }}>← Try again</button></main>
      )}

      {status?.stage === 'done' && status.result && (
        <main className="panel">
          <h2>✅ B-Roll Pack Ready!</h2>
          <div className="stats">
            <div className="stat"><strong>{status.result.segments}</strong><span>segments × 4s</span></div>
            <div className="stat"><strong>{status.result.totalSec}s</strong><span>total</span></div>
            <div className="stat"><strong>{status.result.withVisual}</strong><span>with visuals</span></div>
            <div className="stat"><strong>{(status.result.sizeBytes / 1048576).toFixed(1)}MB</strong><span>ZIP size</span></div>
          </div>
          <p className="muted small">⏰ 48 hours tak "My Projects" mein saved rahega</p>
          <div className="row">
            <a className="btn primary big" href={status.result.zip} download>⬇ Download B-Roll Pack</a>
            <button onClick={() => { setPackId(null); setStatus(null); setScript(''); setProjectName(''); }}>📦 New Pack</button>
          </div>
        </main>
      )}

      {/* MY PROJECTS — 48h save folder */}
      <section className="panel projects">
        <h2>📁 My Projects <span className="muted small">(48 hours tak saved)</span></h2>
        {projects.length === 0 && (
          <p className="muted">Abhi koi project nahi. Upar script dekar pehla pack banao!</p>
        )}
        {projects.map((p) => (
          <div key={p.id} className="project-card">
            <div className="project-info">
              <strong>{p.name}</strong>
              <span className="muted small">
                {p.segments ? `${p.segments} clips` : ''} · {p.sizeBytes ? (p.sizeBytes / 1048576).toFixed(1) + 'MB' : ''}
                {' · '}⏰ {fmtLeft(p.hoursLeft)}
              </span>
              <span className={'badge ' + p.stage}>
                {p.stage === 'done' ? '✅ Ready' : p.stage === 'failed' ? '❌ Failed' : p.stage === 'queued' ? '⏳ Queued' : `🔨 ${p.progress || 5}%`}
              </span>
              {p.stage !== 'done' && p.stage !== 'failed' && p.stageDetail && (
                <span className="muted small">{p.stageDetail}</span>
              )}
              {p.error && <span className="error small">{p.error}</span>}
            </div>
            {p.downloadUrl && (
              <a className="btn primary" href={p.downloadUrl} download>⬇ Download</a>
            )}
          </div>
        ))}
      </section>

      <footer className="muted small">
        Free & public tool — AI-generated visuals. Projects auto-delete after 48 hours.
      </footer>
    </div>
  );
}
