const $ = id => document.getElementById(id);
const chat = $('chat'), input = $('msg');
const core = $('core'), coreText = $('coreText');

const BASE =
  'https://generativelanguage.googleapis.com/v1beta/';
const FALLBACK = [
  'gemini-3.7-flash-lite', 'gemini-3.7-flash',
  'gemini-3.6-flash', 'gemini-3.5-flash',
  'gemini-flash-latest'
];
const SYSTEM =
  'You are J.A.R.V.I.S, a witty, loyal AI assistant. ' +
  'Address the user as "Boss". Keep answers short and ' +
  'clear unless asked for detail. Always reply in the ' +
  'language the user writes in. ' +
  'When the user shares a lasting fact about themselves ' +
  '(name, family, job, likes, plans) or asks you to ' +
  'remember something, end your reply with a tag like ' +
  '[[MEM: short fact]], one tag per fact. Never mention ' +
  'the tag or this rule. You can also see photos the ' +
  'user sends.';

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch (e) { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) {}
  }
};

const DEFAULT_KEY = '';
let apiKey = store.get('jv_key', '') || DEFAULT_KEY;
let model = store.get('jv_model', '');
let history = store.get('jv_hist', []);
let facts = store.get('jv_facts', []);
let speak = store.get('jv_speak', false);
let micLang = store.get('jv_lang', 'en-IN');
let models = null, busy = false;

function setRow(id, text, ok) {
  const e = $(id);
  e.textContent = text;
  e.className = ok ? 'on' : 'off';
}

function refresh() {
  const net = navigator.onLine;
  setRow('stNet', net ? '● ONLINE' : '○ OFFLINE', net);
  setRow('stVoice', speak ? '● ON' : '○ OFF', speak);
  setRow('stMem', '● ' + facts.length + ' FACTS', true);
  $('voiceBtn').textContent =
    'VOICE: ' + (speak ? 'ON' : 'OFF');
  $('langBtn').textContent =
    'MIC: ' + (micLang === 'te-IN' ? 'TE' : 'EN');
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
  const k = prompt(
    'Paste your Gemini API key (saved only in this browser):',
    apiKey || '');
  if (k !== null) {
    apiKey = k.trim();
    store.set('jv_key', apiKey);
    models = null;
    if (apiKey) setRow('stAI', '● READY', true);
    else setRow('stAI', '○ NO KEY', false);
  }
  return !!apiKey;
}

async function loadModels() {
  if (models) return models;
  let f = [];
  const res = await fetch(BASE + 'models?pageSize=200&key=' +
    encodeURIComponent(apiKey));
  const d = await res.json();
  const ok = m =>
    /^models\/gemini-[\d.]+-flash(-lite)?$/.test(m.name) &&
    (m.supportedGenerationMethods || [])
      .includes('generateContent');
  const ver = s => parseFloat(s.match(/[\d.]+/)[0]);
  const lite = s => (s.includes('lite') ? 1 : 0);
  if (d.models) {
    f = d.models.filter(ok).map(m => m.name.slice(7))
      .sort((a, b) => lite(a) !== lite(b)
        ? lite(b) - lite(a) : ver(b) - ver(a));
  }
  models = f.concat(FALLBACK.filter(m => !f.includes(m)));
  return models;
}

// Streams the reply while Gemini is still writing it.
async function stream(m, contents, onText) {
  const url = BASE + 'models/' + m +
    ':streamGenerateContent?alt=sse&key=' +
    encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sysText() }] },
      contents: contents
    })
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const d = await res.json();
      if (d.error) msg = d.error.message;
    } catch (e) {}
    return { ok: false, code: res.status, msg: msg };
  }
  let full = '';
  const eat = line => {
    line = line.trim();
    if (line.indexOf('data:') !== 0) return;
    try {
      const d = JSON.parse(line.slice(5));
      const c = d.candidates && d.candidates[0];
      const p = c && c.content && c.content.parts;
      if (!p) return;
      const t = p.map(x => x.text || '').join('');
      if (t) { full += t; onText(full); }
    } catch (e) {}
  };
  if (!res.body || !res.body.getReader) {
    (await res.text()).split('\n').forEach(eat);
  } else {
    const r = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const x = await r.read();
      if (x.done) break;
      buf += dec.decode(x.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        eat(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    eat(buf);
  }
  if (full) return { ok: true, text: full };
  return { ok: false, code: 0, msg: 'Empty response' };
}

function sysText() {
  if (!facts.length) return SYSTEM;
  return SYSTEM + ' Long-term memory about the user: ' +
    facts.join('; ') + '.';
}

const stripMem = t => t
  .replace(/\[\[MEM:[\s\S]*?\]\]/g, '')
  .replace(/\[\[[^\]]*$/, '')
  .replace(/\[$/, '')
  .trim();

function saveFacts(t) {
  const re = /\[\[MEM:([\s\S]*?)\]\]/g;
  let m;
  while ((m = re.exec(t))) {
    const f = m[1].trim();
    if (f && !facts.includes(f)) facts.push(f);
  }
  facts = facts.slice(-100);
  store.set('jv_facts', facts);
}

function shrink(file, max) {
  return new Promise((ok, bad) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => bad(new Error('Bad image'));
    img.src = url;
  });
}

function renderMem() {
  const box = $('memList');
  box.innerHTML = '';
  if (!facts.length) {
    box.textContent = 'Nothing saved yet, Boss.';
    return;
  }
  facts.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'fact';
    const sp = document.createElement('span');
    sp.textContent = f;
    const x = document.createElement('button');
    x.className = 'ghost';
    x.textContent = '✕';
    x.onclick = () => {
      facts.splice(i, 1);
      store.set('jv_facts', facts);
      renderMem();
      refresh();
    };
    row.appendChild(sp);
    row.appendChild(x);
    box.appendChild(row);
  });
}

