// Filmujha Loyalty — zero-dependency Node.js server
// Run: node server.js   → Customer: http://<IP>:3000   Admin: http://<IP>:3000/admin
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
// DATA_DIR = hosting ka persistent disk (jaise /data); na ho toh project folder
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const QR_WINDOW_SEC = 60; // dynamic QR har 60 second mein badalta hai

// ---------- Data ----------
const DEFAULT_DATA = () => ({
  secret: crypto.randomBytes(16).toString('hex'),
  settings: {
    restaurantName: 'Filmujha',
    pointsPer100: 10,        // ₹100 bill = 10 points
    stampTarget: 10,         // 10 visits = free reward
    stampReward: 'Free Meal for 1',
    welcomeBonus: 50,
    referralBonus: 100,
    doublePointsDay: 1,      // 0=Sun,1=Mon ... -1 = off
    checkinCooldownHours: 4,
    publicUrl: ''            // optional: e.g. https://loyalty.filmujha.com
  },
  rewards: [
    { id: 'r1', emoji: '🥤', name: 'Free Sweet Lassi', cost: 80, active: true },
    { id: 'r2', emoji: '🍰', name: 'Free Dessert', cost: 150, active: true },
    { id: 'r3', emoji: '🏷️', name: '20% Off on Bill', cost: 300, active: true },
    { id: 'r4', emoji: '🍛', name: 'Free Thali', cost: 500, active: true }
  ],
  staff: [],
  customers: [],
  visits: [],
  redemptions: [],
  ledger: [],
  sessions: {},
  adminSessions: {}
});

// ---------- Storage: Supabase (hosting par) ya data.json (local) ----------
// Supabase set ho toh poora data ek jsonb row mein save hota hai (REST API, koi npm package nahi).
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY  (optional: SUPABASE_TABLE=app_state, SUPABASE_ROW=main)
const SUPA = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? {
      // galti se "/rest/v1" ya aakhri "/" laga ho toh hata do; quotes/spaces bhi
      url: process.env.SUPABASE_URL.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '').replace(/\/rest\/v1$/i, ''),
      key: process.env.SUPABASE_SERVICE_KEY.trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, ''),
      table: process.env.SUPABASE_TABLE || 'app_state', row: process.env.SUPABASE_ROW || 'main'
    }
  : null;
// anon / publishable key server ke liye nahi chalti — pehle hi pakdo
function keyProblem(k) {
  if (/^sb_publishable_/.test(k)) return 'Ye publishable key hai (sb_publishable_...)';
  const parts = k.split('.');
  if (parts.length === 3) { try { const role = JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role; if (role === 'anon') return 'Ye anon key hai (role: anon)'; } catch {} }
  return null;
}
// naye Supabase "secret" keys (sb_secret_...) sirf apikey header mein jaate hain; purane service_role JWT dono mein
const supaHeaders = () => SUPA.key.startsWith('sb_')
  ? { apikey: SUPA.key, 'Content-Type': 'application/json' }
  : { apikey: SUPA.key, Authorization: `Bearer ${SUPA.key}`, 'Content-Type': 'application/json' };
const writeFileNow = () => { const tmp = DATA_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, DATA_FILE); };

