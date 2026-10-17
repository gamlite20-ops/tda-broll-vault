// Gemini client: script analysis (structured scene plan) and narration TTS.
// When GEMINI_API_KEY is missing, analysis falls back to a local heuristic
// segmenter (clearly marked in the plan), and TTS falls back to gTTS.
import { config } from './config.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// AI directors available for script analysis. 'free' tier works with any
// API key; 'paid' (Argon) needs billing enabled on the API project.
export const AI_MODELS = {
  'gemini-3.8-flash': { label: 'Gemini 3.8 Flash', tier: 'free' },
  'gemini-4-argon': { label: 'Gemini 4 Argon', tier: 'paid' },
  'github-models': { label: 'GitHub Models (free)', tier: 'free' },
  'pollinations': { label: 'Pollinations (free, no key)', tier: 'free' },
};

export function resolveModel(requested) {
  if (requested && AI_MODELS[requested]) return requested;
  if (AI_MODELS[config.geminiModel]) return config.geminiModel;
  return 'gemini-3.8-flash';
}

export function isFreeModel(id) {
  return id === 'github-models' || id === 'pollinations';
}

// --- Free-model fallbacks (no billing, no paid key) --------------------------
// Used automatically when Gemini fails (quota/429/5xx), and selectable
// directly as AI Directors. GitHub Models: free tier via a GitHub PAT with
// the "models" permission (https://github.com/settings/tokens).
// Pollinations: completely free, no key at all.
async function openAiChat(url, headers, model, messages, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.4 }),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Free-model API error ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const out = data?.choices?.[0]?.message?.content || '';
    if (!out) throw new Error('Free-model API returned empty content');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function githubModelsAnalyze(prompt) {
  if (!config.githubModelsToken) throw new Error('GITHUB_MODELS_TOKEN is not configured');
  const out = await openAiChat(
    'https://models.github.ai/inference/chat/completions',
    { Authorization: `Bearer ${config.githubModelsToken}` },
    'openai/gpt-4.1-mini',
    [{ role: 'system', content: 'You are a professional video editor and script analyst. Output strict JSON only — no markdown, no commentary.' },
     { role: 'user', content: prompt }],
    8192,
  );
  return { plan: extractJson(out), source: 'github-models-fallback', model: 'openai/gpt-4.1-mini' };
}

async function pollinationsAnalyze(prompt) {
  const out = await openAiChat(
    'https://text.pollinations.ai/openai',
    {},
    'openai',
    [{ role: 'system', content: 'You are a professional video editor and script analyst. Output strict JSON only — no markdown, no commentary.' },
     { role: 'user', content: prompt }],
    8192,
  );
  return { plan: extractJson(out), source: 'pollinations-fallback', model: 'pollinations/openai' };
}

// Tries every free analysis provider in order; returns the first that works.
export async function freeModelAnalyze(prompt) {
  const errors = [];
  if (config.githubModelsToken) {
    try { return await githubModelsAnalyze(prompt); }
    catch (e) { errors.push(`github-models: ${e.message}`); }
  }
  try { return await pollinationsAnalyze(prompt); }
  catch (e) { errors.push(`pollinations: ${e.message}`); }
  throw new Error(`All free AI models failed — ${errors.join(' | ')}`);
}

