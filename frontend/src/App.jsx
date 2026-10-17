import { useState, useEffect, useRef } from 'react';

const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) { const t = await r.text(); throw new Error(t.slice(0, 200) || `HTTP ${r.status}`); }
  return r.json();
};

export default function App() {
  const [script, setScript] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [packId, setPackId] = useState(null);
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const start = async () => {
    setErr('');
    if (script.trim().length < 20) { setErr('Script kam se kam 20 characters ki ho.'); return; }
    setBusy(true);
    try {
      const r = await api('/api/packs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: script.trim(), aspect }),
      });
      setPackId(r.id);
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
        <p className="tagline">Har 4 second ke liye historical proof visuals — real archival + AI</p>
      </header>

      {!packId && (
        <main className="panel">
          <label className="field-label">Apni script paste karo ({words} words → ~{estSegs} segments × 4s)</label>
          <textarea
            className="script-input"
            rows={12}
            placeholder="Yahan apni script likho ya paste karo…&#10;&#10;Example: In 1947, Pakistan came into being. Quaid-e-Azam Muhammad Ali Jinnah led the movement…"
            value={script}
            onChange={(e) => setScript(e.target.value)}
          />
          <div className="hints">
            <span>🏛️ Historical scenes → real archival visuals (Wikimedia)</span>
            <span>🤖 Na mile → AI generate karega</span>
            <span>📦 ZIP mein tarteeb-wise: seg-001, seg-002…</span>
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
            {busy ? 'Starting…' : '📦 Build B-Roll Pack'}
          </button>
        </main>
      )}

      {packId && status && status.stage !== 'done' && status.stage !== 'failed' && (
        <main className="panel">
          <h2>📦 Collecting visuals…</h2>
          <div className="progress big"><div className="bar" style={{ width: (status.progress || 5) + '%' }} /></div>
          <p>{status.stageDetail || status.stage}</p>
          <p className="muted small">Archival + stock + AI — har 4s segment ke liye best visual…</p>
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
            <div className="stat"><strong>{status.result.historical}</strong><span>🏛️ proof</span></div>
            <div className="stat"><strong>{(status.result.sizeBytes / 1048576).toFixed(1)}MB</strong><span>ZIP size</span></div>
          </div>
          <p className="muted small">ZIP mein: seg-001.mp4, seg-002.jpg… (timeline order) + TIMELINE.md (cut sheet with narration)</p>
          <div className="row">
            <a className="btn primary big" href={status.result.zip} download>⬇ Download B-Roll Pack</a>
            <button onClick={() => { setPackId(null); setStatus(null); setScript(''); }}>📦 New Pack</button>
          </div>
        </main>
      )}

      <footer className="muted small">
        Free & public tool — royalty-free visuals (Pixabay, Coverr, Wikimedia) + AI-generated. Check licenses in manifest.
      </footer>
    </div>
  );
}