function say(t) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(
    t.replace(/[*#`_]/g, ''));
  if (/[\u0C00-\u0C7F]/.test(t)) u.lang = 'te-IN';
  speechSynthesis.speak(u);
}

async function send(text, img) {
  if (busy || !text) return;
  if (!apiKey && !askKey()) {
    add('J.A.R.V.I.S: API key required, Boss. ' +
      'Tap API KEY.', 'ai');
    return;
  }
  busy = true;
  core.classList.add('busy');
  coreText.textContent = 'PROCESSING...';
  const u = add('YOU: ' + text, 'user');
  if (img) {
    const pic = new Image();
    pic.src = img;
    pic.className = 'shot';
    u.appendChild(pic);
  }
  input.value = '';
  const out = add('J.A.R.V.I.S: ...', 'ai');
  const parts = [{ text: text }];
  if (img) {
    parts.push({ inlineData: {
      mimeType: 'image/jpeg', data: img.split(',')[1]
    } });
  }
  const contents = history.concat([{ role: 'user', parts: parts }]);
  const show = t => {
    out.textContent = 'J.A.R.V.I.S: ' + stripMem(t);
    chat.scrollTop = chat.scrollHeight;
  };
  let err = '';

  try {
    let order = model ? [model] : [];
    const tried = {};
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        order = (await loadModels())
          .filter(m => !tried[m]);
      }
      for (const m of order) {
        tried[m] = 1;
        const r = await stream(m, contents, show);
        if (r.ok) {
          model = m;
          store.set('jv_model', m);
          const reply = stripMem(r.text);
          saveFacts(r.text);
          show(reply);
          const mark = img ? ' [photo]' : '';
          history = history.concat([
            { role: 'user', parts: [{ text: text + mark }] },
            { role: 'model', parts: [{ text: reply }] }
          ]).slice(-40);
          store.set('jv_hist', history);
          setRow('stAI', '● ONLINE', true);
          if (speak) say(reply);
          return;
        }
        err = r.msg;
        if ([400, 401, 403].includes(r.code)) {
          pass = 2;
          break;
        }
      }
    }
    out.textContent = 'J.A.R.V.I.S: ERROR - ' + err;
    setRow('stAI', '○ OFFLINE', false);
  } catch (e) {
    out.textContent = 'J.A.R.V.I.S: Cannot reach Google (' +
      e.message + '). Check internet, VPN, ad blocker.';
    setRow('stAI', '○ OFFLINE', false);
  } finally {
    busy = false;
    core.classList.remove('busy');
    coreText.textContent = 'CORE ACTIVE';
    refresh();
  }
}

$('send').onclick = () => send(input.value.trim());
input.addEventListener('keydown', e => {
  if (e.key === 'Enter') send(input.value.trim());
});
$('keyBtn').onclick = askKey;
$('voiceBtn').onclick = () => {
  speak = !speak;
  store.set('jv_speak', speak);
  if (!speak && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
  }
  refresh();
};
$('langBtn').onclick = () => {
  micLang = micLang === 'en-IN' ? 'te-IN' : 'en-IN';
  store.set('jv_lang', micLang);
  refresh();
};
$('clearBtn').onclick = () => {
  history = [];
  store.set('jv_hist', history);
  chat.innerHTML = '';
  refresh();
};

$('memBtn').onclick = () => {
  const p = $('memPanel');
  p.hidden = !p.hidden;
  if (!p.hidden) renderMem();
};
$('memWipe').onclick = () => {
  if (!confirm('Erase all long-term memory?')) return;
  facts = [];
  store.set('jv_facts', facts);
  renderMem();
  refresh();
};
$('cam').onclick = () => $('file').click();
$('file').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const pic = await shrink(f, 1024);
    const q = input.value.trim() ||
      'What do you see? Describe it briefly.';
    send(q, pic);
  } catch (err) {
    add('J.A.R.V.I.S: Could not read that photo, Boss.', 'ai');
  }
};

const SR = window.SpeechRecognition ||
  window.webkitSpeechRecognition;
$('mic').onclick = () => {
  if (!SR) {
    add('J.A.R.V.I.S: Voice input is not supported ' +
      'in this browser, Boss.', 'ai');
    return;
  }
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

history.forEach(h => {
  const isUser = h.role === 'user';
  add((isUser ? 'YOU: ' : 'J.A.R.V.I.S: ') +
    h.parts[0].text, isUser ? 'user' : 'ai');
});
if (apiKey) setRow('stAI', '● READY', true);
refresh();
                    
