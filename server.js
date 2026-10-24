'use strict';
/**
 * ILM CHO‘QQISI — server (bog'lanishsiz: faqat Node.js 22.13+ ichki modullari)
 *  - Ma'lumotlar bazasi: SQLite (node:sqlite) -> data/battlemind.db
 *  - Parollar: scrypt bilan hash
 *  - Telefon raqamlari: HMAC (qidirish uchun) + AES-256-GCM (shifrlangan saqlash)
 *  - Owner huquqi: faqat serverda (users.role), .env orqali belgilanadi
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch { console.error('\n[XATO] Node.js versiyangiz eski (' + process.version + '). Node.js 22.13 yoki yangisini o‘rnating: https://nodejs.org\n'); process.exit(1); }
const scrypt = promisify(crypto.scrypt);

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env');
const ENV_FOUND = fs.existsSync(ENV_FILE);
loadEnv(ENV_FILE);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PROD = process.env.NODE_ENV === 'production';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OWNER_PANEL_FILE = path.join(ROOT, 'private', 'owner-panel.js');
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_GRANT = 1_000_000;
const MAX_COINS = 1_000_000_000_000;

fs.mkdirSync(DATA_DIR, { recursive: true });

function die(msg) { console.error('\n[XATO] ' + msg + '\n'); process.exit(1); }
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

/* ---------- Kalitlar va shifrlash ---------- */
function loadMasterKey() {
  if (process.env.DATA_KEY) {
    if (!/^[0-9a-f]{64}$/i.test(process.env.DATA_KEY)) die('DATA_KEY 64 ta hex belgidan iborat bo‘lishi kerak.');
    return Buffer.from(process.env.DATA_KEY, 'hex');
  }
  const f = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 });
  return k;
}
const MASTER = loadMasterKey();
const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', MASTER, Buffer.alloc(0), info, 32));
const K_HMAC = derive('battlemind-phone-hmac');
const K_ENC = derive('battlemind-phone-enc');

