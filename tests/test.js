'use strict';
// Ishga tushirish: npm test   (server avtomatik vaqtinchalik bazada ishga tushiriladi)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-test-'));
const OWNER_PHONE = '998901112233', OWNER_PASS = 'Test-Owner-Parol-123';
let child;

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, OWNER_PHONE, OWNER_PASSWORD: OWNER_PASS, NODE_ENV: 'development' }
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('ishga tushdi')) resolve(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => reject(new Error('Server to‘xtadi: ' + out)));
    setTimeout(() => reject(new Error('Server ishga tushmadi: ' + out)), 8000);
  });
}
const stopServer = () => new Promise((r) => { child.removeAllListeners('exit'); child.on('exit', r); child.kill('SIGTERM'); });

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, extra = {}) {
    const headers = { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...extra };
    const r = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) { const c = sc.split(';')[0]; this.cookie = c.endsWith('=') ? '' : c; }
    let data = null; const text = await r.text(); try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b) { return this.req('POST', u, b ?? {}); }
}

let pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? ' -> ' + JSON.stringify(extra) : '')); } }

(async () => {
  await startServer();
  console.log('\n[1] Ro‘yxatdan o‘tish va kirish');
  const A = new Client(), B = new Client(), O = new Client(), ANON = new Client();
  let r = await A.post('/api/register', { first: 'Ali', last: 'Valiyev', school: '5-sonli IDUM', grade: '7', gender: 'boy', phone: '+998 90 123 45 67', password: 'parol123', role: 'owner', coins: 99999 });
  ok(r.status === 201 && r.data.user.role === 'student', 'oddiy o‘quvchi ro‘yxatdan o‘tdi, role=owner yuborilsa ham student', r.data);
  ok(r.data.user.coins === 0, 'boshlang‘ich coin 0 (client yuborgan coins e’tiborga olinmadi)', r.data.user);
  r = await B.post('/api/register', { first: 'Vali', last: 'Karimov', school: '6-sonli', grade: '8', gender: 'girl', phone: '99 777 88 99', password: 'parol456' });
  ok(r.status === 201, 'ikkinchi o‘quvchi ro‘yxatdan o‘tdi');
  r = await new Client().post('/api/register', { first: 'X', last: 'Y', school: 'Z', grade: '7', gender: 'boy', phone: '998901234567', password: 'parol789' });
  ok(r.status === 409, 'bir xil telefon bilan qayta ro‘yxatdan o‘tib bo‘lmaydi', r.data);
  r = await new Client().post('/api/register', { first: 'X', last: 'Y', school: 'Z', grade: '7', gender: 'boy', phone: OWNER_PHONE, password: 'parol789' });
  ok(r.status === 409, 'Owner telefon raqami bilan ro‘yxatdan o‘tib bo‘lmaydi');
  r = await new Client().post('/api/register', { first: 'X', last: 'Y', school: 'Z', grade: '7', gender: 'boy', phone: '998905550000', password: '123' });
  ok(r.status === 400, 'qisqa parol rad etildi');
  r = await new Client().post('/api/login', { phone: '998901234567', password: 'xato-parol' });
  ok(r.status === 401, 'noto‘g‘ri parol rad etildi');
  const A2 = new Client();
  r = await A2.post('/api/login', { phone: '90 123 45 67', password: 'parol123' });
  ok(r.status === 200 && r.data.user.first === 'Ali', 'telefon formati boshqacha bo‘lsa ham kirish ishladi');
  r = await A2.get('/api/me');
  ok(r.data.user && r.data.user.id === A2.id || r.data.user?.first === 'Ali', 'sessiya /api/me da ishlaydi');
  ok(!('pass' in r.data.user) && !('phone_hash' in r.data.user), '/api/me da parol/hash chiqmaydi');

  console.log('\n[2] Oddiy foydalanuvchi Owner imkoniyatlariga ega emas');
  for (const [m, u, b] of [['GET', '/api/owner/stats'], ['GET', '/api/owner/lookup?q=998901234567'], ['POST', '/api/owner/grant', { userId: 1, amount: 5000 }], ['GET', '/api/owner/history'], ['GET', '/api/owner/students']]) {
    r = await A.req(m, u, b);
    ok(r.status === 403, `oddiy o‘quvchi ${m} ${u.split('?')[0]} -> 403`, r.status);
    r = await ANON.req(m, u, b);
    ok(r.status === 401, `mehmon ${m} ${u.split('?')[0]} -> 401`, r.status);
  }
  r = await A.get('/owner/panel.js'); ok(r.status === 404, 'oddiy o‘quvchiga /owner/panel.js berilmaydi (404)');
  r = await ANON.get('/owner/panel.js'); ok(r.status === 404, 'mehmonga /owner/panel.js berilmaydi (404)');
  r = await A.get('/'); ok(r.status === 200 && !/owner-panel|oLogin|Coin berish|grant/i.test(r.data), 'asosiy sahifa HTML ida Owner panel kodi yo‘q');
  r = await A.get('/private/owner-panel.js'); ok(r.status === 404, '/private/ papkasi ochiq emas');
  r = await A.get('/..%2fserver.js'); ok(r.status !== 200, 'papkadan chiqib ketish (path traversal) bloklangan', r.status);
  r = await A.get('/%2e%2e/server.js'); ok(r.status !== 200, 'path traversal (%2e%2e) bloklangan', r.status);
  r = await A.get('/data/battlemind.db'); ok(r.status === 404, 'ma’lumotlar bazasi fayli ochiq emas');
  r = await A.req('POST', '/api/register', undefined, { 'Content-Type': 'text/plain' }); ok(r.status === 415, 'JSON bo‘lmagan POST (CSRF) rad etildi');
  r = await A.req('POST', '/api/game/result', { outcome: 'win', correct: 5 }, { Origin: 'http://evil.example' }); ok(r.status === 403, 'begona Origin dan POST rad etildi');

  console.log('\n[3] Owner kirishi va cheksiz coin');
  r = await new Client().post('/api/login', { phone: OWNER_PHONE, password: 'noto‘g‘ri' }); ok(r.status === 401, 'Owner noto‘g‘ri parol bilan kira olmadi');
  r = await O.post('/api/login', { phone: OWNER_PHONE, password: OWNER_PASS });
  ok(r.status === 200 && r.data.user.role === 'owner' && r.data.user.infinite === true, 'Owner mavjud login orqali kirdi (infinite=true)', r.data);
  r = await O.get('/owner/panel.js'); ok(r.status === 200 && /ownerPanel/.test(r.data), 'Owner panel kodini oldi');
  r = await O.post('/api/shop/buy', { itemId: 'galaxy' }); ok(r.status === 200 && r.data.user.owned.includes('galaxy'), 'Owner (coin 0) 4200 coinlik buyumni sotib oldi');
  r = await O.post('/api/shop/buy', { itemId: 'sakura' }); ok(r.status === 200 && r.data.user.owned.includes('sakura'), 'Owner qiz avatariga mo‘ljallangan buyumni ham oldi');
  const dbPeek = new DatabaseSync(path.join(DATA, 'battlemind.db'));
  ok(dbPeek.prepare("SELECT coins FROM users WHERE role='owner'").get().coins === 0, 'Owner sotib olganda coin bazada kamaymadi (0 -> 0, manfiy bo‘lmadi)');
  r = await O.post('/api/shop/buy', { itemId: 'night' }); r = await O.post('/api/shop/buy', { itemId: 'jacket' });
  r = await O.get('/api/me'); ok(r.data.user.owned.length === 4 && r.data.user.coins === 0, 'Owner bir nechta buyum oldi, coin o‘zgarmadi');
  r = await O.post('/api/game/result', { outcome: 'win', correct: 10 }); ok(r.status === 200 && r.data.reward.coins === 0, 'Owner duel mukofotida coin qo‘shilmaydi (cheksiz)');

  console.log('\n[4] Owner o‘quvchiga coin beradi');
  r = await O.get('/api/owner/lookup?q=' + encodeURIComponent('+998 90 123 45 67'));
  ok(r.status === 200 && r.data.student.first === 'Ali' && r.data.student.phone.includes('*'), 'o‘quvchi topildi, telefon yashirin ko‘rsatildi', r.data);
  const aliId = r.data.student.id;
  r = await O.get('/api/owner/lookup?q=998000000000'); ok(r.status === 404, 'mavjud bo‘lmagan o‘quvchi -> 404 tushunarli xato', r.data);
  r = await O.get('/api/owner/lookup?q=abc'); ok(r.status === 400, 'noto‘g‘ri login -> 400', r.data);
  r = await O.get('/api/owner/lookup?q=' + OWNER_PHONE); ok(r.status === 400, 'Ownerning o‘ziga coin berib bo‘lmaydi');
  for (const bad of [0, -5, 1.5, '5000', null, 1000001, 1e30]) {
    r = await O.post('/api/owner/grant', { userId: aliId, amount: bad });
    ok(r.status === 400, `noto‘g‘ri miqdor (${JSON.stringify(bad)}) rad etildi`, r.data);
  }
  r = await O.post('/api/owner/grant', { userId: 999999, amount: 100 }); ok(r.status === 404, 'mavjud bo‘lmagan userId -> 404');
  r = await O.post('/api/owner/grant', { userId: 1, amount: 100 });
  r = await O.post('/api/owner/grant', { userId: aliId, amount: 5000 });
  ok(r.status === 200 && r.data.grant.student.coins === 5000, 'student123 misoli: 5000 coin berildi', r.data);
  r = await A.get('/api/me'); ok(r.data.user.coins === 5000, 'o‘quvchi profilida 5000 coin ko‘rinadi');
  r = await B.get('/api/me'); ok(r.data.user.coins === 0, 'boshqa o‘quvchi (Vali) balansiga ta’sir qilmadi');
  r = await A.post('/api/owner/grant', { userId: aliId, amount: 1000000 }); ok(r.status === 403, 'o‘quvchi o‘ziga coin bera olmaydi');
  r = await O.get('/api/owner/history');
  ok(r.data.rows.length === 1 && r.data.rows[0].amount === 5000 && r.data.rows[0].name === 'Ali Valiyev' && !!r.data.rows[0].at, 'tarixda sana, miqdor va akkaunt qayd etildi', r.data.rows[0]);
  r = await O.get('/api/owner/stats'); ok(r.data.students === 2 && r.data.totalGranted === 5000, 'statistika to‘g‘ri');
  r = await O.get('/api/owner/students'); ok(r.data.rows.length === 2 && r.data.rows.every((x) => x.phone.includes('*')), 'o‘quvchilar ro‘yxati, telefonlar yashirilgan');

  console.log('\n[5] Oddiy o‘quvchilar uchun coin tizimi avvalgidek');
  r = await B.post('/api/shop/buy', { itemId: 'hoodie' }); ok(r.status === 402, 'coini yetmagan o‘quvchi sotib ola olmaydi (402)', r.data);
  r = await A.post('/api/shop/buy', { itemId: 'hoodie' }); ok(r.status === 200 && r.data.user.coins === 3800, 'Ali 1200 coinlik hudini oldi: 5000 -> 3800', r.data.user);
  r = await A.post('/api/shop/buy', { itemId: 'hoodie' }); ok(r.status === 409, 'bir buyumni ikki marta sotib bo‘lmaydi');
  r = await A.post('/api/shop/buy', { itemId: 'sakura' }); ok(r.status === 403, 'o‘g‘il bola qiz avatari buyumini ola olmaydi');
  r = await A.post('/api/shop/buy', { itemId: 'yo‘q' }); ok(r.status === 404, 'mavjud bo‘lmagan buyum -> 404');
  r = await A.post('/api/shop/equip', { itemId: 'galaxy' }); ok(r.status === 403, 'sotib olinmagan buyumni jihozlab bo‘lmaydi');
  r = await A.post('/api/game/result', { outcome: 'win', correct: 9 }); ok(r.status === 200 && r.data.user.coins === 3900 && r.data.user.wins === 1, 'g‘alaba: +100 coin, +50 XP', r.data);
  r = await A.post('/api/game/result', { outcome: 'win', correct: 9 }); ok(r.status === 429, 'natijani juda tez qayta yuborish cheklangan');
  r = await A.post('/api/game/result', { outcome: 'win', correct: 99 }); ok(r.status === 400 || r.status === 429, 'noto‘g‘ri natija rad etildi');
  r = await new Client().get('/api/ranking'); ok(r.status === 200 && r.data.rows.length === 2 && r.data.rows.every((x) => !('phone' in x)), 'reytingda telefon ma’lumoti yo‘q');
  ok(r.data.rows.some((x) => x.name === 'Ali V.'), 'reytingda familiya qisqartirilgan');

  console.log('\n[6] Chiqish');
  r = await A.post('/api/logout'); r = await A.get('/api/me'); ok(r.data.user === null, 'chiqishdan keyin sessiya tugaydi');
  r = await O.post('/api/logout'); r = await O.get('/api/owner/stats'); ok(r.status === 401, 'Ownerdan chiqqach Owner API ochilmaydi');

  console.log('\n[7] Ma’lumotlar bazasida xavfsizlik');
  const rows = dbPeek.prepare('SELECT * FROM users').all();
  ok(rows.every((u) => u.pass.startsWith('scrypt$') && !u.pass.includes('parol') && !u.pass.includes(OWNER_PASS)), 'parollar scrypt bilan hash qilingan');
  ok(rows.every((u) => /^[0-9a-f]{64}$/.test(u.phone_hash) && !u.phone_enc.includes('998') && Buffer.from(u.phone_enc, 'base64').length > 28), 'telefon raqamlari bazada shifrlangan / HMAC ko‘rinishida');
  dbPeek.close();
  const raw = fs.readFileSync(path.join(DATA, 'battlemind.db'));
  ok(!raw.includes(Buffer.from('998901234567')) && !raw.includes(Buffer.from(OWNER_PASS)), 'baza faylida ochiq telefon yoki parol topilmadi');

  console.log('\n[8] Server qayta ishga tushganda ma’lumotlar saqlanadi');
  await stopServer(); await startServer();
  const A3 = new Client();
  r = await A3.post('/api/login', { phone: '998901234567', password: 'parol123' });
  ok(r.status === 200 && r.data.user.coins === 3900 && r.data.user.owned.includes('hoodie'), 'qayta kirganda coin (3900) va buyumlar saqlangan', r.data.user);
  r = await new Client().post('/api/login', { phone: OWNER_PHONE, password: OWNER_PASS }); ok(r.data.user?.role === 'owner', 'Owner qayta ishga tushgandan keyin ham ishlaydi');
  const O2 = new Client(); await O2.post('/api/login', { phone: OWNER_PHONE, password: OWNER_PASS });
  r = await O2.get('/api/owner/history'); ok(r.data.rows.length === 1, 'coin berish tarixi qayta ishga tushgandan keyin ham bor');

  console.log('\n[9] Kirishga urinishlar cheklovi');
  const X = new Client(); let last;
  for (let i = 0; i < 10; i++) last = await X.post('/api/login', { phone: '998901234567', password: 'x' + i });
  ok(last.status === 429, 'ketma-ket noto‘g‘ri parollardan keyin vaqtincha bloklanadi (429)', last.status);

  await stopServer();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\nNatija: ${pass} ta o‘tdi, ${fail} ta xato.`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await stopServer(); } catch {} process.exit(1); });