async function geminiGenerate(model, body, { retries = 3, retryOn429 = false, timeoutMs = 90000 } = {}) {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured');
  const url = `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
  const backoff = (attempt) => new Promise((r) => setTimeout(r, [8000, 20000, 45000][attempt] || 45000));
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text = '';
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      text = await res.text().catch(() => '');
    } catch (e) {
      clearTimeout(timer);
      // Hung connection / network blip → backoff and retry like a 503.
      if (attempt < retries) { await backoff(attempt); continue; }
      throw new Error(`Gemini API request failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return JSON.parse(text);
    // 503 = transient Google-side overload → backoff and retry.
    // 429 = usually per-minute rate limit → retry only when the caller opts
    // in (TTS makes many rapid calls); a hard billing/quota block still
    // surfaces via the friendly error below after retries run out.
    const retryable = res.status === 503 || (res.status === 429 && retryOn429);
    if (retryable && attempt < retries) {
      await backoff(attempt);
      continue;
    }
    let hint = '';
    if (/billing/i.test(text)) {
      hint = ' — billing is not enabled for this API project/key. Either enable billing, or use gemini-3.8-flash (free tier).';
    } else if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(text)) {
      hint = ' — the API key is invalid. Check GEMINI_API_KEY.';
    } else if (res.status === 429) {
      hint = ' — quota/rate limit hit. Wait a minute and retry.';
    }
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 300)}${hint}`);
  }
  throw new Error('Gemini API error 503: service unavailable after retries');
}

function extractJson(text) {
  // Strip markdown fences if the model adds them, then parse.
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const SCENE_SCHEMA_HINT = `{
  "language": "ISO 639-1 code of the script language, e.g. en, ur, es, id, ru, pt, ar",
  "languageName": "human readable language name",
  "tone": "one of: documentary, educational, cinematic, mystery, emotional, technology, finance, historical, motivational, other",
  "hook": "the opening hook sentence",
  "cta": "the call to action if present, else empty string",
  "estimatedTotalSec": 0,
  "scenes": [
    {
      "sceneId": 1,
      "scriptText": "original script text for this scene, unchanged",
      "narration": "clean narration text for TTS (same meaning, speakable)",
      "visualConcept": "what the viewer should see",
      "searchTerms": ["3-6 concrete stock-footage search queries"],
      "altSearchTerms": ["2-3 backup queries"],
      "visualType": "video | photo | chart | map | text",
      "onScreenText": "short supporting text or empty string",
      "overlayText": "ONE key phrase (2-6 words) for big animated text, or empty",
      "overlayStyle": "magazine | paper | bold-center | lower-third | none",
      "editStyle": "vox | documentary | motion",
      "transition": "cut | dissolve | fade | wipe",
      "animationStyle": "slow-zoom-in | slow-zoom-out | pan-left | pan-right | static",
      "colorTreatment": "natural | warm | cool | cinematic-teal | bw | vibrant",
      "musicCue": "calm | tense | uplifting | dramatic | minimal | none",
      "sfxCue": "whoosh | chime | heartbeat | paper | none",
      "evidenceNote": "any source/evidence requirement or empty string"
    }
  ]
}`;

const ANALYSIS_PROMPT = `You are a professional video editor and script analyst. Analyze the following script and produce a scene-by-scene production plan as strict JSON matching this schema (no markdown, no commentary):

${SCENE_SCHEMA_HINT}

Rules:
- Detect the script language automatically. Supported: English, Urdu, Roman Urdu (use "ur" with languageName "Roman Urdu"), Spanish, Portuguese, Russian, Indonesian, Arabic, others.
- Split into scenes of 1-3 sentences each; every scene gets 4-10 seconds of narration.
- Identify hooks, questions, key facts, numbers, names, dates, emotional moments, suspense, reveals, and calls to action; reflect them in visualConcept, onScreenText and musicCue.
- searchTerms must be concrete visual queries (e.g. "industrial robot arm assembly line"), never abstract words alone.
- Prefix EVERY searchTerm with the video's main subject or place name (e.g. "Mohenjo-daro streets", not "streets") — generic words alone match unrelated stock.
- For statistics, prefer visualType "chart" or "text" with the number in onScreenText.
- EDIT STYLES (mix them like a pro editor — vary across scenes, never repeat the same style twice in a row):
  * "vox": explainer style — bold text overlays on simple backgrounds, infographic feel. Use for definitions, facts, "how it works".
  * "documentary": cinematic B-roll footage, subtle color grade, lower thirds. Use for stories, examples, real-world cases.
  * "motion": dynamic After-Effects style — fast zooms, graphic elements, energetic. Use for hooks, questions, reveals, CTAs.
- overlayText: the single most impactful phrase of the scene (2-6 words) for a big animated text card. Pair with overlayStyle:
  * "magazine": bold headline on a colored block, slides in (for shocking facts)
  * "paper": typewriter/paper texture feel (for quotes, definitions)
  * "bold-center": huge centered text with pop animation (for hooks, questions)
  * "lower-third": elegant bar at bottom (for names, places, stats)
  * "none": no big text (pure B-roll moments)