function normPhone(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 9) d = '998' + d;
  return d.length >= 10 && d.length <= 15 ? d : '';
}
const phoneHash = (n) => crypto.createHmac('sha256', K_HMAC).update(n).digest('hex');
function encPhone(n) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', K_ENC, iv);
  const ct = Buffer.concat([c.update(n, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decPhone(s) {
  try {
    const b = Buffer.from(s, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', K_ENC, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
}
const maskPhone = (n) => n ? '+' + n.slice(0, 3) + ' ' + '*'.repeat(Math.max(0, n.length - 5)) + n.slice(-2) : '';

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}
async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = await scrypt(pw, Buffer.from(s, 'base64'), want.length);
  return crypto.timingSafeEqual(got, want);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- Ma'lumotlar bazasi ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'battlemind.db'));
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first TEXT NOT NULL, last TEXT NOT NULL, username TEXT, school TEXT NOT NULL,
  grade TEXT NOT NULL, gender TEXT NOT NULL CHECK(gender IN('boy','girl')),
  phone_hash TEXT NOT NULL UNIQUE, phone_enc TEXT NOT NULL, pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK(role IN('student','owner')),
  coins INTEGER NOT NULL DEFAULT 0 CHECK(coins>=0),
  wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0,
  owned TEXT NOT NULL DEFAULT '[]', equipped TEXT NOT NULL DEFAULT '[]',
  last_game_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coin_grants(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK(amount>0),
  balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grants_user ON coin_grants(user_id);
CREATE TABLE IF NOT EXISTS chat_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 240),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_pair ON chat_messages(sender_id, recipient_id, id);
CREATE TABLE IF NOT EXISTS chat_blocks(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY(user_id, blocked_id), CHECK(user_id<>blocked_id)
);
`);

// Add nickname support to existing databases without deleting user data.
try { db.exec('ALTER TABLE users ADD COLUMN username TEXT'); } catch (e) { if (!String(e.message).includes('duplicate column')) throw e; }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE) WHERE username IS NOT NULL'); } catch {}
for (const oldUser of db.prepare("SELECT id, first, last FROM users WHERE username IS NULL OR username = ''").all()) {
  const base = (String(oldUser.first || 'user') + String(oldUser.last || '')).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 18) || 'user';
  let candidate = base + oldUser.id;
  while (db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE AND id<>?').get(candidate, oldUser.id)) candidate = base.slice(0, 15) + oldUser.id + 'x';
  db.prepare('UPDATE users SET username=? WHERE id=?').run(candidate, oldUser.id);
}

/* ---------- Do'kon katalogi (narxlar faqat serverda ishonchli) ---------- */
const ITEMS = [
  { id: 'hoodie', name: 'Anime hudi', cat: 'clothes', icon: '🧥', price: 1200, desc: 'To‘liq yopiq neon hudi', gender: 'all' },
  { id: 'jacket', name: 'Street kurtka', cat: 'clothes', icon: '🧥', price: 1800, desc: 'Kurtka va uzun shim', gender: 'all' },
  { id: 'pinkhoodie', name: 'Pushti hudi', cat: 'clothes', icon: '🩷', price: 1500, desc: 'Yopiq va qulay hudi', gender: 'girl' },
  { id: 'cardigan', name: 'Anime kardigan', cat: 'clothes', icon: '🧶', price: 2200, desc: 'Kardigan va odobli yubka', gender: 'girl' },
  { id: 'sport', name: 'Sport kiyimi', cat: 'clothes', icon: '👟', price: 2400, desc: 'Sport kurtkasi va shim', gender: 'all' },
  { id: 'earrings', name: 'Yulduz sirg‘alar', cat: 'jewelry', icon: '✨', price: 950, desc: 'Yulduz shaklidagi sirg‘alar', gender: 'girl' },
  { id: 'necklace', name: 'Marjon', cat: 'jewelry', icon: '📿', price: 1100, desc: 'Nozik bezakli marjon', gender: 'girl' },
  { id: 'bracelet', name: 'Bilaguzuk', cat: 'jewelry', icon: '💫', price: 850, desc: 'Rangli bilaguzuk', gender: 'all' },
  { id: 'hairclip', name: 'Soch qisqichi', cat: 'jewelry', icon: '🎀', price: 900, desc: 'Pushti soch bezagi', gender: 'girl' },
  { id: 'bluehair', name: 'Ko‘k anime soch', cat: 'hair', icon: '💙', price: 1700, desc: 'Yangi anime soch turmagi', gender: 'all' },
  { id: 'pinkhair', name: 'Pushti anime soch', cat: 'hair', icon: '💗', price: 1800, desc: 'Yangi anime soch turmagi', gender: 'girl' },
  { id: 'night', name: 'Tungi shahar foni', cat: 'background', icon: '🌃', price: 3500, desc: 'Neon shahar manzarasi', gender: 'all' },
  { id: 'sakura', name: 'Sakura foni', cat: 'background', icon: '🌸', price: 3800, desc: 'Gullar va pushti osmon', gender: 'girl' },
  { id: 'galaxy', name: 'Galaktika foni', cat: 'background', icon: '🌌', price: 4200, desc: 'Yulduzli kosmik fon', gender: 'all' },
  { id: 'blueframe', name: 'Neon ko‘k ramka', cat: 'frame', icon: '🔷', price: 1400, desc: 'Profil avatar ramkasi', gender: 'all' },
  { id: 'pinkframe', name: 'Neon pushti ramka', cat: 'frame', icon: '💠', price: 1500, desc: 'Profil avatar ramkasi', gender: 'girl' },
  { id: 'starterhouse', name: 'Shinam uy', cat: 'house', icon: '🏡', price: 6000, desc: 'Yorug‘ derazali boshlang‘ich uy', gender: 'all' },
  { id: 'modernhouse', name: 'Zamonaviy villa', cat: 'house', icon: '🏘️', price: 18000, desc: 'Katta hovli va zamonaviy uy', gender: 'all' },
  { id: 'treehouse', name: 'Daraxt uyi', cat: 'house', icon: '🌳', price: 9500, desc: 'Tabiat bag‘ridagi noodatiy uy', gender: 'all' },
  { id: 'citycar', name: 'Sport avtomobil', cat: 'car', icon: '🏎️', price: 12000, desc: 'Garaj uchun sport mashinasi', gender: 'all' },
  { id: 'suvcar', name: 'Yo‘ltanlamas', cat: 'car', icon: '🚙', price: 15000, desc: 'Kuchli yo‘ltanlamas avtomobil', gender: 'all' },
  { id: 'electriccar', name: 'Elektromobil', cat: 'car', icon: '🚘', price: 22000, desc: 'Zamonaviy elektr avtomobil', gender: 'all' },
  { id: 'dragonarmor', name: 'Dragon Premium zirhi', cat: 'clothes', icon: '🐉', price: 3200, desc: 'Qoramtir ajdar uslubidagi to‘liq yopiq zirh', gender: 'all' },
  { id: 'cyberarmor', name: 'Cyber Neon kostyum', cat: 'clothes', icon: '🥷', price: 2800, desc: 'Neon chiziqli futuristik kostyum', gender: 'all' },
  { id: 'royalcoat', name: 'Royal uzun palto', cat: 'clothes', icon: '🧥', price: 2500, desc: 'Hashamatli uzun palto va shim', gender: 'all' },
  { id: 'goldcrown', name: 'Oltin toj', cat: 'jewelry', icon: '👑', price: 1900, desc: 'Royal avatar uchun toj', gender: 'all' },
  { id: 'neonwings', name: 'Neon qanotlar', cat: 'jewelry', icon: '🪽', price: 3500, desc: 'Yorqin fantaziya qanotlari', gender: 'all' },
  { id: 'icehair', name: 'Muz-ko‘k soch', cat: 'hair', icon: '🩵', price: 1600, desc: 'Muz rangli anime soch uslubi', gender: 'all' },
  { id: 'goldhouse', name: 'Royal oltin villa', cat: 'house', icon: '🏰', price: 45000, desc: 'Keng hovli va saroy uslubidagi uy', gender: 'all' },
  { id: 'glassvilla', name: 'Shisha mega-villa', cat: 'house', icon: '🏙️', price: 38000, desc: 'Zamonaviy oynavand hashamatli villa', gender: 'all' },
  { id: 'penthouse', name: 'Skyline penthaus', cat: 'house', icon: '🌆', price: 29000, desc: 'Shahar manzarali baland qavat uyi', gender: 'all' },
  { id: 'hypercar', name: 'Hypercar X', cat: 'car', icon: '🏎️', price: 35000, desc: 'Kuchli futuristik superkar', gender: 'all' },
  { id: 'luxurycar', name: 'Luxury GT', cat: 'car', icon: '🚘', price: 27000, desc: 'Hashamatli GT avtomobil', gender: 'all' },
  { id: 'offroadbeast', name: 'Off-road Beast', cat: 'car', icon: '🚙', price: 24000, desc: 'Tog‘ va qiyin yo‘llar uchun SUV', gender: 'all' },
  { id: 'vortexgt', name: 'Apex Vortex GT', cat: 'car', icon: '🏎️', price: 85000, desc: 'Premium futuristik superkar', gender: 'all' },
  { id: 'obsidians', name: 'Obsidian S-Class', cat: 'car', icon: '🚘', price: 62000, desc: 'Hashamatli qora sedan', gender: 'all' },
  { id: 'titanxsuv', name: 'Titan X SUV', cat: 'car', icon: '🚙', price: 48000, desc: 'Katta premium yo‘ltanlamas', gender: 'all' },
  { id: 'neonraptor', name: 'Neon Raptor mototsikl', cat: 'car', icon: '🏍️', price: 19500, desc: 'Sport mototsikl', gender: 'all' },
  { id: 'royalskyvilla', name: 'Royal Sky Villa', cat: 'house', icon: '🏰', price: 250000, desc: 'Hashamatli qirollik villasi', gender: 'all' },
  { id: 'glasshouse', name: 'Modern Glass House', cat: 'house', icon: '🏡', price: 145000, desc: 'Panoramali oynavand zamonaviy uy', gender: 'all' },
  { id: 'penthouse88', name: 'Penthouse 88', cat: 'house', icon: '🌆', price: 195000, desc: 'Shahar manzarali penthaus', gender: 'all' },
  { id: 'cyberarmorx', name: 'Cyber Armor X', cat: 'clothes', icon: '🦾', price: 12000, desc: 'Futuristik, to‘liq yopiq zirh', gender: 'all' },
  { id: 'royalcoatx', name: 'Royal Shadow Coat', cat: 'clothes', icon: '🥷', price: 9800, desc: 'Uzun premium palto va shim', gender: 'all' },
  { id: 'neonsuitx', name: 'Neon Strike Suit', cat: 'clothes', icon: '⚡', price: 7600, desc: 'Neon chiziqli jangchi kiyimi', gender: 'all' },
  { id: 'goldcrownx', name: 'Royal Crown', cat: 'jewelry', icon: '👑', price: 8500, desc: 'Oltin qirollik toji', gender: 'all' },
  { id: 'neonwingsx', name: 'Neon Wings', cat: 'jewelry', icon: '🪽', price: 15000, desc: 'Yorqin premium qanotlar', gender: 'all' },
  { id: 'shadowvisorx', name: 'Shadow Visor', cat: 'jewelry', icon: '🕶️', price: 4200, desc: 'Futuristik ko‘zoynak', gender: 'all' },
  { id: 'icehairx', name: 'Ice Phantom Hair', cat: 'hair', icon: '🩵', price: 5200, desc: 'Muz-ko‘k maxsus soch uslubi', gender: 'all' },
  { id: 'galaxybgx', name: 'Galaxy Profile Aura', cat: 'background', icon: '🌌', price: 6800, desc: 'Galaktik profil effekti', gender: 'all' }
];
const ITEM_MAP = new Map(ITEMS.map((i) => [i.id, i]));

/* ---------- Yordamchilar ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const nowIso = () => new Date().toISOString();

function send(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function readJson(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'So‘rov juda katta.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw 0;
        resolve(v);
      } catch { reject(new HttpError(400, 'So‘rov formati noto‘g‘ri.')); }
    });
    req.on('error', () => reject(new HttpError(400, 'So‘rov o‘qilmadi.')));
  });
}
function clientIp(req) {
  if (TRUST_PROXY) { const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (f) return f; }
  return req.socket.remoteAddress || 'unknown';
}
const buckets = new Map();
function blocked(key, max) { const b = buckets.get(key); return !!b && b.reset > Date.now() && b.n >= max; }
function hit(key, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
}
setInterval(() => { const n = Date.now(); for (const [k, b] of buckets) if (b.reset < n) buckets.delete(k); db.prepare('DELETE FROM sessions WHERE expires_at<?').run(n); }, 10 * 60 * 1000).unref();

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function cookieHeader(token, maxAge) {
  return `bm_sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${PROD ? '; Secure' : ''}`;
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), userId, Date.now() + SESSION_MS);
  return token;
}
function sessionUser(req) {
  const t = parseCookies(req).bm_sid;
  if (!t) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(sha(t), Date.now()) || null;
}
function requireUser(req) { const u = sessionUser(req); if (!u) throw new HttpError(401, 'Avval tizimga kiring.'); return u; }
function requireOwner(req) {
  const u = requireUser(req);
  if (u.role !== 'owner') throw new HttpError(403, 'Bu amal faqat Owner uchun.');
  return u;
}
function publicMe(u) {
  const owner = u.role === 'owner';
  return {
    id: u.id, first: u.first, last: u.last, school: u.school, grade: u.grade, gender: u.gender,
    phone: '+' + decPhone(u.phone_enc), role: u.role, infinite: owner, coins: owner ? 0 : u.coins,
    wins: u.wins, losses: u.losses, matches: u.matches, correct: u.correct, xp: u.xp,
    owned: JSON.parse(u.owned), equipped: JSON.parse(u.equipped)
  };
}
const getUserById = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const getUserByPhone = (n) => db.prepare('SELECT * FROM users WHERE phone_hash=?').get(phoneHash(n));
function inTx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
let DUMMY_HASH = '';

/* ---------- Haqiqiy online duel: serverdagi navbat va holat ---------- */
const onlineQueue = [];
const onlineMatches = new Map();
const onlineByUser = new Map();
function onlinePublic(match, userId) {
  const meIndex = match.players.findIndex(x => x.id === userId);
  const me = match.players[meIndex];
  const foe = match.players[1 - meIndex] || null;
  return {
    id: match.id, status: match.status, subject: match.subject, grade: match.grade,
    round: match.round, total: 15, myIndex: meIndex,
    me: { first: me.first, last: me.last }, opponent: foe ? { first: foe.first, last: foe.last } : null,
    myHP: match.hp[meIndex], opponentHP: foe ? match.hp[1 - meIndex] : 15,
    answered: !!match.answers[userId], opponentAnswered: !!(foe && match.answers[foe.id]),
    lastRound: match.lastRound || null,
    outcome: match.outcomes ? match.outcomes[meIndex] : null
  };
}
function removeFromQueue(userId) {
  for (let i = onlineQueue.length - 1; i >= 0; i--) if (onlineQueue[i].userId === userId) onlineQueue.splice(i, 1);
}
function onlineJoin(u, subject) {
  const allowed = ['Matematika','Ona tili','Ingliz tili','Geografiya','IT','Tarix','Biologiya','Fizika','Kimyo','Adabiyot','Jismoniy tarbiya','Musiqa','Tasviriy san’at'];
  if (!allowed.includes(subject)) throw new HttpError(400, 'Fan noto‘g‘ri tanlangan.');
  const activeId = onlineByUser.get(u.id);
  const active = activeId && onlineMatches.get(activeId);
  if (active && ['waiting','playing'].includes(active.status)) return active;
  removeFromQueue(u.id);
  const grade = String(u.grade);
  const now = Date.now();
  for (let i = onlineQueue.length - 1; i >= 0; i--) {
    if (now - onlineQueue[i].at > 120000) onlineQueue.splice(i, 1);
  }
  const ix = onlineQueue.findIndex(x => x.userId !== u.id && x.grade === grade && x.subject === subject);
  if (ix < 0) {
    onlineQueue.push({ userId: u.id, first: u.first, last: u.last, grade, subject, at: now });
    const id = crypto.randomUUID();
    const match = { id, status:'waiting', subject, grade, round:0, players:[{id:u.id,first:u.first,last:u.last}], hp:[15,15], answers:{}, createdAt:now };
    onlineMatches.set(id, match); onlineByUser.set(u.id,id); return match;
  }
  const queued = onlineQueue.splice(ix,1)[0];
  const waitingId = onlineByUser.get(queued.userId);
  const match = waitingId && onlineMatches.get(waitingId);
  if (!match || match.status !== 'waiting') return onlineJoin(u, subject);
  match.players.push({id:u.id,first:u.first,last:u.last}); match.status='playing';
  match.hp=[15,15]; match.answers={}; match.round=0; match.lastRound=null;
  onlineByUser.set(u.id,match.id); onlineByUser.set(queued.userId,match.id);
  return match;
}

/* ---------- API ---------- */
async function handleApi(req, res, url, p) {
  const m = req.method;
  if (m !== 'GET' && m !== 'POST') throw new HttpError(405, 'Usul qo‘llab-quvvatlanmaydi.');
  if (m === 'POST') {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Faqat JSON qabul qilinadi.');
    const origin = req.headers.origin;
    if (origin) { let h = ''; try { h = new URL(origin).host; } catch {} if (h !== req.headers.host) throw new HttpError(403, 'Taqiqlangan so‘rov manbasi.'); }
  }
  const body = m === 'POST' ? await readJson(req) : {};
  const route = m + ' ' + p;

  switch (route) {
    case 'GET /api/chat/users': {
      const me = requireUser(req);
      const q = clean(url.searchParams.get('q') || '', 80);
      if (q.length < 1) return send(res, 200, { users: [] });
      const phone = normPhone(q);
      let rows;
      if (phone) {
        rows = db.prepare(`SELECT id,first,last,school,grade FROM users WHERE phone_hash=? AND id<>? AND role='student' LIMIT 10`).all(phoneHash(phone), me.id);
      } else {
        const needle = q.toLocaleLowerCase().replace(/\s+/g, '');
        const term = `%${needle}%`;
        const prefix = `${needle}%`;
        // Nikning istalgan qismi, ism/familiya va ularning bo‘shliqsiz ko‘rinishi bo‘yicha qidirish.
        rows = db.prepare(`SELECT id,first,last,username,school,grade,xp FROM users
          WHERE id<>? AND role='student' AND (
            lower(replace(coalesce(username,''),' ','')) LIKE ? OR
            lower(replace(first,' ','')) LIKE ? OR lower(replace(last,' ','')) LIKE ? OR
            lower(replace(first||last,' ','')) LIKE ? OR lower(replace(last||first,' ','')) LIKE ? OR
            lower(replace(first||'.'||last,' ','')) LIKE ?)
          ORDER BY CASE WHEN lower(replace(coalesce(username,''),' ','')) LIKE ? THEN 0
            WHEN lower(replace(first,' ','')) LIKE ? THEN 1
            WHEN lower(replace(first||last,' ','')) LIKE ? THEN 2 ELSE 3 END, first LIMIT 30`)
          .all(me.id, term, term, term, term, term, term, prefix, prefix, prefix);
      }
      return send(res, 200, { users: rows.map(x => ({ id:x.id, username:x.username || '', name:x.first+' '+x.last, school:x.school, grade:x.grade, rank:(x.xp||0)>=700?'💎 Olmos':(x.xp||0)>=400?'🥇 Oltin':(x.xp||0)>=200?'🥈 Kumush':'🥉 Bronza' })) });
    }
    case 'GET /api/chat/conversations': {
      const me = requireUser(req);
      const rows = db.prepare(`SELECT m.id,m.sender_id,m.recipient_id,m.body,m.created_at,
        CASE WHEN m.sender_id=? THEN m.recipient_id ELSE m.sender_id END AS other_id
        FROM chat_messages m
        WHERE m.sender_id=? OR m.recipient_id=?
        ORDER BY m.id DESC LIMIT 500`).all(me.id,me.id,me.id);
      const seen = new Set(), conversations = [];
      for (const m of rows) {
        if (seen.has(m.other_id)) continue;
        seen.add(m.other_id);
        const u = db.prepare("SELECT id,first,last,school,grade,xp FROM users WHERE id=? AND role='student'").get(m.other_id);
        if (!u) continue;
        const rank = u.xp >= 700 ? '💎 Olmos' : u.xp >= 400 ? '🥇 Oltin' : u.xp >= 200 ? '🥈 Kumush' : '🥉 Bronza';
        conversations.push({id:u.id,name:u.first+' '+u.last,school:u.school,grade:u.grade,rank,lastMessage:m.body,createdAt:m.created_at,from:m.sender_id});
      }
      return send(res, 200, { conversations });
    }
    case 'GET /api/chat/messages': {
      const me = requireUser(req);
      const otherId = Number(url.searchParams.get('with'));
      if (!Number.isSafeInteger(otherId) || otherId < 1 || otherId === me.id) throw new HttpError(400, 'Chat foydalanuvchisi noto‘g‘ri.');
      const other = getUserById(otherId);
      if (!other || other.role !== 'student') throw new HttpError(404, 'O‘quvchi topilmadi.');
      if (db.prepare('SELECT 1 FROM chat_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)').get(me.id,otherId,otherId,me.id)) throw new HttpError(403, 'Bu chat bloklangan.');
      const rows = db.prepare(`SELECT id,sender_id,recipient_id,body,created_at FROM chat_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY id DESC LIMIT 100`).all(me.id,otherId,otherId,me.id).reverse();
      return send(res, 200, { messages: rows.map(x=>({id:x.id,from:x.sender_id,to:x.recipient_id,text:x.body,createdAt:x.created_at})) });
    }
    case 'POST /api/chat/messages': {
      const me = requireUser(req);
      if (me.role !== 'student') throw new HttpError(403, 'Chat faqat o‘quvchilar uchun.');
      const otherId = Number(body.to);
      const message = clean(body.text, 240);
      if (!Number.isSafeInteger(otherId) || otherId < 1 || otherId === me.id) throw new HttpError(400, 'Qabul qiluvchi noto‘g‘ri.');
      if (!message) throw new HttpError(400, 'Xabar bo‘sh bo‘lmasin.');
      const other = getUserById(otherId);
      if (!other || other.role !== 'student') throw new HttpError(404, 'O‘quvchi topilmadi.');
      if (db.prepare('SELECT 1 FROM chat_blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)').get(me.id,otherId,otherId,me.id)) throw new HttpError(403, 'Bu chat bloklangan.');
      const badWords = ['ahmoq','haromi','iflos','suka','blyat','fuck','shit','idiot','tentak','lanati','jalab'];
      const normalized = message.toLowerCase().replace(/[!.,?*_]/g,'');
      if (badWords.some(w=>normalized.includes(w))) throw new HttpError(400, 'Xabarda nomaqbul so‘z bor.');
      const createdAt = nowIso();
      const id = Number(db.prepare('INSERT INTO chat_messages(sender_id,recipient_id,body,created_at) VALUES(?,?,?,?)').run(me.id,otherId,message,createdAt).lastInsertRowid);
      return send(res, 201, { message:{id,from:me.id,to:otherId,text:message,createdAt} });
    }
    case 'POST /api/chat/block': {
      const me = requireUser(req); const otherId = Number(body.userId);
      if (!Number.isSafeInteger(otherId) || otherId < 1 || otherId === me.id || !getUserById(otherId)) throw new HttpError(400, 'Foydalanuvchi noto‘g‘ri.');
      db.prepare('INSERT OR IGNORE INTO chat_blocks(user_id,blocked_id,created_at) VALUES(?,?,?)').run(me.id,otherId,nowIso());
      return send(res, 200, {ok:true});
    }
    case 'GET /api/items': return send(res, 200, { items: ITEMS });

    case 'GET /api/me': { const u = sessionUser(req); return send(res, 200, { user: u ? publicMe(u) : null }); }

    case 'POST /api/register': {
      const ip = clientIp(req);
      if (blocked('reg:' + ip, 10)) throw new HttpError(429, 'Juda ko‘p urinish. Keyinroq qayta urinib ko‘ring.');
      const first = clean(body.first, 40), last = clean(body.last, 40), requestedUsername = clean(body.username || '', 24).toLowerCase().replace(/[^a-z0-9_.-]/g, ''), school = clean(body.school, 100);
      let username = requestedUsername || (first + '.' + last).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 18) + String(Date.now()).slice(-4);
      const grade = String(body.grade ?? ''), gender = String(body.gender ?? '');
      const phone = normPhone(body.phone), password = String(body.password ?? '');
      if (!first || !last) throw new HttpError(400, 'Ism va familiyani kiriting.');
      if (requestedUsername && requestedUsername.length < 3) throw new HttpError(400, 'Nik kamida 3 ta belgi bo‘lsin.');
      if (db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username)) {
        if (requestedUsername) throw new HttpError(409, 'Bu nik band. Boshqa nik tanlang.');
        username = username.slice(0, 18) + Math.floor(Math.random() * 100000);
      }
      if (!school) throw new HttpError(400, 'Maktab nomini kiriting.');
      if (!['5', '6', '7', '8', '9', '10', '11'].includes(grade)) throw new HttpError(400, 'Sinf noto‘g‘ri.');
      if (!['boy', 'girl'].includes(gender)) throw new HttpError(400, 'Avatar turi noto‘g‘ri.');
      if (!phone) throw new HttpError(400, 'Telefon raqamini to‘g‘ri kiriting.');
      if (password.length < 6 || password.length > 100) throw new HttpError(400, 'Parol kamida 6 belgidan iborat bo‘lsin.');
      hit('reg:' + ip, 3600_000);
      if (getUserByPhone(phone)) throw new HttpError(409, 'Bu telefon raqami allaqachon ro‘yxatdan o‘tgan.');
      const pass = await hashPassword(password);
      let id;
      try {
        // Rol har doim 'student': foydalanuvchi o‘ziga Owner huquqini bera olmaydi.
        id = db.prepare(`INSERT INTO users(first,last,username,school,grade,gender,phone_hash,phone_enc,pass,role,created_at)
                         VALUES(?,?,?,?,?,?,?,?,?, 'student', ?)`).run(first, last, username, school, grade, gender, phoneHash(phone), encPhone(phone), pass, nowIso()).lastInsertRowid;
      } catch { throw new HttpError(409, 'Bu telefon raqami allaqachon ro‘yxatdan o‘tgan.'); }
      const token = createSession(Number(id));
      return send(res, 201, { user: publicMe(getUserById(id)) }, { 'Set-Cookie': cookieHeader(token, SESSION_MS / 1000) });
    }

    case 'POST /api/login': {
      const phone = normPhone(body.phone), password = String(body.password ?? '').slice(0, 200);
      const key = 'login:' + clientIp(req) + ':' + (phone || 'x');
      if (blocked(key, 8)) throw new HttpError(429, 'Juda ko‘p noto‘g‘ri urinish. 10 daqiqadan so‘ng qayta urinib ko‘ring.');
      const u = phone ? getUserByPhone(phone) : null;
      const ok = await verifyPassword(password, u ? u.pass : DUMMY_HASH);
      if (!u || !ok) { hit(key, 10 * 60_000); throw new HttpError(401, 'Telefon raqami yoki parol noto‘g‘ri.'); }
      buckets.delete(key);
      const token = createSession(u.id);
      return send(res, 200, { user: publicMe(u) }, { 'Set-Cookie': cookieHeader(token, SESSION_MS / 1000) });
    }

    case 'POST /api/logout': {
      const t = parseCookies(req).bm_sid;
      if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(t));
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
    }

    case 'POST /api/online/join': {
      const u = requireUser(req);
      if (u.role === 'owner') throw new HttpError(403, 'Online duel o‘quvchilar uchun.');
      const subject = clean(body.subject, 40);
      const match = onlineJoin(u, subject);
      return send(res, 200, { match: onlinePublic(match, u.id), waitingCount: onlineQueue.length });
    }
    case 'GET /api/online/status': {
      const u = requireUser(req);
      const id = onlineByUser.get(u.id);
      const match = id && onlineMatches.get(id);
      if (!match) return send(res, 200, { match: null, waitingCount: onlineQueue.length });
      if (match.status === 'waiting' && Date.now() - match.createdAt > 120000) {
        match.status = 'cancelled'; onlineByUser.delete(u.id);
      }
      return send(res, 200, { match: onlinePublic(match, u.id), waitingCount: onlineQueue.length });
    }
    case 'POST /api/online/answer': {
      const u = requireUser(req);
      const id = onlineByUser.get(u.id);
      const match = id && onlineMatches.get(id);
      if (!match || match.status !== 'playing') throw new HttpError(409, 'Faol online duel topilmadi.');
      const round = Number(body.round), correct = body.correct === true;
      if (!Number.isInteger(round) || round !== match.round || match.answers[u.id]) throw new HttpError(409, 'Bu savolga javob yuborilgan yoki savol yangilangan.');
      match.answers[u.id] = { correct, at: Date.now() };
      if (match.players.every(player => match.answers[player.id])) {
        const before = [...match.hp];
        match.players.forEach((player, i) => {
          const answer = match.answers[player.id];
          if (answer.correct) match.hp[1-i] = Math.max(0, match.hp[1-i]-1);
        });
        match.lastRound = { round: match.round, correct: match.players.map(player => match.answers[player.id].correct), damage: [before[0]-match.hp[0], before[1]-match.hp[1]] };
        match.round++; match.answers = {};
        if (match.hp.some(h => h <= 0) || match.round >= 15) {
          match.status = 'finished';
          const a = match.hp[0], b = match.hp[1];
          match.outcomes = a === b ? ['draw','draw'] : a > b ? ['win','loss'] : ['loss','win'];
          match.players.forEach((player,i) => {
            const outcome = match.outcomes[i];
            const reward = outcome === 'win' ? {coins:100,xp:50} : outcome === 'loss' ? {coins:20,xp:10} : {coins:0,xp:0};
            const who = getUserById(player.id);
            if (who && who.role === 'owner') reward.coins = 0;
            db.prepare('UPDATE users SET matches=matches+1, wins=wins+?, losses=losses+?, coins=coins+?, xp=xp+? WHERE id=?')
              .run(outcome==='win'?1:0,outcome==='loss'?1:0,reward.coins,reward.xp,player.id);
          });
        }
      }
      return send(res, 200, { match: onlinePublic(match, u.id) });
    }
    case 'POST /api/online/leave': {
      const u = requireUser(req); removeFromQueue(u.id);
      const id = onlineByUser.get(u.id), match = id && onlineMatches.get(id);
      if (match && match.status === 'waiting') { match.status='cancelled'; onlineByUser.delete(u.id); }
      else if (match && match.status === 'playing') { match.status='finished'; const i=match.players.findIndex(x=>x.id===u.id); match.outcomes=i===0?['loss','win']:['win','loss']; }
      onlineByUser.delete(u.id);
      return send(res, 200, {ok:true});
    }

    case 'POST /api/game/result': {
      const u = requireUser(req);
      const outcome = String(body.outcome ?? '');
      const correct = Number(body.correct);
      if (!['win', 'loss', 'draw'].includes(outcome) || !Number.isInteger(correct) || correct < 0 || correct > 15) throw new HttpError(400, 'Natija noto‘g‘ri.');
      const now = Date.now();
      if (now - u.last_game_at < 15_000) throw new HttpError(429, 'Natija juda tez yuborildi.');
      const reward = outcome === 'win' ? { coins: 100, xp: 50 } : outcome === 'loss' ? { coins: 20, xp: 10 } : { coins: 0, xp: 0 };
      if (u.role === 'owner') reward.coins = 0; // Owner balansi cheksiz — o‘zgarmaydi
      db.prepare(`UPDATE users SET matches=matches+1, correct=correct+?, wins=wins+?, losses=losses+?,
                  coins=coins+?, xp=xp+?, last_game_at=? WHERE id=?`)
        .run(correct, outcome === 'win' ? 1 : 0, outcome === 'loss' ? 1 : 0, reward.coins, reward.xp, now, u.id);
      return send(res, 200, { user: publicMe(getUserById(u.id)), reward });
    }

    case 'POST /api/shop/buy': {
      const u = requireUser(req);
      const it = ITEM_MAP.get(String(body.itemId ?? ''));
      if (!it) throw new HttpError(404, 'Bunday buyum yo‘q.');
      const owner = u.role === 'owner';
      const owned = JSON.parse(u.owned), equipped = JSON.parse(u.equipped);
      if (owned.includes(it.id)) throw new HttpError(409, 'Bu buyum allaqachon sotib olingan.');
      if (!owner && it.gender !== 'all' && it.gender !== u.gender) throw new HttpError(403, 'Bu buyum sizning avataringiz uchun emas.');
      owned.push(it.id); equipped.push(it.id);
      if (owner) {
        // Owner: coin tekshirilmaydi va kamaymaydi.
        db.prepare('UPDATE users SET owned=?, equipped=? WHERE id=?').run(JSON.stringify(owned), JSON.stringify(equipped), u.id);
      } else {
        const r = db.prepare('UPDATE users SET coins=coins-?, owned=?, equipped=? WHERE id=? AND coins>=?')
          .run(it.price, JSON.stringify(owned), JSON.stringify(equipped), u.id, it.price);
        if (r.changes !== 1) throw new HttpError(402, 'Coin yetarli emas. Duel o‘ynab coin yig‘!');
      }
      return send(res, 200, { user: publicMe(getUserById(u.id)) });
    }

    case 'POST /api/shop/equip': {
      const u = requireUser(req);
      const id = String(body.itemId ?? '');
      const owned = JSON.parse(u.owned), equipped = JSON.parse(u.equipped);
      if (!ITEM_MAP.has(id) || !owned.includes(id)) throw new HttpError(403, 'Bu buyum sizda yo‘q.');
      if (!equipped.includes(id)) equipped.push(id);
      db.prepare('UPDATE users SET equipped=? WHERE id=?').run(JSON.stringify(equipped), u.id);
      return send(res, 200, { user: publicMe(getUserById(u.id)) });
    }

    case 'POST /api/shop/unequip': {
      const u = requireUser(req);
      const id = String(body.itemId ?? '');
      const it = ITEM_MAP.get(id);
      const owned = JSON.parse(u.owned), equipped = JSON.parse(u.equipped);
      if (!it || !owned.includes(id)) throw new HttpError(403, 'Bu buyum sizda yo‘q.');
      if (it.cat === 'clothes') {
        const remainingClothes = equipped.filter(eid => { const x = ITEM_MAP.get(eid); return x && x.cat === 'clothes' && eid !== id; });
        if (!remainingClothes.length) { /* Boshlang‘ich yopiq kiyim avatar ustida qoladi. */ }
      }
      const next = equipped.filter(eid => eid !== id);
      db.prepare('UPDATE users SET equipped=? WHERE id=?').run(JSON.stringify(next), u.id);
      return send(res, 200, { user: publicMe(getUserById(u.id)) });
    }

    case 'GET /api/ranking': {
      const u = sessionUser(req);
      const rows = db.prepare(`SELECT id,first,last,grade,wins,losses,xp,matches FROM users WHERE role='student' ORDER BY wins DESC, xp DESC, matches DESC, id ASC`).all();
      const mapped = rows.map((r) => ({ id:r.id, name: r.first + ' ' + (r.last ? r.last[0] + '.' : ''), grade: String(r.grade), wins: r.wins, losses: r.losses, matches: r.matches, xp: r.xp, me: !!u && u.id === r.id }));
      // Har bir sinf TOP-3 serverdagi doimiy SQLite foydalanuvchi natijalaridan qayta hisoblanadi.
      const gradeTop3 = {};
      for (const grade of ['5','6','7','8','9','10','11']) {
        gradeTop3[grade] = mapped.filter(r => r.grade === grade)
          .sort((a,b) => b.wins-a.wins || b.xp-a.xp || b.matches-a.matches || a.id-b.id)
          .slice(0,3);
      }
      return send(res, 200, { rows: mapped, gradeTop3 });
    }

    /* ----- Owner API: har birida server tomonidagi rol tekshiruvi ----- */
    case 'GET /api/owner/stats': {
      requireOwner(req);
      const s = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='student'`).get().n;
      const g = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM coin_grants').get();
      return send(res, 200, { students: s, grants: g.n, totalGranted: g.total });
    }

    case 'GET /api/owner/lookup': {
      requireOwner(req);
      const phone = normPhone(url.searchParams.get('q'));
      if (!phone) throw new HttpError(400, 'Login (telefon raqami) noto‘g‘ri kiritilgan.');
      const s = getUserByPhone(phone);
      if (!s) throw new HttpError(404, 'Bunday o‘quvchi topilmadi.');
      if (s.role === 'owner') throw new HttpError(400, 'Owner hisobiga coin berish shart emas — unda cheksiz coin bor.');
      return send(res, 200, { student: { id: s.id, first: s.first, last: s.last, school: s.school, grade: s.grade, gender: s.gender, phone: maskPhone(phone), coins: s.coins } });
    }

    case 'POST /api/owner/grant': {
      const o = requireOwner(req);
      const userId = Number(body.userId), amount = body.amount;
      if (!Number.isInteger(userId) || userId < 1) throw new HttpError(400, 'O‘quvchi tanlanmagan.');
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1) throw new HttpError(400, 'Coin miqdori musbat butun son bo‘lishi kerak.');
      if (amount > MAX_GRANT) throw new HttpError(400, `Bir martada eng ko‘pi bilan ${MAX_GRANT.toLocaleString('en-US')} coin berish mumkin.`);
      const result = inTx(() => {
        const s = getUserById(userId);
        if (!s || s.role !== 'student') throw new HttpError(404, 'Bunday o‘quvchi topilmadi.');
        if (s.coins + amount > MAX_COINS) throw new HttpError(400, 'O‘quvchi balansi chegaradan oshib ketadi.');
        const bal = s.coins + amount;
        db.prepare('UPDATE users SET coins=? WHERE id=?').run(bal, s.id);
        const gid = db.prepare('INSERT INTO coin_grants(owner_id,user_id,amount,balance_after,created_at) VALUES(?,?,?,?,?)').run(o.id, s.id, amount, bal, nowIso()).lastInsertRowid;
        return { id: Number(gid), student: { id: s.id, first: s.first, last: s.last, coins: bal }, amount };
      });
      return send(res, 200, { ok: true, grant: result });
    }

    case 'GET /api/owner/history': {
      requireOwner(req);
      const rows = db.prepare(`SELECT g.id,g.amount,g.balance_after,g.created_at,u.first,u.last,u.school,u.grade,u.phone_enc
                               FROM coin_grants g JOIN users u ON u.id=g.user_id ORDER BY g.id DESC LIMIT 100`).all();
      return send(res, 200, { rows: rows.map((r) => ({ id: r.id, amount: r.amount, balanceAfter: r.balance_after, at: r.created_at, name: r.first + ' ' + r.last, school: r.school, grade: r.grade, phone: maskPhone(decPhone(r.phone_enc)) })) });
    }

    case 'GET /api/owner/students': {
      requireOwner(req);
      const rows = db.prepare(`SELECT id,first,last,school,grade,phone_enc,coins,wins,losses,xp FROM users WHERE role='student' ORDER BY id DESC LIMIT 200`).all();
      return send(res, 200, { rows: rows.map((r) => ({ id: r.id, name: r.first + ' ' + r.last, school: r.school, grade: r.grade, phone: maskPhone(decPhone(r.phone_enc)), coins: r.coins, wins: r.wins, losses: r.losses, xp: r.xp })) });
    }
  }
  throw new HttpError(404, 'Bunday API topilmadi.');
}

