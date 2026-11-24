const NOOP = {
  hidden: true, value: '', textContent: '', innerHTML: '',
  placeholder: '', style: {}, parentElement: null,
  classList: { toggle() {}, add() {}, remove() {} },
  appendChild() {}, addEventListener() {}
};
const $ = id => document.getElementById(id) || Object.assign({}, NOOP);
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
  'You have a permanent long-term memory. Save facts ' +
  'generously: whenever the user mentions anything ' +
  'personal (name, age, family, place, job, studies, ' +
  'likes, dislikes, goals, plans, dates, habits) or ' +
  'asks you to remember something, add one tag per fact ' +
  'on the LAST line of your reply, written exactly like ' +
  '[[MEM: The name of the user is Ravi]]. Each fact must ' +
  'be a full sentence about the user. If the user asks ' +
  'you to forget something, add [[FORGET: that fact]]. ' +
  'Never mention the tags or these rules. You can also ' +
  'see photos the user sends.';

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
let chats = store.get('jv_chats', []);
let openId = store.get('jv_open', null);
let tab = 'facts';
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

let lastAsk = '';
const VERB = {
  'work as': 'works as', 'work at': 'works at',
  'study': 'studies', 'love': 'loves', 'like': 'likes',
  'hate': 'hates', 'prefer': 'prefers', 'enjoy': 'enjoys'
};
const STOP = ['what', 'that', 'this', 'with', 'have', 'your',
  'from', 'tell', 'about', 'please', 'remember', 'there',
  'where', 'when', 'which', 'would', 'could', 'should'];

function recall() {
  const others = chats.filter(c => c.id !== openId);
  if (!others.length) return '';
  let r = 'Past chat topics: ' +
    others.slice(0, 8).map(c => c.title).join(' | ') + '.';
  const words = lastAsk.toLowerCase()
    .split(/[^a-z0-9\u0C00-\u0C7F]+/)
    .filter(w => w.length > 3 && !STOP.includes(w));
  const hits = [];
  others.forEach(c => c.msgs.forEach(m => {
    const t = m.parts[0].text;
    const low = t.toLowerCase();
    if (hits.length < 3 && words.some(w => low.includes(w))) {
      hits.push((m.role === 'user' ? 'User: ' : 'You: ') +
        t.slice(0, 160));
    }
  }));
  if (hits.length) {
    r += ' Related old messages: ' + hits.join(' || ') + '.';
  }
  return r;
}

function sysText() {
  let r = SYSTEM + ' Today is ' +
    new Date().toLocaleString() + '.';
  if (facts.length) {
    r += ' Long-term memory about the user: ' +
      facts.join('; ') + '.';
  }
  const past = recall();
  if (past) r += ' ' + past;
  return r;
}

const stripMem = t => t
  .replace(/\[{1,2}\s*(MEM|FORGET)\s*:[\s\S]*?\]{1,2}/g, '')
  .replace(/\[{1,2}\s*(MEM|FORGET)\s*:[^\]]*$/, '')
  .replace(/\[\[[^\]]*$/, '')
  .replace(/\[$/, '')
  .trim();

function addFact(f) {
  f = f.trim().replace(/\s+/g, ' ');
  if (f.length < 3) return;
  const low = f.toLowerCase();
  if (facts.some(x => x.toLowerCase() === low)) return;
  facts.push(f);
}

function dropFact(term) {
  const low = term.trim().toLowerCase();
  if (low.length < 3) return;
  facts = facts.filter(x => {
    const y = x.toLowerCase();
    return !(y.includes(low) || low.includes(y));
  });
}

function keepFacts() {
  facts = facts.slice(-200);
  store.set('jv_facts', facts);
  refresh();
  if (!$('memPanel').hidden && tab === 'facts') renderMem();
}

function saveFacts(t) {
  const re = /\[{1,2}\s*(MEM|FORGET)\s*:([\s\S]*?)\]{1,2}/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[1] === 'MEM') addFact(m[2]); else dropFact(m[2]);
  }
  keepFacts();
}