async function loadDb() {
  if (!SUPA) { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return DEFAULT_DATA(); } }
  // load fail ho toh setup-error mode — khaali data se asli data kabhi overwrite nahi hoga
  const kp = keyProblem(SUPA.key); if (kp) throw new Error(kp);
  // time-limit zaroori: bina iske galat URL / paused project par request hamesha atak jaati thi
  const r = await fetch(`${SUPA.url}/rest/v1/${SUPA.table}?id=eq.${encodeURIComponent(SUPA.row)}&select=data,updated_at`, { headers: supaHeaders(), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Supabase se data load nahi hua (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`);
  const rows = await r.json();
  dbVersion = rows[0]?.updated_at || null; // Vercel ke version-check ke liye
  return rows[0]?.data || DEFAULT_DATA();
}

let db = DEFAULT_DATA(); // boot() mein asli data aata hai
// Vercel (serverless): har request taaza data load karti hai aur jawab se pehle save karti hai
const ON_VERCEL = !!process.env.VERCEL;
let dbVersion = null, pendingWrite = false;
let saveTimer = null, saving = null, dirty = false;
function pushRemote() {
  if (saving) { dirty = true; return saving; }
  saving = (async () => {
    do {
      dirty = false;
      try {
        const r = await fetch(`${SUPA.url}/rest/v1/${SUPA.table}`, {
          method: 'POST', headers: { ...supaHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' }, signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ id: SUPA.row, data: db, updated_at: new Date().toISOString() })
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      } catch (e) {
        console.error('Supabase save fail, 5s baad dobara:', e.message);
        dirty = true; await new Promise(res => setTimeout(res, 5000));
      }
    } while (dirty);
  })().finally(() => { saving = null; });
  return saving;
}
function save() {
  if (setupError) return; // data load hi nahi hua — kuch save mat karo (asli data safe)
  if (ON_VERCEL) { pendingWrite = true; return; } // request ke aakhir mein version-check ke saath likha jayega
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (SUPA) pushRemote(); else writeFileNow(); }, SUPA ? 300 : 100);
}
// band hote waqt (Render deploy/restart) bacha hua data save karke hi exit
let exiting = false;
async function flushAndExit() {
  if (exiting) return; exiting = true;
  clearTimeout(saveTimer);
  try { if (SUPA) await Promise.race([pushRemote(), new Promise(r => setTimeout(r, 8000))]); else writeFileNow(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', flushAndExit);
process.on('SIGINT', flushAndExit);

// ---------- Helpers ----------
const uid = (p = '') => p + crypto.randomBytes(6).toString('hex');
const now = () => Date.now();
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');

const TIERS = [
  { name: 'Silver', min: 0, mult: 1, color: '#9aa4b1' },
  { name: 'Gold', min: 500, mult: 1.25, color: '#d4a017' },
  { name: 'Platinum', min: 1500, mult: 1.5, color: '#6c7bd8' }
];
function tierOf(c) {
  let t = TIERS[0];
  for (const x of TIERS) if (c.lifetimePoints >= x.min) t = x;
  const next = TIERS[TIERS.indexOf(t) + 1] || null;
  return { ...t, next: next ? { name: next.name, need: next.min - c.lifetimePoints } : null };
}

function addPoints(c, delta, note, by) {
  c.points += delta;
  if (delta > 0) c.lifetimePoints += delta;
  db.ledger.push({ id: uid('l'), customerId: c.id, at: now(), delta, note, ...(by ? { by } : {}) });
}

function qrToken(offset = 0) {
  const w = Math.floor(now() / 1000 / QR_WINDOW_SEC) + offset;
  return crypto.createHmac('sha256', db.secret).update(String(w)).digest('hex').slice(0, 10);
}
// current + pichle 2 windows valid (naye customer ko register karne ka time mile)
function validQr(t) { return t && [0, -1, -2].some(o => t === qrToken(o)); }

function isBirthdayWindow(dob) {
  if (!dob) return false;
  const [, m, d] = dob.split('-').map(Number);
  const today = new Date();
  for (let off = -3; off <= 3; off++) {
    const x = new Date(today); x.setDate(today.getDate() + off);
    if (x.getMonth() + 1 === m && x.getDate() === d) return true;
  }
  return false;
}

function expireRedemptions() {
  for (const r of db.redemptions) {
    if (r.status === 'pending' && r.expiresAt < now()) {
      r.status = 'expired';
      const c = db.customers.find(x => x.id === r.customerId);
      if (c) {
        if (r.rewardId === 'stamp') c.stamps += db.settings.stampTarget;
        else if (r.cost) addPoints(c, r.cost, `Refund: ${r.rewardName} (code expired)`);
      }
      save();
    }
  }
}

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(`http://${n.address}:${PORT}`);
  return out;
}

function publicCustomer(c) {
  const s = db.settings;
  const tier = tierOf(c);
  const thisYear = new Date().getFullYear();
  const bdayUsed = db.redemptions.some(r => r.customerId === c.id && r.rewardId === 'bday' &&
    r.status !== 'expired' && new Date(r.createdAt).getFullYear() === thisYear);
  const rewards = db.rewards.filter(r => r.active).map(r => ({ ...r, canRedeem: c.points >= r.cost }));
  if (c.stamps >= s.stampTarget)
    rewards.unshift({ id: 'stamp', emoji: '🎟️', name: s.stampReward + ' (Stamp Card)', cost: 0, canRedeem: true, special: true });
  if (isBirthdayWindow(c.dob) && !bdayUsed)
    rewards.unshift({ id: 'bday', emoji: '🎂', name: 'Birthday Special Dessert', cost: 0, canRedeem: true, special: true });
  const pending = db.redemptions.find(r => r.customerId === c.id && r.status === 'pending');
  return {
    name: c.name, mobile: c.mobile, points: c.points, lifetimePoints: c.lifetimePoints,
    stamps: c.stamps, stampTarget: s.stampTarget, stampReward: s.stampReward,
    visits: c.visits, referralCode: c.referralCode, tier, rewards,
    birthdayToday: isBirthdayWindow(c.dob),
    doublePointsToday: new Date().getDay() === s.doublePointsDay,
    pendingRedemption: pending ? { code: pending.code, rewardName: pending.rewardName, expiresAt: pending.expiresAt } : null,
    currentVisit: (() => {
      const v = openVisit(c); if (!v) return null;
      const items = v.items || [];
      const base = items.reduce((t, x) => t + x.points * x.qty, 0);
      return { id: v.id, at: v.at, items, orderedAt: v.orderedAt || null, total: items.reduce((t, x) => t + x.price * x.qty, 0), points: earnFor(c, base).points };
    })(),
    earnMult: tier.mult * (new Date().getDay() === s.doublePointsDay ? 2 : 1),
    canOrder: true,
    referrals: db.customers.filter(x => x.referredBy === c.id).map(x => ({ name: x.name.split(' ')[0], at: x.createdAt })).reverse(),
    referralPoints: db.ledger.filter(l => l.customerId === c.id && l.delta > 0 && /Referral bonus .*join hua/.test(l.note)).reduce((t, l) => t + l.delta, 0),
    hasCheckin: !!sessionVisit(c),
    history: db.ledger.filter(l => l.customerId === c.id).slice(-30).reverse()
  };
}

// ---------- Menu (har item ke fix points) ----------
const SAMPLE_MENU = [
  ['Starters', '🧀', 'Paneer Tikka', 260, 26, true], ['Starters', '🍗', 'Chicken 65', 280, 28, false], ['Starters', '🥦', 'Veg Manchurian', 220, 22, true],
  ['Main Course', '🍛', 'Butter Chicken', 340, 34, false], ['Main Course', '🧈', 'Paneer Butter Masala', 290, 29, true], ['Main Course', '🍲', 'Dal Makhani', 240, 24, true],
  ['Main Course', '🍚', 'Veg Biryani', 250, 25, true], ['Main Course', '🍗', 'Chicken Biryani', 320, 32, false],
  ['Breads', '🫓', 'Butter Naan', 50, 5, true], ['Breads', '🫓', 'Tandoori Roti', 30, 3, true],
  ['Drinks', '🥤', 'Sweet Lassi', 90, 9, true], ['Drinks', '☕', 'Masala Chai', 40, 4, true],
  ['Desserts', '🍮', 'Gulab Jamun', 80, 8, true], ['Desserts', '🍨', 'Kesar Kulfi', 100, 15, true]
];
function migrateMenu() {
  if (!Array.isArray(db.menu)) db.menu = SAMPLE_MENU.map(([category, emoji, name, price, points, veg]) => ({ id: uid('m'), category, emoji, name, price, points, veg, active: true }));
}

// order items [{id, qty}] → snapshot + totals
function priceOrder(items) {
  if (!Array.isArray(items) || !items.length) return { error: 'Kam se kam ek item chuniye' };
  const out = [];
  for (const it of items.slice(0, 60)) {
    const m = db.menu.find(x => x.id === it.id && x.active);
    const qty = Math.round(Number(it.qty));
    if (!m) return { error: 'Ek item ab menu mein nahi hai, order dobara banaiye' };
    if (!(qty >= 1 && qty <= 50)) continue;
    const ex = out.find(x => x.id === m.id);
    if (ex) ex.qty = Math.min(50, ex.qty + qty); else out.push({ id: m.id, emoji: m.emoji, name: m.name, price: m.price, points: m.points, qty });
  }
  if (!out.length) return { error: 'Kam se kam ek item chuniye' };
  return { items: out, total: out.reduce((s, x) => s + x.price * x.qty, 0), basePoints: out.reduce((s, x) => s + x.points * x.qty, 0) };
}
function earnFor(c, basePoints) {
  const tier = tierOf(c), dbl = new Date().getDay() === db.settings.doublePointsDay;
  return { points: Math.floor(basePoints * tier.mult * (dbl ? 2 : 1)), tier, dbl };
}
const ORDER_WINDOW = 6 * 3600e3;
const openVisit = c => { const v = db.visits.filter(x => x.customerId === c.id && x.status === 'pending').pop(); return v && now() - v.at < ORDER_WINDOW ? v : null; };
// asli QR check-in (extra orders nahi) jo ORDER_WINDOW ke andar hai: isi session mein aur order kar sakte hain
const sessionVisit = c => { const v = db.visits.filter(x => x.customerId === c.id && !x.addOn).pop(); return v && now() - v.at < ORDER_WINDOW ? v : null; };

// ---------- Staff accounts (migration: purana common PIN → owner account) ----------
function makeStaff({ name, username, password, role }) {
  const salt = crypto.randomBytes(8).toString('hex');
  return { id: uid('st'), name, username: username.toLowerCase(), salt, passHash: hashPin(password, salt), role, active: true, createdAt: now() };
}
function migrateStaff() {
  if (!Array.isArray(db.staff)) db.staff = [];
  if (!db.staff.length) db.staff.push({ ...makeStaff({ name: 'Owner', username: 'owner', password: db.settings.adminPin || '1234', role: 'owner' }), mustChange: true });
  delete db.settings.adminPin;
  if (Object.values(db.adminSessions || {}).some(v => typeof v !== 'object')) db.adminSessions = {};
}
const publicStaff = s => ({ id: s.id, name: s.name, username: s.username, role: s.role, active: s.active, createdAt: s.createdAt, mustChange: !!s.mustChange });
const OWNER_ONLY = new Set(['POST /api/admin/menu', 'POST /api/admin/config', 'POST /api/admin/adjust', 'GET /api/admin/staff', 'POST /api/admin/staff', 'POST /api/admin/staff/delete']);

// ---------- HTTP plumbing ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  // Vercel body pehle hi parse kar deta hai (req.body); baaki jagah stream padho
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) { try { return Promise.resolve(JSON.parse(String(req.body) || '{}')); } catch { return Promise.resolve({}); } }
  return new Promise(resolve => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(res, file) {
  const fp = path.join(PUBLIC_DIR, file);
  if (!fp.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    // no-cache: browser har baar check karega, purana page/JS atka nahi rahega
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
function customerFromReq(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const id = db.sessions[t];
  return id ? db.customers.find(c => c.id === id) : null;
}
function staffFromReq(req) {
  const t = req.headers['x-admin-token'];
  const s = t && db.adminSessions[t];
  if (!s || s.exp < now()) return null;
  const st = db.staff.find(x => x.id === s.staffId && x.active);
  return st || null;
}

// ---------- Routes ----------
const routes = {
  'GET /api/public': () => [200, {
    restaurantName: db.settings.restaurantName,
    rewards: db.rewards.filter(r => r.active),
    stampTarget: db.settings.stampTarget, stampReward: db.settings.stampReward,
    welcomeBonus: db.settings.welcomeBonus, referralBonus: db.settings.referralBonus, pointsPer100: db.settings.pointsPer100
  }],

  'POST /api/register': (req, b) => {
    const name = String(b.name || '').trim().slice(0, 40);
    const mobile = String(b.mobile || '').replace(/\D/g, '');
    if (name.length < 2) return [400, { error: 'Naam daaliye' }];
    if (!/^[6-9]\d{9}$/.test(mobile)) return [400, { error: 'Sahi 10-digit mobile number daaliye' }];
    if (!/^\d{4}$/.test(String(b.pin || ''))) return [400, { error: '4-digit PIN chuniye' }];
    if (db.customers.some(c => c.mobile === mobile)) return [409, { error: 'Ye number pehle se registered hai — Login kijiye' }];
    const salt = crypto.randomBytes(8).toString('hex');
    const c = {
      id: uid('c'), name, mobile, salt, pinHash: hashPin(b.pin, salt),
      dob: /^\d{4}-\d{2}-\d{2}$/.test(b.dob || '') ? b.dob : '',
      createdAt: now(), points: 0, lifetimePoints: 0, stamps: 0, visits: 0,
      referralCode: (name.replace(/[^a-z]/gi, '').slice(0, 4) || 'FMJ').toUpperCase() + crypto.randomInt(100, 999),
      referredBy: null
    };
    db.customers.push(c);
    addPoints(c, db.settings.welcomeBonus, '🎁 Welcome bonus');
    const ref = String(b.referral || '').trim().toUpperCase();
    if (ref) {
      const r = db.customers.find(x => x.referralCode === ref && x.id !== c.id);
      if (r) {
        c.referredBy = r.id;
        addPoints(c, db.settings.referralBonus, `🤝 Referral bonus (${r.name} ne invite kiya)`);
        addPoints(r, db.settings.referralBonus, `🤝 Referral bonus (${c.name} join hua)`);
      }
    }
    const token = uid('s'); db.sessions[token] = c.id; save();
    return [200, { token }];
  },

  'POST /api/login': (req, b) => {
    const mobile = String(b.mobile || '').replace(/\D/g, '');
    const c = db.customers.find(x => x.mobile === mobile);
    if (!c || c.pinHash !== hashPin(b.pin || '', c.salt)) return [401, { error: 'Mobile ya PIN galat hai' }];
    const token = uid('s'); db.sessions[token] = c.id; save();
    return [200, { token }];
  },

  'GET /api/me': (req) => {
    expireRedemptions();
    const c = customerFromReq(req);
    return c ? [200, publicCustomer(c)] : [401, { error: 'Login required' }];
  },

  'POST /api/checkin': (req, b) => {
    const c = customerFromReq(req);
    if (!c) return [401, { error: 'Login required' }];
    if (!validQr(b.t)) return [400, { error: 'QR code expire ho gaya. Counter par lage QR ko dobara scan kijiye.' }];
    const cool = db.settings.checkinCooldownHours * 3600e3;
    const last = db.visits.filter(v => v.customerId === c.id && !v.addOn).pop();
    if (last && now() - last.at < cool) return [429, { error: 'Aaj ka visit pehle se record ho chuka hai 😊' }];
    db.visits.push({ id: uid('v'), customerId: c.id, at: now(), status: 'pending', bill: 0, points: 0 });
    c.visits += 1; c.stamps += 1;
    db.ledger.push({ id: uid('l'), customerId: c.id, at: now(), delta: 0, note: `📍 Visit #${c.visits} — stamp mila` });
    save();
    return [200, { ok: true, visits: c.visits, stamps: c.stamps }];
  },

  'GET /api/menu': () => {
    // kaunsi dish kitni biki (Bestseller tag ke liye)
    const sold = {};
    for (const v of db.visits) if (v.status === 'billed') for (const it of v.items || []) sold[it.id] = (sold[it.id] || 0) + it.qty;
    const top = Object.entries(sold).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
    return [200, db.menu.filter(m => m.active).map(({ id, category, emoji, name, price, points, veg }) => ({ id, category, emoji, name, price, points, veg, bestseller: top.includes(id) }))];
  },

  'POST /api/order': (req, b) => {
    const c = customerFromReq(req);
    if (!c) return [401, { error: 'Login required' }];
    let v = openVisit(c);
    const session = sessionVisit(c);
    const o = priceOrder(b.items);
    if (o.error) return [400, { error: o.error }];
    if (!v) {
      // naya order: pichla confirm ho chuka, ya QR scan nahi kiya. Stamp/visit nahi milta,
      // points tabhi milenge jab staff confirm karega
      v = { id: uid('v'), customerId: c.id, at: now(), status: 'pending', bill: 0, points: 0, items: [], addOn: true, noScan: !session, sessionId: session ? (session.sessionId || session.id) : null };
      db.visits.push(v);
    }
    const isNew = !v.items?.length;
    v.items = o.items; v.orderedAt = now(); v.orderedBy = 'customer';
    db.ledger.push({ id: uid('l'), customerId: c.id, at: now(), delta: 0, note: `🛎️ ${v.addOn ? 'Extra order' : 'Order'} ${isNew ? 'bheja' : 'update kiya'}: ${o.items.length} item, ₹${o.total}` });
    save();
    return [200, { total: o.total, points: earnFor(c, o.basePoints).points }];
  },

  'POST /api/redeem': (req, b) => {
    expireRedemptions();
    const c = customerFromReq(req);
    if (!c) return [401, { error: 'Login required' }];
    if (db.redemptions.some(r => r.customerId === c.id && r.status === 'pending'))
      return [400, { error: 'Ek reward code pehle se active hai — pehle use staff ko dikhaiye' }];
    const avail = publicCustomer(c).rewards.find(r => r.id === b.rewardId);
    if (!avail) return [404, { error: 'Reward available nahi hai' }];
    if (c.points < avail.cost) return [400, { error: 'Points kam hain' }];
    if (avail.id === 'stamp') c.stamps -= db.settings.stampTarget;
    else if (avail.cost) addPoints(c, -avail.cost, `🎁 Redeem: ${avail.name}`);
    let code; do { code = String(crypto.randomInt(100000, 999999)); } while (db.redemptions.some(r => r.code === code && r.status === 'pending'));
    const r = { id: uid('rd'), customerId: c.id, rewardId: avail.id, rewardName: avail.name, cost: avail.cost, code, createdAt: now(), expiresAt: now() + 10 * 60e3, status: 'pending' };
    db.redemptions.push(r); save();
    return [200, { code, rewardName: r.rewardName, expiresAt: r.expiresAt }];
  },

  'POST /api/logout': (req) => {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    delete db.sessions[t]; save(); return [200, { ok: true }];
  },

  // ----- Admin -----
  'POST /api/admin/login': (req, b) => {
    const st = db.staff.find(x => x.username === String(b.username || '').trim().toLowerCase());
    if (!st || st.passHash !== hashPin(b.password || '', st.salt)) return [401, { error: 'Username ya password galat hai' }];
    if (!st.active) return [403, { error: 'Ye account band kar diya gaya hai. Owner se baat karein.' }];
    for (const [k, v] of Object.entries(db.adminSessions)) if (v.exp < now()) delete db.adminSessions[k];
    const t = uid('a'); db.adminSessions[t] = { staffId: st.id, exp: now() + 12 * 3600e3 }; save();
    return [200, { token: t, staff: publicStaff(st) }];
  },

  'GET /api/admin/me': (req) => [200, publicStaff(req.staff)],

  'POST /api/admin/logout': (req) => { delete db.adminSessions[req.headers['x-admin-token']]; save(); return [200, { ok: true }]; },

  'POST /api/admin/password': (req, b) => {
    const st = req.staff;
    if (st.passHash !== hashPin(b.oldPassword || '', st.salt)) return [400, { error: 'Purana password galat hai' }];
    if (String(b.newPassword || '').length < 6) return [400, { error: 'Naya password kam se kam 6 characters ka ho' }];
    st.salt = crypto.randomBytes(8).toString('hex'); st.passHash = hashPin(b.newPassword, st.salt); delete st.mustChange;
    for (const [k, v] of Object.entries(db.adminSessions)) if (v.staffId === st.id && k !== req.headers['x-admin-token']) delete db.adminSessions[k];
    save(); return [200, { ok: true }];
  },

  'GET /api/admin/staff': () => [200, db.staff.map(publicStaff)],

  'POST /api/admin/staff': (req, b) => {
    const name = String(b.name || '').trim().slice(0, 40);
    const username = String(b.username || '').trim().toLowerCase();
    const role = b.role === 'owner' ? 'owner' : 'staff';
    if (name.length < 2) return [400, { error: 'Naam daaliye' }];
    if (!/^[a-z0-9_.]{3,20}$/.test(username)) return [400, { error: 'Username 3-20 characters (a-z, 0-9, _ .)' }];
    if (db.staff.some(x => x.username === username && x.id !== b.id)) return [409, { error: 'Ye username pehle se hai' }];
    if (b.password && String(b.password).length < 6) return [400, { error: 'Password kam se kam 6 characters ka ho' }];
    let st = b.id && db.staff.find(x => x.id === b.id);
    if (st) {
      const owners = db.staff.filter(x => x.role === 'owner' && x.active);
      const losingOwner = st.role === 'owner' && (role !== 'owner' || b.active === false);
      if (losingOwner && owners.length <= 1) return [400, { error: 'Kam se kam ek active owner hona zaroori hai' }];
      if (st.id === req.staff.id && b.active === false) return [400, { error: 'Aap apna khud ka account band nahi kar sakte' }];
      Object.assign(st, { name, username, role, active: b.active !== false });
      if (b.password) { st.salt = crypto.randomBytes(8).toString('hex'); st.passHash = hashPin(b.password, st.salt); if (st.id !== req.staff.id) st.mustChange = true; else delete st.mustChange; }
      if (!st.active || b.password) for (const [k, v] of Object.entries(db.adminSessions)) if (v.staffId === st.id && k !== req.headers['x-admin-token']) delete db.adminSessions[k];
    } else {
      if (!b.password) return [400, { error: 'Password daaliye' }];
      st = { ...makeStaff({ name, username, password: b.password, role }), mustChange: true }; db.staff.push(st);
    }
    save(); return [200, publicStaff(st)];
  },

  'POST /api/admin/staff/delete': (req, b) => {
    const st = db.staff.find(x => x.id === b.id);
    if (!st) return [404, { error: 'Staff nahi mila' }];
    if (st.id === req.staff.id) return [400, { error: 'Aap apna khud ka account delete nahi kar sakte' }];
    if (st.role === 'owner' && db.staff.filter(x => x.role === 'owner' && x.active).length <= 1) return [400, { error: 'Akela owner delete nahi ho sakta' }];
    db.staff = db.staff.filter(x => x.id !== st.id);
    for (const [k, v] of Object.entries(db.adminSessions)) if (v.staffId === st.id) delete db.adminSessions[k];
    save(); return [200, { ok: true }];
  },

  'GET /api/admin/qr': (req) => {
    const host = req.headers.host || '';
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const base = db.settings.publicUrl || (host.startsWith('localhost') || host.startsWith('127.') ? (lanUrls()[0] || `http://${host}`) : `${proto}://${host}`);
    const msLeft = QR_WINDOW_SEC * 1000 - (now() % (QR_WINDOW_SEC * 1000));
    return [200, { url: `${base}/?t=${qrToken()}`, msLeft, lanUrls: lanUrls() }];
  },

  'GET /api/admin/dashboard': () => {
    expireRedemptions();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = db.visits.filter(v => v.at >= start.getTime());
    const byId = Object.fromEntries(db.customers.map(c => [c.id, c]));
    return [200, {
      stats: {
        customers: db.customers.length,
        visitsToday: today.filter(v => !v.addOn).length,
        revenueToday: today.reduce((s, v) => s + (v.bill || 0), 0),
        redeemedToday: db.redemptions.filter(r => r.status === 'done' && r.doneAt >= start.getTime()).length,
        pointsOutstanding: db.customers.reduce((s, c) => s + c.points, 0)
      },
      pendingVisits: db.visits.filter(v => v.status === 'pending').slice(-50).reverse().map(v => {
        const c = byId[v.customerId];
        return {
          id: v.id, at: v.at, name: c?.name, mobile: c?.mobile, tier: c ? tierOf(c).name : '', addOn: !!v.addOn, noScan: !!v.noScan,
          mult: c ? tierOf(c).mult * (new Date().getDay() === db.settings.doublePointsDay ? 2 : 1) : 1,
          items: v.items || [], orderedAt: v.orderedAt || null
        };
      }),
      topDishes: Object.values(today.filter(v => v.status === 'billed').flatMap(v => v.items || []).reduce((acc, it) => {
        (acc[it.id] ||= { emoji: it.emoji, name: it.name, qty: 0 }).qty += it.qty; return acc;
      }, {})).sort((a, b) => b.qty - a.qty).slice(0, 5),
      activity: db.ledger.slice(-25).reverse().map(l => ({ ...l, name: byId[l.customerId]?.name })),
      topCustomers: [...db.customers].sort((a, b) => b.lifetimePoints - a.lifetimePoints).slice(0, 5)
        .map(c => ({ name: c.name, mobile: c.mobile, lifetimePoints: c.lifetimePoints, visits: c.visits, tier: tierOf(c).name }))
    }];
  },

  'POST /api/admin/bill': (req, b) => {
    const v = db.visits.find(x => x.id === b.visitId && x.status === 'pending');
    if (!v) return [404, { error: 'Visit nahi mila' }];
    const o = priceOrder(b.items);
    if (o.error) return [400, { error: o.error }];
    const c = db.customers.find(x => x.id === v.customerId);
    const { points: pts, tier, dbl } = earnFor(c, o.basePoints);
    const count = o.items.reduce((t, x) => t + x.qty, 0);
    v.status = 'billed'; v.items = o.items; v.bill = o.total; v.points = pts; v.by = req.staff.name; v.billedAt = now();
    addPoints(c, pts, `🧾 Order ₹${o.total} (${count} item) → +${pts} pts${tier.mult > 1 ? ` (${tier.name} ${tier.mult}x)` : ''}${dbl ? ' (Double Points Day!)' : ''}`, req.staff.name);
    save();
    return [200, { points: pts, total: o.total, name: c.name }];
  },

  'POST /api/admin/skip-visit': (req, b) => {
    const v = db.visits.find(x => x.id === b.visitId && x.status === 'pending');
    if (!v) return [404, { error: 'Visit nahi mila' }];
    v.status = 'billed'; save(); return [200, { ok: true }];
  },

  'POST /api/admin/verify': (req, b) => {
    expireRedemptions();
    const r = db.redemptions.find(x => x.code === String(b.code || '').trim() && x.status === 'pending');
    if (!r) return [404, { error: 'Code galat hai ya expire ho gaya' }];
    const c = db.customers.find(x => x.id === r.customerId);
    if (b.confirm) { r.status = 'done'; r.doneAt = now(); r.by = req.staff.name; db.ledger.push({ id: uid('l'), customerId: c.id, at: now(), delta: 0, note: `✅ ${r.rewardName} serve kiya gaya`, by: req.staff.name }); save(); }
    return [200, { rewardName: r.rewardName, name: c.name, mobile: c.mobile, confirmed: !!b.confirm }];
  },

  'GET /api/admin/customers': () => [200, db.customers.map(c => ({
    id: c.id, name: c.name, mobile: c.mobile, points: c.points, lifetimePoints: c.lifetimePoints,
    visits: c.visits, stamps: c.stamps, tier: tierOf(c).name, dob: c.dob, createdAt: c.createdAt, referralCode: c.referralCode
  })).reverse()],

  'POST /api/admin/adjust': (req, b) => {
    const c = db.customers.find(x => x.id === b.customerId);
    const d = Math.round(Number(b.delta));
    if (!c || !d) return [400, { error: 'Invalid' }];
    if (c.points + d < 0) return [400, { error: 'Points negative nahi ho sakte' }];
    addPoints(c, d, `🛠️ Manual adjust: ${String(b.note || 'by admin').slice(0, 60)}`, req.staff.name); save();
    return [200, { points: c.points }];
  },

  'GET /api/admin/menu': () => [200, db.menu],

  'POST /api/admin/menu': (req, b) => {
    if (!Array.isArray(b.items)) return [400, { error: 'Invalid' }];
    const clean = b.items.filter(m => String(m.name || '').trim() && Number(m.price) > 0).slice(0, 200).map(m => ({
      id: m.id && db.menu.some(x => x.id === m.id) ? m.id : uid('m'),
      category: String(m.category || 'Other').trim().slice(0, 30) || 'Other',
      emoji: String(m.emoji || '🍽️').slice(0, 4), name: String(m.name).trim().slice(0, 50),
      price: Math.round(Number(m.price)), points: Math.max(0, Math.round(Number(m.points) || 0)),
      veg: m.veg !== false, active: m.active !== false
    }));
    db.menu = clean; save();
    return [200, { ok: true, count: clean.length }];
  },

  'GET /api/admin/config': () => [200, { settings: db.settings, rewards: db.rewards }],

  'POST /api/admin/config': (req, b) => {
    const s = db.settings, n = b.settings || {};
    for (const k of ['pointsPer100', 'stampTarget', 'welcomeBonus', 'referralBonus', 'doublePointsDay', 'checkinCooldownHours'])
      if (n[k] !== undefined && !isNaN(Number(n[k]))) s[k] = Number(n[k]);
    for (const k of ['restaurantName', 'stampReward', 'publicUrl'])
      if (typeof n[k] === 'string') s[k] = n[k].trim().slice(0, 120);
    if (Array.isArray(b.rewards)) db.rewards = b.rewards.filter(r => r.name && Number(r.cost) > 0).slice(0, 30)
      .map(r => ({ id: r.id || uid('r'), emoji: String(r.emoji || '🎁').slice(0, 4), name: String(r.name).slice(0, 50), cost: Math.round(Number(r.cost)), active: r.active !== false }));
    save(); return [200, { ok: true }];
  }
};

// ---------- Setup-error mode: Supabase gadbad ho toh crash nahi, saaf page dikhao ----------
let setupError = null; // { title, fix, detail }
function diagnose(e) {
  const m = String(e && e.message || e);
  if (/publishable|anon/i.test(m)) return { title: 'Galat Supabase key', fix: 'Render → Environment mein SUPABASE_SERVICE_KEY ko Supabase ki <b>secret</b> key (sb_secret_...) ya <b>service_role</b> key se badliye. <b>anon/publishable</b> key kaam nahi karegi.', detail: m };
  if (/PGRST205|Could not find the table|relation .* does not exist|HTTP 404/i.test(m)) return { title: 'Supabase mein table nahi mili', fix: 'Supabase → <b>SQL Editor</b> kholiye, repo ki <code>supabase/schema.sql</code> paste karke <b>Run</b> kijiye. 30 second mein app apne aap chalu ho jayega.', detail: m };
  if (/HTTP 401|HTTP 403|Invalid API key|JWT/i.test(m)) return { title: 'Supabase key galat hai', fix: 'Render → Environment mein <b>SUPABASE_SERVICE_KEY</b> dobara copy-paste kijiye (Supabase → Project Settings → API Keys → secret / service_role). Aage-peeche space na ho.', detail: m };
  if (/timeout|aborted|HTTP 54\d|HTTP 50[234]/i.test(m)) return { title: 'Supabase jawab nahi de raha', fix: 'Supabase dashboard kholiye. Agar project <b>Paused</b> dikhe toh <b>Restore project</b> dabaiye (free projects 7 din use na hone par pause ho jaate hain). Saath hi <b>SUPABASE_URL</b> check kijiye: <code>https://&lt;project-id&gt;.supabase.co</code>.', detail: m };
  if (/fetch failed|ENOTFOUND|getaddrinfo|Invalid URL|ECONNREFUSED/i.test(m)) return { title: 'SUPABASE_URL galat hai', fix: 'Render → Environment mein <b>SUPABASE_URL</b> sirf itna hona chahiye: <code>https://&lt;project-id&gt;.supabase.co</code> (Supabase → Project Settings → API → Project URL).', detail: m };
  return { title: 'Supabase se connect nahi ho paaya', fix: 'SUPABASE_URL, SUPABASE_SERVICE_KEY aur app_state table check kijiye.', detail: m };
}
function setupPage(res, api) {
  if (api) return send(res, 503, { error: 'Setup adhoora: ' + setupError.title });
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '30' });
  res.end(`<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Setup baaki hai</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f3ee;color:#1f1611;display:grid;place-items:center;min-height:100vh;padding:16px}
.c{max-width:520px;background:#fff;border:1px solid #e8ddd1;border-radius:20px;padding:24px;box-shadow:0 6px 20px rgba(40,20,5,.08)}
h1{font-size:20px;margin:8px 0}.t{display:inline-block;background:#fbe9e6;color:#b3261e;font-weight:800;font-size:12px;padding:4px 10px;border-radius:99px}
p{line-height:1.55}code{background:#f1ebe3;padding:2px 6px;border-radius:6px}.d{font-size:12px;color:#8b7d72;word-break:break-all;background:#f7f3ee;padding:10px;border-radius:10px}
@media(prefers-color-scheme:dark){body{background:#14100d;color:#f6efe8}.c{background:#1e1915;border-color:#342b25}code,.d{background:#29221d}}</style></head>
<body><div class="c"><span class="t">⚙️ Setup baaki hai</span><h1>${setupError.title}</h1><p>${setupError.fix}</p><p class="d">Technical detail: ${String(setupError.detail).replace(/[<>&]/g, '')}</p><p style="font-size:13px;color:#8b7d72">Ye page har 30 second mein khud refresh hota hai. Theek hote hi app khul jayega. Aapka koi data nahi mita hai.</p></div></body></html>`);
}

// API route chalana (Render/local aur Vercel dono yahi use karte hain)
function apiDispatch(req, key, pathname, b) {
  const h = routes[key];
  if (!h) return [404, { error: 'Not found' }];
  if (pathname.startsWith('/api/admin/') && key !== 'POST /api/admin/login') {
    req.staff = staffFromReq(req);
    if (!req.staff) return [401, { error: 'Admin login required' }];
    if (OWNER_ONLY.has(key) && req.staff.role !== 'owner') return [403, { error: 'Ye kaam sirf Owner kar sakta hai' }];
  }
  return h(req, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, storage: SUPA ? 'supabase' : 'file', setupError: setupError ? setupError.title : null });
    if (setupError) return setupPage(res, url.pathname.startsWith('/api/'));
    if (url.pathname.startsWith('/api/')) {
      const b = req.method === 'POST' ? await body(req) : {};
      const [code, obj] = apiDispatch(req, key, url.pathname, b);
      return send(res, code, obj);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res, 'index.html');
    if (url.pathname === '/admin' || url.pathname === '/admin.html') return serveStatic(res, 'admin.html');
    if (url.pathname === '/favicon.ico') return serveStatic(res, 'favicon.svg');
    return serveStatic(res, url.pathname.slice(1));
  } catch (e) {
    console.error(e); send(res, 500, { error: 'Server error' });
  }
});