/* ---------- Statik fayllar ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
function serveFile(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Topilmadi.' });
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}
function serveStatic(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Usul qo‘llab-quvvatlanmaydi.' });
  let rel;
  try { rel = decodeURIComponent(p === '/' ? '/index.html' : p); } catch { return send(res, 400, { error: 'Noto‘g‘ri manzil.' }); }
  if (rel.includes('\0')) return send(res, 400, { error: 'Noto‘g‘ri manzil.' });
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Topilmadi.' });
  serveFile(res, file, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/')) return await handleApi(req, res, url, p);
    if (p === '/owner/panel.js') {
      // Owner paneli kodi faqat Owner sessiyasiga beriladi; boshqalarga "topilmadi".
      const u = sessionUser(req);
      if (!u || u.role !== 'owner') return send(res, 404, { error: 'Topilmadi.' });
      return serveFile(res, OWNER_PANEL_FILE, MIME['.js']);
    }
    return serveStatic(req, res, p);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Serverda xatolik yuz berdi.' });
  }
});

/* ---------- Owner akkauntini .env dan sozlash ---------- */
async function seedOwner() {
  const rawPhone = process.env.OWNER_PHONE, pw = process.env.OWNER_PASSWORD;
  if (!rawPhone || !pw) {
    db.prepare(`UPDATE users SET role='student' WHERE role='owner'`).run();
    console.warn(ENV_FOUND
      ? '[OGOHLANTIRISH] .env topildi, lekin OWNER_PHONE yoki OWNER_PASSWORD bo‘sh — Owner akkaunti FAOL EMAS.'
      : '[OGOHLANTIRISH] ' + ENV_FILE + ' fayli TOPILMADI — Owner akkaunti FAOL EMAS. .env.example ni .env qilib nusxalang.');
    return;
  }
  const phone = normPhone(rawPhone);
  if (!phone) die('OWNER_PHONE noto‘g‘ri. Masalan: 998901234567');
  if (pw.length < 8) die('OWNER_PASSWORD kamida 8 belgidan iborat bo‘lishi kerak.');
  const h = phoneHash(phone);
  db.prepare(`UPDATE users SET role='student' WHERE role='owner' AND phone_hash<>?`).run(h); // faqat .env dagi akkaunt Owner
  const ex = db.prepare('SELECT * FROM users WHERE phone_hash=?').get(h);
  if (ex) {
    if (!(await verifyPassword(pw, ex.pass))) db.prepare('UPDATE users SET pass=? WHERE id=?').run(await hashPassword(pw), ex.id);
    db.prepare(`UPDATE users SET role='owner' WHERE id=?`).run(ex.id);
  } else {
    db.prepare(`INSERT INTO users(first,last,school,grade,gender,phone_hash,phone_enc,pass,role,created_at)
                VALUES('Owner','ILM','CHOQQISI','11','boy',?,?,?,'owner',?)`).run(h, encPhone(phone), await hashPassword(pw), nowIso());
  }
  console.log('[OK] Owner akkaunti faol. Login: ' + maskPhone(phone));
}

async function start() {
  DUMMY_HASH = await hashPassword(crypto.randomBytes(8).toString('hex'));
  await seedOwner();
  server.listen(PORT, HOST, () => console.log(`ILM CHO‘QQISI ishga tushdi: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}
start();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); try { db.close(); } catch {} process.exit(0); });