- Vary overlayStyle across scenes; not every scene needs overlayText.
- Do NOT change facts, numbers, names or meaning. Preserve the original script text in scriptText.
- estimatedTotalSec: narration estimate at ~850 characters per minute for English, ~700 for others.

SCRIPT:
"""`;

export async function analyzeScript(script, { improveScript = false, model } = {}) {
  const useModel = resolveModel(model);
  const prompt = ANALYSIS_PROMPT + script + '"""'
    + (improveScript
      ? '\nOptional: you may lightly improve flow in "narration" only (grammar, speakability). Never alter facts.'
      : '\nKeep "narration" faithful to the original wording; only make it speakable (expand abbreviations).');

  // Direct free-model selection (AI Director picker).
  if (useModel === 'github-models' || useModel === 'pollinations') {
    const fn = useModel === 'github-models' ? githubModelsAnalyze : pollinationsAnalyze;
    const { plan, source, model: m } = await fn(prompt);
    const validated = validatePlan(plan, script);
    validated.source = source;
    validated.model = m;
    return validated;
  }

  // Gemini first; on ANY failure fall through the free chain (quota/429/5xx).
  // Standing rule: Argon 4 failure → retry Gemini 3.8 Flash on the SAME key
  // before leaving Gemini entirely.
  const geminiModels = useModel === 'gemini-4-argon'
    ? ['gemini-4-argon', 'gemini-3.8-flash']
    : [useModel];
  let geminiErr = null;
  for (const gm of geminiModels) {
    try {
      const data = await geminiGenerate(gm, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4, maxOutputTokens: 8192 },
      });
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      const plan = extractJson(text);
      const validated = validatePlan(plan, script);
      validated.source = 'gemini';
      validated.model = gm;
      if (gm !== useModel) {
        validated.fallbackFrom = useModel;
        validated.fallbackReason = String(geminiErr?.message || '').slice(0, 300);
      }
      return validated;
    } catch (e) {
      geminiErr = e;
    }
  }
  try {
    const { plan, source, model: m } = await freeModelAnalyze(prompt);
    const validated = validatePlan(plan, script);
    validated.source = source;
    validated.model = m;
    validated.fallbackReason = String(geminiErr.message).slice(0, 300);
    return validated;
  } catch (freeErr) {
    throw new Error(`All AI analysis providers failed — gemini: ${geminiErr.message} | free: ${freeErr.message}`);
  }
}

export function validatePlan(plan, script) {
  if (!plan || !Array.isArray(plan.scenes) || plan.scenes.length === 0) {
    throw new Error('Analysis produced no scenes — invalid plan');
  }
  const allowedVisual = new Set(['video', 'photo', 'chart', 'map', 'text']);
  const allowedTrans = new Set(['cut', 'dissolve', 'fade', 'wipe']);
  plan.scenes = plan.scenes.map((s, i) => ({
    sceneId: s.sceneId || i + 1,
    scriptText: String(s.scriptText || ''),
    narration: String(s.narration || s.scriptText || ''),
    visualConcept: String(s.visualConcept || ''),
    searchTerms: Array.isArray(s.searchTerms) ? s.searchTerms.slice(0, 6).map(String) : [],
    altSearchTerms: Array.isArray(s.altSearchTerms) ? s.altSearchTerms.slice(0, 3).map(String) : [],
    visualType: allowedVisual.has(s.visualType) ? s.visualType : 'video',
    onScreenText: String(s.onScreenText || ''),
    overlayText: String(s.overlayText || '').slice(0, 60),
    overlayStyle: ['magazine', 'paper', 'bold-center', 'lower-third', 'none'].includes(s.overlayStyle) ? s.overlayStyle : 'none',
    editStyle: ['vox', 'documentary', 'motion'].includes(s.editStyle) ? s.editStyle : 'documentary',
    transition: allowedTrans.has(s.transition) ? s.transition : (i === 0 ? 'fade' : 'cut'),
    animationStyle: String(s.animationStyle || 'slow-zoom-in'),
    colorTreatment: String(s.colorTreatment || 'natural'),
    musicCue: String(s.musicCue || 'calm'),
    sfxCue: String(s.sfxCue || 'none'),
    evidenceNote: String(s.evidenceNote || ''),
    timelineStartSec: 0, // filled by the pipeline after TTS timing
    estDurationSec: 0,   // filled by the pipeline after TTS timing
  }));
  plan.language = plan.language || detectLanguage(script);
  plan.languageName = plan.languageName || plan.language;
  plan.tone = plan.tone || 'educational';
  plan.hook = plan.hook || '';
  plan.cta = plan.cta || '';
  plan.estimatedTotalSec = Number(plan.estimatedTotalSec) || 0;
  return plan;
}