function localLearn(t) {
  const s = t.trim();
  if (!s || s.slice(-1) === '?') return;
  let m;
  const TE = /గుర్తుంచు\S*|గుర్తు\s?(?:ఉంచు|పెట్టు)\S*/g;
  if ((m = s.match(/^(?:please\s+)?remember(?:\s+that)?[\s:,-]+(.+)/i))) {
    addFact('The user asked to remember: ' + m[1]);
  }
  if (TE.test(s)) {
    addFact('The user asked to remember: ' + s.replace(TE, ''));
  }
  if ((m = s.match(/^forget(?:\s+that|\s+about)?\s+(.+)/i))) {
    dropFact(m[1]);
  }
  if ((m = s.match(/నా పేరు\s+([^\s.,!?]+)/))) {
    addFact('The name of the user is ' + m[1]);
  }
  if ((m = s.match(/\bmy name is ([^.,!?\n]{2,40})/i))) {
    addFact('The name of the user is ' + m[1]);
  }
  if ((m = s.match(/\bi am (\d{1,3}) years? old/i))) {
    addFact('The user is ' + m[1] + ' years old');
  }
  if ((m = s.match(/\bi (?:live|stay) in ([^.,!?\n]{2,40})/i))) {
    addFact('The user lives in ' + m[1]);
  }
  const my = '(favou?rite [a-z ]{2,25}|birthday|mother|father|' +
    'brother|sister|wife|husband|friend|job|goal|dream|plan|' +
    'phone number|email|hobby)';
  if ((m = s.match(new RegExp('\\bmy ' + my +
      ' is ([^.,!?\\n]{1,50})', 'i')))) {
    addFact('The ' + m[1] + ' of the user is ' + m[2]);
  }
  if ((m = s.match(/\bi (work as|work at|study) ([^.,!?\n]{2,40})/i))) {
    addFact('The user ' + VERB[m[1].toLowerCase()] + ' ' + m[2]);
  }
  if ((m = s.match(/\bi (love|like|hate|prefer|enjoy) ([^.,!?\n]{2,40})/i))) {
    addFact('The user ' + VERB[m[1].toLowerCase()] + ' ' + m[2]);
  }
  keepFacts();
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

function tabLabels() {
  $('tabChats').textContent = 'CHATS (' + chats.length + ')';
}

function saveChat() {
  if (!history.length) return;
  if (!openId) {
    openId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  }
  const i = chats.findIndex(c => c.id === openId);
  let title = i >= 0 ? chats[i].title : '';
  if (!title) {
    const first = history.find(h => h.role === 'user');
    title = (first ? first.parts[0].text : 'Chat').slice(0, 50);
  }
  if (i >= 0) chats.splice(i, 1);
  chats.unshift({
    id: openId, title: title,
    time: Date.now(), msgs: history
  });
  chats = chats.slice(0, 60);
  store.set('jv_chats', chats);
  store.set('jv_open', openId);
  tabLabels();
}

function renderHistory() {
  chat.innerHTML = '';
  history.forEach(h => {
    const isUser = h.role === 'user';
    add((isUser ? 'YOU: ' : 'J.A.R.V.I.S: ') +
      h.parts[0].text, isUser ? 'user' : 'ai');
  });
}

function openChat(id) {
  if (busy) return;
  const c = chats.find(x => x.id === id);
  if (!c) return;
  saveChat();
  openId = c.id;
  history = c.msgs.slice();
  store.set('jv_hist', history);
  store.set('jv_open', openId);
  renderHistory();
  $('memPanel').hidden = true;
  refresh();
}

function deleteChat(id) {
  if (!confirm('Delete this chat?')) return;
  chats = chats.filter(c => c.id !== id);
  if (id === openId) {
    openId = null;
    store.set('jv_open', openId);
  }
  store.set('jv_chats', chats);
  tabLabels();
  renderChats();
}

function renderChats() {
  const box = $('chatList');
  const q = $('chatSearch').value.trim().toLowerCase();
  box.innerHTML = '';
  const list = chats.filter(c => !q ||
    c.title.toLowerCase().includes(q) ||
    c.msgs.some(m => m.parts[0].text.toLowerCase().includes(q)));
  if (!list.length) {
    box.textContent = q ? 'No matching chats.' : 'No chats yet, Boss.';
    return;
  }
  list.forEach(c => {
    const row = document.createElement('div');
    row.className = 'chatrow' + (c.id === openId ? ' cur' : '');
    const ct = document.createElement('div');
    ct.className = 'ct';
    const b = document.createElement('b');
    b.textContent = c.title;
    const sm = document.createElement('small');
    const d = new Date(c.time).toLocaleString([], {
      day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit'
    });
    sm.textContent = d + ' · ' + Math.floor(c.msgs.length / 2) +
      ' Q&A' + (c.id === openId ? ' · OPEN' : '');
    ct.appendChild(b);
    ct.appendChild(sm);
    ct.onclick = () => openChat(c.id);
    const x = document.createElement('button');
    x.className = 'ghost';
    x.textContent = '✕';
    x.onclick = () => deleteChat(c.id);
    row.appendChild(ct);
    row.appendChild(x);
    box.appendChild(row);
  });
}

function showTab(t) {
  tab = t;
  $('factsBox').hidden = t !== 'facts';
  $('chatsBox').hidden = t !== 'chats';
  $('tabFacts').classList.toggle('tab-on', t === 'facts');
  $('tabChats').classList.toggle('tab-on', t === 'chats');
  if (t === 'facts') renderMem(); else renderChats();
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
  lastAsk = text;
  localLearn(text);
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
          saveChat();
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
  saveChat();
  history = [];
  openId = null;
  store.set('jv_hist', history);
  store.set('jv_open', openId);
  chat.innerHTML = '';
  refresh();
};

$('memBtn').onclick = () => {
  const p = $('memPanel');
  p.hidden = !p.hidden;
  if (!p.hidden) showTab(tab);
};
$('tabFacts').onclick = () => showTab('facts');
$('tabChats').onclick = () => showTab('chats');
$('chatSearch').oninput = renderChats;
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
let micMode = SR ? 'sr' : 'rec';
let recording = null;

function micMsg(t) { add('J.A.R.V.I.S: ' + t, 'ai'); }
function micIcon(t) { $('mic').textContent = t; }

const BLOCKED = 'Microphone is blocked, Boss. Tap the lock icon ' +
  'next to the web address, open Permissions, allow ' +
  'Microphone, then reload the page.';

function startMic(lang) {
  const r = new SR();
  let got = false, failed = false;
  r.lang = lang;
  r.interimResults = false;
  r.onresult = e => {
    got = true;
    send(e.results[0][0].transcript.trim());
  };
  r.onerror = e => {
    failed = true;
    const c = e.error;
    if (c === 'language-not-supported' && lang !== 'en-IN') {
      micMsg('This language is not supported for voice here. ' +
        'Using English.');
      startMic('en-IN');
      return;
    }
    micIcon('🎤');
    if (c === 'no-speech') {
      micMsg('I did not hear anything, Boss. Tap the mic ' +
        'and speak.');
    } else if (c !== 'aborted') {
      micMode = 'rec';
      recordVoice();
    }
  };
  r.onend = () => {
    if (failed) return;
    micIcon('🎤');
    if (!got) {
      micMode = 'rec';
      recordVoice();
    }
  };
  micIcon('…');
  try {
    r.start();
  } catch (err) {
    micIcon('🎤');
    micMode = 'rec';
    recordVoice();
  }
}

function toWav(f32, rate) {
  const n = f32.length;
  const v = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, t) => {
    for (let i = 0; i < t.length; i++) {
      v.setUint8(o + i, t.charCodeAt(i));
    }
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 32768 : x * 32767, true);
  }
  return new Uint8Array(v.buffer);
}

function downsample(f32, from, to) {
  if (to >= from) return f32;
  const k = from / to;
  const out = new Float32Array(Math.floor(f32.length / k));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * k), b = Math.floor((i + 1) * k);
    let sum = 0;
    for (let j = a; j < b; j++) sum += f32[j];
    out[i] = sum / (b - a)