// ---------- Boot: data load → migrations → server start ----------
function prepareDb(loaded) {
  db = loaded;
  for (const k of ['customers', 'visits', 'redemptions', 'ledger']) if (!Array.isArray(db[k])) db[k] = [];
  for (const k of ['sessions', 'adminSessions']) if (!db[k] || typeof db[k] !== 'object') db[k] = {};
  if (!db.secret) db.secret = crypto.randomBytes(16).toString('hex');
  if (!Array.isArray(db.rewards)) db.rewards = DEFAULT_DATA().rewards;
  db.settings = { ...DEFAULT_DATA().settings, ...(db.settings || {}) };
  migrateMenu(); migrateStaff(); save();
}

// ---------- Vercel handler ----------
// Version-check write: sirf tab likho jab Supabase mein wahi version ho jo humne padha tha.
// Kisi aur request ne beech mein badla ho toh false → request dobara chalegi (kisi ka badlav nahi mitega).
async function writeVersioned() {
  const now = new Date().toISOString();
  const base = `${SUPA.url}/rest/v1/${SUPA.table}`;
  if (dbVersion) {
    const r = await fetch(`${base}?id=eq.${encodeURIComponent(SUPA.row)}&updated_at=eq.${encodeURIComponent(dbVersion)}`, {
      method: 'PATCH', headers: { ...supaHeaders(), Prefer: 'return=representation' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ data: db, updated_at: now })
    });
    if (!r.ok) throw new Error(`Supabase save fail (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).length > 0;
  }
  const r = await fetch(base, { method: 'POST', headers: { ...supaHeaders(), Prefer: 'return=minimal' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ id: SUPA.row, data: db, updated_at: now }) });
  if (r.status === 409) return false; // kisi aur ne pehle row bana di
  if (!r.ok) throw new Error(`Supabase save fail (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
  return true;
}
// Ek instance ke andar requests line mein (Vercel "Fluid compute" ek instance mein kai requests ek saath chala sakta hai,
// aur db/dbVersion global hain). Alag instances ke beech version-check takkar sambhalta hai.
let vercelQueue = Promise.resolve();
function vercelHandler(req, res) {
  const run = vercelQueue.then(() => vercelHandleOne(req, res));
  vercelQueue = run.catch(() => {});
  return run;
}
async function vercelHandleOne(req, res) {
  const url = new URL(req.url, 'http://x');
  // vercel.json rewrite "/api/:p*" → "/api/index?__p=:p*"; asli path wapas banao
  let pathname = url.pathname;
  if (url.searchParams.has('__p')) pathname = url.searchParams.get('__p') === '__healthz' ? '/healthz' : '/api/' + url.searchParams.get('__p');
  const key = `${req.method} ${pathname}`;
  try {
    if (!SUPA) { setupError = { title: 'Vercel par Supabase zaroori hai', fix: 'Vercel → Project → Settings → <b>Environment Variables</b> mein <b>SUPABASE_URL</b> aur <b>SUPABASE_SERVICE_KEY</b> daaliye, phir <b>Redeploy</b> kijiye. Vercel par data.json save nahi hota.', detail: 'SUPABASE_URL / SUPABASE_SERVICE_KEY missing' }; }
    if (pathname === '/healthz') return send(res, 200, { ok: true, storage: SUPA ? 'supabase' : 'none', host: 'vercel', setupError: setupError ? setupError.title : null });
    if (!SUPA) return setupPage(res, pathname.startsWith('/api/'));
    if (!pathname.startsWith('/api/')) {
      // backup: agar koi page request function tak aa jaye toh file khud bhejo
      if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
      if (pathname === '/admin' || pathname === '/admin.html') return serveStatic(res, 'admin.html');
      if (pathname === '/favicon.ico') return serveStatic(res, 'favicon.svg');
      return serveStatic(res, pathname.slice(1));
    }
    const b = req.method === 'POST' ? await body(req) : {};
    for (let attempt = 0; attempt < 8; attempt++) {
      let loaded;
      try { loaded = await loadDb(); } catch (e) { setupError = diagnose(e); return setupPage(res, true); }
      setupError = null; pendingWrite = false;
      const before = JSON.stringify(loaded);
      prepareDb(loaded);
      pendingWrite = JSON.stringify(db) !== before; // migrations ne kuch badla?
      const [code, obj] = apiDispatch(req, key, pathname, b);
      if (!pendingWrite) return send(res, code, obj);
      if (await writeVersioned()) return send(res, code, obj);
      await new Promise(r => setTimeout(r, Math.min(1500, 60 * 2 ** attempt) * (0.5 + Math.random()))); // takkar: badhte intezaar ke saath dobara
    }
    return send(res, 503, { error: 'Abhi bahut log ek saath hain, dobara try kijiye' });
  } catch (e) {
    console.error(e); return send(res, 500, { error: 'Server error' });
  }
}
if (ON_VERCEL) module.exports = vercelHandler;
async function tryLoad() {
  try {
    const loaded = await loadDb();
    const wasBroken = !!setupError;
    setupError = null;          // pehle clear, taaki prepareDb ka save() chale
    prepareDb(loaded);
    if (wasBroken) console.log('✅ Supabase connect ho gaya, app chalu.');
    return true;
  }
  catch (e) { setupError = diagnose(e); console.error('\n❌ ' + setupError.title + ' — ' + e.message + '\n   30 second baad dobara koshish...\n'); return false; }
}
if (!ON_VERCEL) (async function boot() {
  // PEHLE port kholo (Render ko turant "open port" dikhe), PHIR data load karo.
  // Load hone tak har request ko "shuru ho raha hai" page milta hai; fail ho toh setup page + 30s retry.
  setupError = { title: 'App shuru ho raha hai…', fix: 'Bas kuch second. Ye page apne aap refresh ho jayega.', detail: 'loading data' };
  server.listen(PORT, '0.0.0.0', async () => {
    if (!(await tryLoad())) { const t = setInterval(async () => { if (await tryLoad()) clearInterval(t); }, 30000); }
    console.log(`\n🍽️  ${db.settings.restaurantName} Loyalty server chal raha hai! (storage: ${SUPA ? 'Supabase' : 'data.json'})\n`);
    if (process.env.RENDER_EXTERNAL_URL) console.log(`  Live: ${process.env.RENDER_EXTERNAL_URL}   |   Admin: ${process.env.RENDER_EXTERNAL_URL}/admin`);
    console.log(`  Customer (is computer par): http://localhost:${PORT}`);
    console.log(`  Admin    (is computer par): http://localhost:${PORT}/admin   (pehla login: owner / 1234, phir password badlein)`);
    for (const u of lanUrls()) console.log(`  Same WiFi par phones ke liye: ${u}   |   Admin: ${u}/admin`);
    console.log('');
  });
})();