// --- Heuristic fallback (no API key) ---------------------------------------
const SENT_SPLIT = /(?<=[.!?।…»"”])\s+(?=[A-ZÀ-ÞА-ЯЁ0-9"'“\(\[])|(?<=[.!?])\s*$/;

export function detectLanguage(text) {
  const t = text.slice(0, 2000);
  if (/[\u0600-\u06FF]/.test(t)) {
    // Arabic script: distinguish Urdu (ے ھ ں ٹ ڈ ڑ) from Arabic
    return /[ےھںٹڈڑھ]/.test(t) ? 'ur' : 'ar';
  }
  if (/[\u0400-\u04FF]/.test(t)) return 'ru';
  const low = t.toLowerCase();
  const es = [' el ', ' la ', ' los ', ' una ', ' porque ', ' qué ', ' está '].filter((w) => low.includes(w)).length;
  const id = [' yang ', ' dan ', ' dengan ', ' adalah ', ' untuk ', ' wanita ', ' pria '].filter((w) => low.includes(w)).length;
  const pt = [' não ', ' você ', ' para ', ' com ', ' uma '].filter((w) => low.includes(w)).length;
  if (es >= 2) return 'es';
  if (id >= 2) return 'id';
  if (pt >= 2) return 'pt';
  return 'en';
}

const KEYWORD_STOP = new Set(('the,a,an,and,or,but,of,to,in,on,for,with,that,this,these,those,it,its,is,are,was,were,be,been,has,have,had,will,would,can,could,should,as,at,by,from,' +
  'se,ke,ki,ka,ko,mein,aur,hai,jo,yeh,woh,nahi,de,la,el,los,las,un,una,que,con,por,para,dan,yang,dengan,adalah,dari,untuk,itu,ini,не,и,в,на,с,что,это,как,e,uma,para,com,não,' +
  // numbers, time words and generic fillers make terrible visual queries
  'one,two,three,four,five,six,seven,eight,nine,ten,hundred,thousand,million,billion,first,second,third,many,much,more,most,very,just,also,even,years,year,ago,today,around,still,almost,every,world,people,human,history,time,times,into,over,under,between,through,during,while,when,where,which,there,their,then,than,what,were,your').split(','));

function keywords(text, n = 6) {
  // Prefer distinctive nouns: capitalized words and longer words score higher.
  const words = text.replace(/[^a-zA-Zà-ÿА-яЁ\u0600-\u06FF\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const freq = new Map();
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (w.length < 5 || KEYWORD_STOP.has(w)) continue;
    const bonus = /^[A-ZÀ-ÞА-ЯЁ]/.test(raw) ? 2 : 0; // proper nouns win
    freq.set(w, (freq.get(w) || 0) + 1 + bonus);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

export function heuristicAnalyze(script) {
  const sentences = script.split(SENT_SPLIT).map((s) => s.trim()).filter(Boolean);
  const lang = detectLanguage(script);
  // Global topic anchor: the most frequent significant word appearing in at
  // least 2 scenes (e.g. "mohenjo-daro"). Every search query is prefixed with
  // it, so generic words like "streets" can't match unrelated stock
  // ("Great Streets" press conference in a Mohenjo-daro documentary).
  const chunks0 = [];
  for (let i = 0; i < sentences.length; i += 2) chunks0.push(sentences.slice(i, i + 2).join(' '));
  let anchor = '';
  for (const g of keywords(script, 12)) {
    if (chunks0.filter((c) => c.toLowerCase().includes(g)).length >= 2) { anchor = g; break; }
  }
  const scenes = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const chunk = sentences.slice(i, i + 2).join(' ');
    const kws = keywords(chunk);
    const hasNumber = /\d/.test(chunk);
    // Clean, concrete queries: keyword pairs first (most distinctive), then singles.
    const pairs = [];
    for (let k = 0; k + 1 < kws.length && pairs.length < 2; k += 2) pairs.push(`${kws[k]} ${kws[k + 1]}`);
    const rawQueries = [...pairs, ...kws.slice(0, 4)];
    // Anchor every query with the topic; drop duplicate anchor words.
    const queries = anchor
      ? [...new Set(rawQueries.map((q) => {
          const rest = q.split(/\s+/).filter((w) => w !== anchor);
          return rest.length ? `${anchor} ${rest.join(' ')}` : anchor;
        }))]
      : rawQueries;
    scenes.push({
      sceneId: scenes.length + 1,
      scriptText: chunk,
      narration: chunk,
      visualConcept: kws.join(', ') || 'abstract background',
      searchTerms: queries.length ? queries : ['documentary'],
      altSearchTerms: anchor ? [`${anchor} documentary`, `${anchor} ruins`, `${anchor} aerial`] : ['documentary still', 'historical'],
      visualType: hasNumber ? 'text' : 'video',
      onScreenText: hasNumber ? (chunk.match(/\d[\d.,%]*/g) || []).slice(0, 2).join('  ') : '',
      overlayText: '',
      overlayStyle: 'none',
      // Cycle edit styles like a pro editor: hook=motion, then alternate.
      editStyle: scenes.length === 0 ? 'motion' : ['documentary', 'vox', 'documentary', 'motion'][scenes.length % 4],
      transition: scenes.length === 0 ? 'fade' : 'cut',
      animationStyle: 'slow-zoom-in',
      colorTreatment: 'natural',
      musicCue: /secret|mystery|fear|danger/i.test(chunk) ? 'tense' : 'calm',
      sfxCue: 'none',
      evidenceNote: '',
      timelineStartSec: 0,
      estDurationSec: 0,
    });
  }
  return {
    language: lang, languageName: lang, tone: 'educational',
    hook: sentences[0] || '', cta: /subscribe|follow|like|comment|share/i.test(script) ? sentences[sentences.length - 1] || '' : '',
    estimatedTotalSec: Math.round(script.length / 14),
    scenes, source: 'heuristic-fallback',
  };
}

// --- TTS --------------------------------------------------------------------
// All 30 Google AI Studio (Gemini) TTS voices. The user picks one after
// pasting the script; per-language defaults below are only the fallback.
export const TTS_VOICES_ALL = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Alnilam',
  'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix',
  'Sadachbia', 'Sadaltager', 'Sulafat', 'Rasalmague',
];

const TTS_VOICES = {
  en: 'Kore', ur: 'Kore', es: 'Charon', id: 'Fenrir', ru: 'Puck',
  pt: 'Charon', ar: 'Kore', hi: 'Kore',
};

export async function geminiTts(text, { lang = 'en', voice } = {}) {
  const voiceName = voice && voice !== 'auto' ? voice : (TTS_VOICES[lang] || 'Kore');
  // TTS fires one request per scene in quick succession — free-tier RPM
  // limits are routinely hit, so 429s are retried with backoff here.
  const data = await geminiGenerate(config.geminiTtsModel, {
    contents: [{ parts: [{ text: `Say naturally, at a steady documentary pace: ${text}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  }, { retryOn429: true });
  const part = data?.candidates?.[0]?.content?.parts?.[0];
  const b64 = part?.inlineData?.data;
  if (!b64) throw new Error('Gemini TTS returned no audio data');
  return { pcmBase64: b64, sampleRate: 24000, voice: voiceName };
}

// WAV writer for 16-bit mono PCM
export function pcmToWav(pcmBuffer, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}
