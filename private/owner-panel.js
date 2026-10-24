/* ILM CHO‘QQISI — Owner paneli. Bu fayl faqat Owner sessiyasi uchun /owner/panel.js orqali beriladi. */
(function () {
  if (document.getElementById('ownerPanel')) return;

  const css = document.createElement('style');
  css.textContent = `
  .ownergrid{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-top:14px}
  .coincard{border-color:#6b58c9;background:linear-gradient(145deg,#1a1a45,#0e1430)}
  .coincard h3{margin:0 0 4px;display:flex;align-items:center;gap:8px}
  .studentbox{margin:12px 0;padding:12px 14px;border:1px solid #3d5a9e;border-radius:12px;background:#0b1530}
  .studentbox.err{border-color:#a33a58;background:#2a1020;color:#ffc1d0}
  .studentbox b{font-size:17px}
  .btnrow{display:flex;gap:8px;flex-wrap:wrap}
  .bm-modal{position:fixed;inset:0;z-index:50;background:#030612cc;display:grid;place-items:center;padding:18px}
  .bm-modal .box{max-width:430px;width:100%;border:1px solid #6b58c9;border-radius:18px;padding:22px;background:linear-gradient(145deg,#16214a,#0c1229);box-shadow:0 20px 70px #000b}
  .bm-modal h3{margin:0 0 10px}.bm-modal .row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid #26385b}
  .bm-modal .amount{font-size:30px;font-weight:900;color:var(--gold);text-align:center;margin:14px 0}
  @media(max-width:800px){.ownergrid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(css);

  // Navigatsiya tugmasi
  const nav = document.getElementById('nav');
  const navBtn = document.createElement('button');
  navBtn.id = 'navOwner'; navBtn.dataset.page = 'ownerPanel'; navBtn.textContent = '🛡️ Owner';
  navBtn.onclick = () => go('ownerPanel');
  const logoutBtn = document.getElementById('navLogout');
  nav.insertBefore(navBtn, logoutBtn || null);

  // Panel sahifasi
  const sec = document.createElement('section');
  sec.className = 'page'; sec.id = 'ownerPanel';
  sec.innerHTML = `
    <div class="title"><h2>🛡️ Owner boshqaruv paneli</h2><span class="pill gold">🪙 ∞ cheksiz coin</span></div>
    <div class="stats">
      <div class="stat"><span>O‘quvchilar soni</span><strong id="oStudents">–</strong></div>
      <div class="stat"><span>Berilgan coin (jami)</span><strong id="oTotal">–</strong></div>
      <div class="stat"><span>Coin berish amallari</span><strong id="oGrants">–</strong></div>
      <div class="stat"><span>Ruxsat</span><strong>Owner</strong></div>
    </div>

    <div class="card coincard">
      <h3>🪙 O‘quvchiga coin berish</h3>
      <p class="muted tiny" style="margin:0 0 8px">O‘quvchining login (telefon raqami)ni va coin miqdorini kiriting. Berishdan oldin profil ko‘rsatiladi va tasdiqlash so‘raladi.</p>
      <div class="formgrid">
        <div class="field"><label for="oLogin">O‘quvchi logini (telefon)</label><input id="oLogin" type="tel" placeholder="+998 XX XXX XX XX" autocomplete="off"></div>
        <div class="field"><label for="oAmount">Coin miqdori</label><input id="oAmount" type="number" min="1" max="1000000" step="1" placeholder="Masalan: 5000" inputmode="numeric"></div>
      </div>
      <div id="oStudent"></div>
      <div class="btnrow">
        <button class="secondary" id="oFind" type="button">🔎 Profilni topish</button>
        <button class="pink" id="oGive" type="button">🪙 Coin berish</button>
      </div>
    </div>

    <div class="ownergrid">
      <div class="card" style="overflow:auto"><h3 style="margin-top:0">🧾 Coin berish tarixi</h3>
        <table style="min-width:420px"><thead><tr><th>Sana</th><th>O‘quvchi</th><th>Miqdor</th></tr></thead><tbody id="oHistory"></tbody></table></div>
      <div class="card" style="overflow:auto"><h3 style="margin-top:0">👥 O‘quvchilar</h3>
        <table style="min-width:420px"><thead><tr><th>Ism</th><th>Sinf</th><th>Telefon</th><th>Coin</th></tr></thead><tbody id="oStudents2"></tbody></table></div>
    </div>
    <button style="margin-top:14px" class="secondary" onclick="logout()">Ownerdan chiqish</button>
    <button style="margin-top:14px" class="secondary" onclick="go('home')">Bosh sahifaga qaytish</button>`;
  document.querySelector('main').insertBefore(sec, document.querySelector('main .footer'));

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (iso) => { const d = new Date(iso); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const gradeTxt = (g) => g + '-sinf';
  let found = null;

  function showStudent(s, errMsg) {
    const box = $('oStudent');
    if (errMsg) { box.innerHTML = `<div class="studentbox err">${escapeHtml(errMsg)}</div>`; return; }
    if (!s) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="studentbox"><b>${escapeHtml(s.first + ' ' + s.last)}</b>
      <div class="muted tiny" style="margin-top:4px">${escapeHtml(s.school)} • ${escapeHtml(gradeTxt(s.grade))} • ${escapeHtml(s.phone)}</div>
      <div style="margin-top:6px">Hozirgi balans: <b class="gold">🪙 ${fmt(s.coins)}</b></div></div>`;
  }

  async function findStudent() {
    found = null;
    const q = $('oLogin').value.trim();
    if (!q) { showStudent(null, 'O‘quvchi loginini (telefon raqamini) kiriting.'); return null; }
    try {
      const d = await api('GET', '/api/owner/lookup?q=' + encodeURIComponent(q));
      found = d.student; showStudent(found); return found;
    } catch (e) { showStudent(null, e.message); return null; }
  }

  function readAmount() {
    const raw = $('oAmount').value.trim();
    if (!/^\d+$/.test(raw)) return { err: 'Coin miqdorini musbat butun son sifatida kiriting.' };
    const n = Number(raw);
    if (n < 1) return { err: 'Coin miqdori kamida 1 bo‘lishi kerak.' };
    if (n > 1000000) return { err: 'Bir martada eng ko‘pi bilan 1 000 000 coin berish mumkin.' };
    return { n };
  }

  function confirmDialog(s, amount) {
    return new Promise((resolve) => {
      const m = document.createElement('div');
      m.className = 'bm-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
      m.innerHTML = `<div class="box"><h3>Tasdiqlang</h3>
        <div class="row"><span class="muted">O‘quvchi</span><b>${escapeHtml(s.first + ' ' + s.last)}</b></div>
        <div class="row"><span class="muted">Maktab / sinf</span><span>${escapeHtml(s.school)}, ${escapeHtml(gradeTxt(s.grade))}</span></div>
        <div class="row"><span class="muted">Telefon</span><span>${escapeHtml(s.phone)}</span></div>
        <div class="row"><span class="muted">Hozirgi balans</span><span>🪙 ${fmt(s.coins)}</span></div>
        <div class="amount">+ ${fmt(amount)} coin</div>
        <div class="btnrow" style="justify-content:flex-end"><button class="secondary" id="cNo">Bekor qilish</button><button class="pink" id="cYes">Tasdiqlash</button></div></div>`;
      document.body.appendChild(m);
      const done = (v) => { m.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };
      document.addEventListener('keydown', onKey);
      m.querySelector('#cNo').onclick = () => done(false);
      m.querySelector('#cYes').onclick = () => done(true);
      m.addEventListener('click', (e) => { if (e.target === m) done(false); });
      m.querySelector('#cYes').focus();
    });
  }

  async function giveCoins() {
    const a = readAmount();
    const s = await findStudent();
    if (!s) return;
    if (a.err) { toast(a.err); showStudent(s, null); return; }
    const ok = await confirmDialog(s, a.n);
    if (!ok) { toast('Coin berish bekor qilindi.'); return; }
    const btn = $('oGive'); btn.disabled = true;
    try {
      const d = await api('POST', '/api/owner/grant', { userId: s.id, amount: a.n });
      const g = d.grant;
      toast(`✅ ${g.student.first} ${g.student.last} hisobiga ${fmt(g.amount)} coin qo‘shildi. Yangi balans: ${fmt(g.student.coins)}`);
      found = { ...s, coins: g.student.coins }; showStudent(found);
      $('oAmount').value = '';
      refresh();
    } catch (e) { toast('❌ ' + e.message); }
    finally { btn.disabled = false; }
  }

  async function refresh() {
    try {
      const [st, h, l] = await Promise.all([api('GET', '/api/owner/stats'), api('GET', '/api/owner/history'), api('GET', '/api/owner/students')]);
      $('oStudents').textContent = fmt(st.students);
      $('oTotal').textContent = fmt(st.totalGranted);
      $('oGrants').textContent = fmt(st.grants);
      $('oHistory').innerHTML = h.rows.length
        ? h.rows.map((r) => `<tr><td>${escapeHtml(fmtDate(r.at))}</td><td>${escapeHtml(r.name)}<div class="muted tiny">${escapeHtml(r.phone)}</div></td><td class="gold">+${fmt(r.amount)}</td></tr>`).join('')
        : '<tr><td colspan="3" class="muted">Hali coin berilmagan.</td></tr>';
      $('oStudents2').innerHTML = l.rows.length
        ? l.rows.map((r) => `<tr><td>${escapeHtml(r.name)}<div class="muted tiny">${escapeHtml(r.school)}</div></td><td>${escapeHtml(gradeTxt(r.grade))}</td><td class="tiny">${escapeHtml(r.phone)}</td><td>${fmt(r.coins)}</td></tr>`).join('')
        : '<tr><td colspan="4" class="muted">Hali o‘quvchi ro‘yxatdan o‘tmagan.</td></tr>';
    } catch (e) { toast(e.message); }
  }

  $('oFind').onclick = findStudent;
  $('oGive').onclick = giveCoins;
  $('oLogin').addEventListener('keydown', (e) => { if (e.key === 'Enter') findStudent(); });
  $('oAmount').addEventListener('keydown', (e) => { if (e.key === 'Enter') giveCoins(); });
  window.renderOwnerPanel = refresh;
})();
