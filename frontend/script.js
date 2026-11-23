const $ = id => document.getElementById(id);
const chat = $('chat'), input = $('msg'), core = $('core'), coreText = $('coreText');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/';
const FALLBACK = ['gemini-3.7-flash-lite', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-latest'];
const SYSTEM = 'You are J.A.R.V.I.S, a witty, loyal AI assistant. Address the user as "Boss". Keep answers short and clear unless asked for detail. Always reply in the language the user writes in.';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};

let apiKey  = store.get('jv_key', '');
let model   = store.get('jv_model', '');
let history = store.get('jv_hist', []);
let speak   = store.get('jv_speak', false);
let micLang = store.get('jv_lang', 'en-IN');
let models = null, busy = false;

function setRow(id, text, ok) { const e = $(id); e.textContent = text; e.className = ok ? 'on' : 'off'; }

function refresh() {
  setRow('stNet', navigator.onLine ? '● ONLINE' : '○ OFFLINE', navigator.onLine);
  setRow('stVoice', speak ? '● ON' : '○ OFF', speak);
  setRow('stMem', '● ' + Math.floor(history.length / 2) + ' SAVED', true);
  $('voiceBtn').textContent = 'VOICE: ' + (speak ? 'ON' : 'OFF');
  $('langBtn').textContent = 'MIC: ' + (micLang === 'te-IN' ? 'TE' : 'EN');
}

function add(text, who) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}

function askKey() {
  const k = prompt('Paste your Gemini API key (saved only in this browser):', apiKey || '');
  if (k !== null) {
    apiKey = k.trim();
    store.set('jv_key', apiKey);
    models = null;
    setRow('stAI', apiKey ? '○ STANDBY' : '○ NO KEY', false);
  }
  return !!apiKey;
}

async function loadModels() {
  if (models) return models;
  let f = [];
  const res = await fetch(BASE + 'models?pageSize=200&key=' + encodeURIComponent(apiKey));
  const d = await res.json();
  if (d.models) {
    f = d.models
      .filter(m => /^models\/gemini-[\d.]+-flash(-lite)?$/.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.slice(7))
      .sort((a, b) => {
        const la = a.includes('lite') ? 1 : 0, lb = b.includes('lite') ? 1 : 0;
        return la !== lb ? lb - la : parseFloat(b.match(/[\d.]+/)[0]) - parseFloat(a.match(/[\d.]+/)[0]);
      });
  }
  models = f.concat(FALLBACK.filter(m => !f.includes(m)));
  return models;
}

// Streams the reply so text appears while Gemini is still writing.
async function stream(m, contents, onText) {
  const res = await fetch(BASE + 'models/' + m + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents })
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const d = await res.json(); if (d.error) msg = d.error.message; } catch (e) {}
    return { ok: false, code: res.status, msg };
  }
  let full = '';
  const eat = line => {
    line = line.trim();
    if (line.indexOf('data:') !== 0) return;
    try {
      const d = JSON.parse(line.slice(5));
      const p = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
      if (p) { const t = p.map(x => x.text || '').join(''); if (t) { full += t; onText(full); } }
    } catch (e) {}
  };
  if (!res.body || !res.body.getReader) {
    (await res.text()).split('\n').forEach(eat);
  } else {
    const r = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { eat(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    eat(buf);
  }
  return full ? { ok: true, text: full } : { ok: false, code: 0, msg: 'Empty response' };
}

function say(t) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(t.replace(/[*#`_]/g, ''));
  if (/[\u0C00-\u0C7F]/.test(t)) u.lang = 'te-IN';
  speechSynthesis.speak(u);
}

async function send(text) {
  if (busy || !text) return;
  if (!apiKey && !askKey()) { add('J.A.R.V.I.S: API key required, Boss. Tap API KEY.', 'ai'); return; }

  busy = true;
  core.classList.add('busy');
  coreText.textContent = 'PROCESSING...';
  add('YOU: ' + text, 'user');
  input.value = '';
  const out = add('J.A.R.V.I.S: ...', 'ai');
  const contents = history.concat([{ role: 'user', parts: [{ text }] }]);
  let err = '';

  try {
    let order = model ? [model] : [], tried = {};
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) order = (await loadModels()).filter(m => !tried[m]);
      for (const m of order) {
        tried[m] = 1;
        const r = await stream(m, contents, t => { out.textContent = 'J.A.R.V.I.S: ' + t; chat.scrollTop = chat.scrollHeight; });
        if (r.ok) {
          model = m; store.set('jv_model', m);
          history = contents.concat([{ role: 'model', parts: [{ text: r.text }] }]).slice(-40);
          store.set('jv_hist', history);
          setRow('stAI', '● ONLINE', true);
          if (speak) say(r.text);
          return;
        }
        err = r.msg;
        if ([400, 401, 403].includes(r.code)) { pass = 2; break; } // key problem: stop
        // 404 / 429 (quota): try the next model
      }
    }
    out.textContent = 'J.A.R.V.I.S: ERROR - ' + err;
    setRow('stAI', '○ OFFLINE', false);
  } catch (e) {
    out.textContent = 'J.A.R.V.I.S: Cannot reach Google (' + e.message + '). Open in Chrome, turn off VPN/ad blocker, check internet.';
    setRow('stAI', '○ OFFLINE', false);
  } finally {
    busy = false;
    core.classList.remove('busy');
    coreText.textContent = 'CORE ACTIVE';
    refresh();
  }
}

// ---- buttons ----
$('send').onclick = () => send(input.value.trim());
input.addEventListener('keydown', e => { if (e.key === 'Enter') send(input.value.trim()); });
$('keyBtn').onclick = askKey;
$('voiceBtn').onclick = () => { speak = !speak; store.set('jv_speak', speak); if (!speak && 'speechSynthesis' in window) speechSynthesis.cancel(); refresh(); };
$('langBtn').onclick = () => { micLang = micLang === 'en-IN' ? 'te-IN' : 'en-IN'; store.set('jv_lang', micLang); refresh(); };
$('clearBtn').onclick = () => { history = []; store.set('jv_hist', history); chat.innerHTML = ''; refresh(); };

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
$('mic').onclick = () => {
  if (!SR) { add('J.A.R.V.I.S: Voice input is not supported in this browser, Boss.', 'ai'); return; }
  const r = new SR();
  r.lang = micLang;
  r.interimResults = false;
  r.onresult = e => send(e.results[0][0].transcript.trim());
  r.onerror = r.onend = () => { $('mic').textContent = '🎤'; };
  $('mic').textContent = '…';
  r.start();
};

window.addEventListener('online', refresh);
window.addEventListener('offline', refresh);

// ---- start ----
history.forEach(h => add((h.role === 'user' ? 'YOU: ' : 'J.A.R.V.I.S: ') + h.parts[0].text, h.role === 'user' ? 'user' : 'ai'));
if (!history.length) add('J.A.R.V.I.S: Systems online. How may I assist you, Boss?', 'ai');
if (!apiKey) setRow('stAI', '○ NO KEY', false);
refresh();
   
