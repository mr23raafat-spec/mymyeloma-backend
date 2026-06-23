'use strict';
/**
 * MyMyeloma Backend v5 — FINAL
 * ✅ Google Sheets as central database (no Drive storage quota issues)
 * ✅ Users registered from any device appear in admin panel
 * ✅ Admin login verified server-side
 * ✅ Pure node:crypto — no googleapis library needed
 */

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const fs      = require('fs');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────
const ADMIN_CODE  = process.env.ADMIN_CODE || 'MyMyeloma@2025';
const FOLDER_ID   = (process.env.DRIVE_FOLDER_ID || '').trim();
const ALLOWED     = (process.env.ALLOWED_ORIGINS ||
  'https://mymyelomcare.netlify.app,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173').trim();
const RESEND_KEY  = (process.env.RESEND_API_KEY  || '').trim();
const SESSION_SECRET = (process.env.SESSION_SECRET || ADMIN_CODE || 'change-me').trim();

// ─── CLOUDINARY CONFIG ────────────────────────────────────────────
const CLD_CLOUD  = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLD_KEY    = (process.env.CLOUDINARY_API_KEY    || '').trim();
const CLD_SECRET = (process.env.CLOUDINARY_API_SECRET || '').trim(); // resend.com free key

// ─── CREDENTIALS ─────────────────────────────────────────────────
function loadCreds() {
  const p = '/etc/secrets/service-account.json';
  if (fs.existsSync(p)) {
    const sa = JSON.parse(fs.readFileSync(p, 'utf8'));
    console.log('🔐 Credentials: Secret File');
    return { email: sa.client_email, key: sa.private_key };
  }
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  console.log('⚠️  Credentials: env vars');
  return { email: (process.env.GOOGLE_CLIENT_EMAIL || '').trim(), key };
}
const CREDS = loadCreds();

// ─── CORS ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const o  = req.headers.origin || '';
  const allowedOrigins = ALLOWED.split(',').map(a => a.trim()).filter(Boolean);
  const ok = !o || allowedOrigins.includes('*')
    || allowedOrigins.includes(o)
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  if (ok) res.setHeader('Access-Control-Allow-Origin', o || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '25mb' }));

// ─── JWT ──────────────────────────────────────────────────────────
function b64u(v) {
  return Buffer.from(typeof v === 'string' ? v : JSON.stringify(v))
    .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function makeJWT(scopes) {
  const now = Math.floor(Date.now()/1000);
  const h = b64u({alg:'RS256',typ:'JWT'});
  const p = b64u({iss:CREDS.email,sub:CREDS.email,scope:scopes.join(' '),
    aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600});
  const d = `${h}.${p}`;
  const s = crypto.createSign('RSA-SHA256');
  s.update(d); s.end();
  return `${d}.${s.sign(CREDS.key).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}`;
}

const TC = {t:null,e:0};
async function getToken() {
  if (TC.t && Date.now() < TC.e - 300000) return TC.t;
  const jwt  = makeJWT([
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
  ]);
  const body = Buffer.from(`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`);
  const d = await httpReq('POST','oauth2.googleapis.com','/token',body,
    {'Content-Type':'application/x-www-form-urlencoded'});
  if (!d.access_token) throw new Error('OAuth failed: '+JSON.stringify(d));
  TC.t = d.access_token;
  TC.e = Date.now()+(d.expires_in||3600)*1000;
  return TC.t;
}

// ─── HTTP ─────────────────────────────────────────────────────────
function httpReq(method, host, path, body, hdrs={}) {
  return new Promise((resolve, reject) => {
    const buf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(
      typeof body==='string' ? body : JSON.stringify(body))) : null;
    const r = https.request({hostname:host,path,method,
      headers:{'Content-Length':buf?buf.length:0,...hdrs}}, resp => {
      const cs=[];
      resp.on('data',c=>cs.push(c));
      resp.on('end',()=>{
        const raw=Buffer.concat(cs).toString();
        if(resp.statusCode>=400)
          return reject(new Error(`HTTP ${resp.statusCode} ${path}: ${raw.slice(0,500)}`));
        try{resolve(JSON.parse(raw))}catch{resolve(raw)};
      });
    });
    r.on('error',reject);
    if(buf) r.write(buf);
    r.end();
  });
}

function gApi(token, method, host, path, body) {
  const buf = body ? Buffer.from(JSON.stringify(body)) : null;
  return httpReq(method, host, path, buf, {
    'Authorization':'Bearer '+token,
    'Content-Type':'application/json',
    ...(buf?{'Content-Length':buf.length}:{})
  });
}

// ─── GOOGLE SHEETS DB ─────────────────────────────────────────────
// Sheet columns: id|name|email|phone|hosp|doc|status|regDate|passHash|data
const COLS   = ['id','name','email','phone','hosp','doc','status','regDate','passHash','data'];
const SHEET  = 'Users';
let   _sid   = (process.env.SHEET_ID||'').trim(); // cache

async function getSheetId(token) {
  if (_sid) return _sid;

  // Look for existing sheet in Drive folder
  if (FOLDER_ID) {
    const q = encodeURIComponent(
      `name='MyMyeloma_Users' and '${FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`
    );
    const r = await gApi(token,'GET','www.googleapis.com',`/drive/v3/files?q=${q}&fields=files(id,name)`);
    if (r.files?.length) { _sid = r.files[0].id; console.log('📊 Found sheet:', _sid); return _sid; }
  }

  // Create new spreadsheet
  const ss = await gApi(token,'POST','sheets.googleapis.com','/v4/spreadsheets',{
    properties: { title: 'MyMyeloma_Users' },
    sheets: [{ properties: { title: SHEET } }]
  });
  _sid = ss.spreadsheetId;
  console.log('📊 Created new sheet:', _sid);

  // Write header row
  await sheetsWrite(token, `${SHEET}!A1:J1`, [COLS]);

  // Move to folder
  if (FOLDER_ID) {
    await gApi(token,'PATCH','www.googleapis.com',
      `/drive/v3/files/${_sid}?addParents=${FOLDER_ID}&fields=id`,null);
  }
  return _sid;
}

async function sheetsRead(token, range) {
  const sid = await getSheetId(token);
  const r = await gApi(token,'GET','sheets.googleapis.com',
    `/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}`);
  return r.values || [];
}

async function sheetsWrite(token, range, values) {
  const sid = await getSheetId(token);
  return gApi(token,'PUT','sheets.googleapis.com',
    `/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {range, majorDimension:'ROWS', values});
}

async function sheetsAppend(token, values) {
  const sid = await getSheetId(token);
  return gApi(token,'POST','sheets.googleapis.com',
    `/v4/spreadsheets/${sid}/values/${encodeURIComponent(SHEET)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {majorDimension:'ROWS', values});
}

async function sheetsClearRow(token, rowIdx) {
  const sid = await getSheetId(token);
  return gApi(token,'POST','sheets.googleapis.com',
    `/v4/spreadsheets/${sid}/values/${encodeURIComponent(`${SHEET}!A${rowIdx}:J${rowIdx}`)}:clear`,{});
}

// Clear a full range (e.g. '2:2000')
async function sheetsClearRange(token, range) {
  const sid = await getSheetId(token);
  return gApi(token,'POST','sheets.googleapis.com',
    `/v4/spreadsheets/${sid}/values/${encodeURIComponent(`${SHEET}!A${range}:J${range}`)}:clear`,{});
}

function rowToUser(row) {
  if (!row?.[0]) return null;
  const u = {};
  COLS.forEach((c,i) => u[c] = row[i]||'');
  if (u.data) { try { Object.assign(u, JSON.parse(u.data)); } catch {} }
  delete u.data;
  return u;
}

function userToRow(u) {
  const extra = {
    labs: u.labs||[], chemo: u.chemo||[],
    meds: u.meds||[], visits: u.visits||[],
    files: (u.files||[]).map(f=>({id:f.id,name:f.name,type:f.type,desc:f.desc||'',size:f.size,uploadedAt:f.uploadedAt,driveFileId:f.driveFileId,driveLink:f.driveLink})),
    symptoms: u.symptoms||[], vitals: u.vitals||[],
    medLogs: (u.medLogs||[]).slice(-500), // keep last 500 entries
    shareCode: u.shareCode||'',
    settings: u.settings||{}, lastSync: u.lastSync||''
  };
  return [
    u.id||'', u.name||'',
    // ✅ FIX: دايماً احفظ الإيميل بـ lowercase
    (u.email||'').toLowerCase().trim(),
    u.phone||'',
    u.hosp||'', u.doc||'', u.status||'active',
    u.regDate||new Date().toISOString().split('T')[0],
    u.passHash||u.pass||'', JSON.stringify(extra)
  ];
}

async function getAllUsers(token) {
  const rows = await sheetsRead(token, `${SHEET}!A2:J2000`);
  return rows.map(rowToUser).filter(Boolean);
}

async function findUserRowIdx(token, userId) {
  const rows = await sheetsRead(token, `${SHEET}!A2:A2000`);
  for (let i=0; i<rows.length; i++) {
    if (rows[i][0]===userId) return i+2;
  }
  return -1;
}

async function findUserByEmail(token, email) {
  const rows = await sheetsRead(token, `${SHEET}!A2:J2000`);
  const needle = (email || '').toLowerCase().trim();
  for (const row of rows) {
    if ((row[2] || '').toLowerCase().trim() === needle) return { user: rowToUser(row), rowIdx: rows.indexOf(row)+2 };
  }
  return null;
}

async function findUserById(token, userId) {
  const rows = await sheetsRead(token, `${SHEET}!A2:J2000`);
  for (let i=0; i<rows.length; i++) {
    if (rows[i][0] === userId) return { user: rowToUser(rows[i]), rowIdx: i+2 };
  }
  return null;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function signToken(data) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
}

function getBearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function makeAdminToken(bucket = Math.floor(Date.now() / 3600000)) {
  return `adm.${bucket}.${signToken(`admin:${bucket}`)}`;
}

function verifyAdminToken(token) {
  if (!token) return false;
  const now = Math.floor(Date.now() / 3600000);

  if (token.startsWith('adm.')) {
    const [, bucketRaw, sig] = token.split('.');
    const bucket = Number(bucketRaw);
    if (!Number.isFinite(bucket) || Math.abs(now - bucket) > 1) return false;
    return safeEqual(sig, signToken(`admin:${bucket}`));
  }

  // Accept the previous one-piece token for one hour to avoid kicking out old tabs.
  return [now, now - 1].some(bucket =>
    safeEqual(token, crypto.createHmac('sha256', ADMIN_CODE).update('admin:'+bucket).digest('hex'))
  );
}

function requireAdmin(req, res, next) {
  if (!verifyAdminToken(getBearer(req))) {
    return res.status(401).json({ success:false, error:'جلسة الأدمن غير صالحة — سجّل الدخول مرة أخرى' });
  }
  req.isAdmin = true;
  next();
}

function makeUserToken(user) {
  const payload = b64u({ uid:user.id, exp:Date.now() + 1000*60*60*24*30 });
  const secretPart = user.passHash || user.pass || '';
  return `${payload}.${signToken(`user:${payload}:${secretPart}`)}`;
}

function decodePayload(payload) {
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

function safeUser(user) {
  return { ...user, passHash:undefined, pass:undefined };
}

async function requireUserOrAdmin(req, res, next) {
  try {
    const bearer = getBearer(req);
    if (verifyAdminToken(bearer)) {
      req.isAdmin = true;
      req.googleToken = await getToken();
      return next();
    }

    const [payload, sig] = (bearer || '').split('.');
    if (!payload || !sig) return res.status(401).json({ success:false, error:'يرجى تسجيل الدخول مرة أخرى' });

    const data = decodePayload(payload);
    if (!data.uid || !data.exp || Date.now() > data.exp) {
      return res.status(401).json({ success:false, error:'انتهت جلسة الدخول — سجّل الدخول مرة أخرى' });
    }

    const token = await getToken();
    const found = await findUserById(token, data.uid);
    if (!found) return res.status(401).json({ success:false, error:'المستخدم غير موجود' });

    const expected = signToken(`user:${payload}:${found.user.passHash || found.user.pass || ''}`);
    if (!safeEqual(sig, expected)) {
      return res.status(401).json({ success:false, error:'جلسة الدخول غير صالحة' });
    }

    req.googleToken = token;
    req.authUser = found.user;
    req.authRowIdx = found.rowIdx;
    next();
  } catch(e) {
    console.error('[auth]', e.message);
    res.status(401).json({ success:false, error:'تعذّر التحقق من الجلسة' });
  }
}

function requireSelfOrAdmin(req, res, userId) {
  if (req.isAdmin) return true;
  return req.authUser?.id && req.authUser.id === userId;
}

// ─── ROUTES ───────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status:'ok',
    service:'MyMyeloma Backend',
    health:'/api/health',
    version:'v5.1'
  });
});

// Health
app.get('/api/health', (req, res) => {
  const lines = (CREDS.key||'').split('\n').length;
  res.json({
    status:'ok', version:'v5.1', time:new Date().toISOString(),
    node:process.version, keyOk:lines>=25, sheetId:_sid||'(auto-create)',
    folder:FOLDER_ID
  });
});


// ─── IN-MEMORY OTP STORE (10 min expiry) ─────────────────────────────────
const otpStore = new Map(); // email → { code, exp }

// ─── EMAIL via Resend API ──────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) { console.warn('⚠️ RESEND_API_KEY missing — email not sent'); return false; }
  const body = Buffer.from(JSON.stringify({
    from: 'MyMyeloma Care <onboarding@resend.dev>',
    to:   [to], subject, html
  }));
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`,
                 'Content-Type': 'application/json', 'Content-Length': body.length }
    }, resp => {
      const cs = []; resp.on('data', c => cs.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode, body: Buffer.concat(cs).toString() }));
    });
    req.on('error', reject); req.write(body); req.end();
  });
  console.log(`📧 Email to ${to}: HTTP ${res.status}`);
  return res.status < 300;
}

// Forgot password — generate OTP, send email
app.post('/api/users/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'email required' });

    const token = await getToken();
    const found = await findUserByEmail(token, email);
    if (!found) return res.status(404).json({ success: false, error: 'البريد غير مسجّل' });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(email, { code, exp: Date.now() + 10 * 60 * 1000 });

    const sent = await sendEmail(email, '🔑 رمز استعادة كلمة السر — MyMyeloma Care', `
      <div dir="rtl" style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border-radius:12px;border:1px solid #eee">
        <h2 style="color:#1a73e8">MyMyeloma Care 🧬</h2>
        <p>مرحباً ${found.user.name}،</p>
        <p>طلبت استعادة كلمة السر. رمز التحقق الخاص بك:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#f0f4ff;border-radius:8px;color:#1a73e8">${code}</div>
        <p style="color:#666;font-size:13px">صالح لمدة 10 دقائق فقط. لا تشاركه مع أحد.</p>
        <hr/><p style="color:#999;font-size:11px">MyMyeloma Care — رعايتك الصحية في يدك</p>
      </div>
    `);

    if (sent) {
      res.json({ success: true, message: `تم إرسال الرمز إلى ${email}` });
    } else {
      // Fallback: return code in response (dev mode — no email key configured)
      res.json({ success: true, message: 'تم إنشاء الرمز', resetCode: code });
    }
  } catch (e) {
    console.error('[forgot-password]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Reset password — verify OTP, update hash in sheet
app.post('/api/users/reset-password', async (req, res) => {
  try {
    const { email, resetCode, newPassHash } = req.body;
    if (!email || !resetCode || !newPassHash)
      return res.status(400).json({ success: false, error: 'email, resetCode, newPassHash required' });

    const otp = otpStore.get(email);
    if (!otp || otp.code !== resetCode || Date.now() > otp.exp)
      return res.status(401).json({ success: false, error: 'رمز التحقق غير صحيح أو منتهي الصلاحية' });

    otpStore.delete(email);
    const token  = await getToken();
    const found  = await findUserByEmail(token, email);
    if (!found) return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });

    const { user, rowIdx } = found;
    user.passHash = newPassHash;
    const row = userToRow(user);
    await sheetsWrite(token, `${SHEET}!A${rowIdx}:J${rowIdx}`, [row]);

    res.json({ success: true, message: 'تم تغيير كلمة السر بنجاح ✓' });
  } catch (e) {
    console.error('[reset-password]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Admin login
app.post('/api/admin/verify', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({success:false,error:'Code required'});
  if (code !== ADMIN_CODE) return res.status(401).json({success:false,error:'رمز الأدمن غير صحيح'});
  const token = makeAdminToken();
  res.json({success:true, token, message:'مرحباً بالأدمن 🛡️'});
});

app.post('/api/admin/reset-password', async (req, res) => {
  try {
    const { adminCode, userId, newPassHash } = req.body || {};
    const authorized = verifyAdminToken(getBearer(req)) || (adminCode && adminCode === ADMIN_CODE);
    if (!authorized) return res.status(401).json({ success:false, error:'غير مصرح للأدمن' });
    if (!userId || !newPassHash) return res.status(400).json({ success:false, error:'userId and newPassHash required' });

    const token = await getToken();
    const found = await findUserById(token, userId);
    if (!found) return res.status(404).json({ success:false, error:'المستخدم غير موجود' });

    const user = { ...found.user, passHash:newPassHash };
    await sheetsWrite(token, `${SHEET}!A${found.rowIdx}:J${found.rowIdx}`, [userToRow(user)]);
    res.json({ success:true, message:'تم تغيير كلمة السر بنجاح ✓' });
  } catch(e) {
    console.error('[admin-reset-password]', e.message);
    res.status(500).json({ success:false, error:e.message });
  }
});

// Register new user (saves to Sheets immediately)
app.post('/api/users/register', async (req, res) => {
  try {
    const u = req.body;
    if (!u.id||!u.email||!u.name) return res.status(400).json({success:false,error:'id, email, name required'});

    const token = await getToken();

    // Check duplicate email (case-insensitive)
    const existing = await findUserByEmail(token, u.email);
    if (existing) return res.status(409).json({success:false,error:'البريد الإلكتروني مسجّل مسبقاً'});

    const row = userToRow({
      ...u,
      email: u.email.toLowerCase().trim(), // ✅ FIX
      status:'active',
      regDate:u.regDate||new Date().toISOString().split('T')[0]
    });
    await sheetsAppend(token, [row]);

    console.log(`✅ New user registered: ${u.name} <${u.email}>`);
    res.json({success:true, message:'تم التسجيل بنجاح ✓', userId:u.id, sessionToken:makeUserToken({...u, passHash:u.passHash||u.pass})});
  } catch(e) {
    console.error('[register]', e.message);
    res.status(500).json({success:false, error:e.message});
  }
});

// Login — verify password against sheet
app.post('/api/users/login', async (req, res) => {
  try {
    const { identifier, passHash } = req.body;
    if (!identifier||!passHash) return res.status(400).json({success:false,error:'identifier and passHash required'});

    const token = await getToken();
    const rows  = await sheetsRead(token, `${SHEET}!A2:J2000`);

    // ✅ بحث بالإيميل أولاً (الأثبت)، ثم بالاسم للتوافق مع القديم
    const id = identifier.toLowerCase().trim();
    let user = null;
    for (const row of rows) {
      if (row[2]?.toLowerCase().trim() === id) { user = rowToUser(row); break; }
    }
    // fallback: بحث بالاسم (للحسابات القديمة)
    if (!user) {
      for (const row of rows) {
        if (row[1]?.toLowerCase().trim() === id) { user = rowToUser(row); break; }
      }
    }

    if (!user) return res.status(401).json({success:false,error:'المستخدم غير موجود'});
    if (user.passHash!==passHash) return res.status(401).json({success:false,error:'كلمة السر غير صحيحة'});
    if (user.status==='blocked') return res.status(403).json({success:false,error:'الحساب محظور'});

    res.json({success:true, user:safeUser(user), sessionToken:makeUserToken(user), message:'مرحباً بك ✓'});
  } catch(e) {
    console.error('[login]', e.message);
    res.status(500).json({success:false, error:e.message});
  }
});

// Get single user by ID (for cross-device sync)
app.get('/api/users/:id', requireUserOrAdmin, async (req, res) => {
  try {
    if (!requireSelfOrAdmin(req, res, req.params.id)) {
      return res.status(403).json({ success:false, error:'غير مصرح لهذا المستخدم' });
    }
    const found = await findUserById(req.googleToken, req.params.id);
    if (!found) return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    res.json({ success: true, user: safeUser(found.user) });
  } catch (e) {
    console.error('[user-get]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get all users (admin)
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const token = await getToken();
    const users = await getAllUsers(token);
    const safe  = users.map(safeUser);
    res.json({success:true, users:safe, count:safe.length});
  } catch(e) {
    console.error('[users]', e.message);
    res.status(500).json({success:false, error:e.message});
  }
});

// Update user data (labs, meds, chemo, visits, etc.)
app.post('/api/users/update', requireUserOrAdmin, async (req, res) => {
  try {
    const u = req.body;
    if (!u.id) return res.status(400).json({success:false,error:'id required'});
    if (!requireSelfOrAdmin(req, res, u.id)) {
      return res.status(403).json({ success:false, error:'غير مصرح بتعديل هذا المستخدم' });
    }

    const found = await findUserById(req.googleToken, u.id);
    const existing = found?.user || {};
    const merged = {
      ...existing,
      ...u,
      id: existing.id || u.id,
      email: (existing.email || u.email || '').toLowerCase().trim(),
      passHash: req.isAdmin ? (u.passHash || existing.passHash || '') : (existing.passHash || ''),
      status: req.isAdmin ? (u.status || existing.status || 'active') : (existing.status || 'active')
    };
    if (!req.isAdmin) delete merged.pass;

    const row = userToRow(merged);
    if (found?.rowIdx>0) {
      await sheetsWrite(req.googleToken, `${SHEET}!A${found.rowIdx}:J${found.rowIdx}`, [row]);
    } else {
      await sheetsAppend(req.googleToken, [row]);
    }
    res.json({success:true, message:'تم تحديث البيانات ✓'});
  } catch(e) {
    console.error('[update]', e.message);
    res.status(500).json({success:false, error:e.message});
  }
});

// Block / unblock
app.post('/api/users/block', requireAdmin, async (req, res) => {
  try {
    const { userId, status } = req.body;
    const token  = await getToken();
    const rowIdx = await findUserRowIdx(token, userId);
    if (rowIdx<0) return res.status(404).json({success:false,error:'User not found'});
    await sheetsWrite(token, `${SHEET}!G${rowIdx}`, [[status||'blocked']]);
    res.json({success:true, message:'تم تحديث الحالة ✓'});
  } catch(e) {
    console.error('[block]', e.message);
    res.status(500).json({success:false, error:e.message});
  }
});

// Delete user
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const token  = await getToken();
    const rowIdx = await findUserRowIdx(token, req.params.id);
    if (rowIdx>0) await sheetsClearRow(token, rowIdx);
    res.json({success:true, message:'تم الحذف ✓'});
  } catch(e) {
    console.error('[delete]', e.message);
    res.status(500).json({success:false, error:e.message});
  }
});

// Sync all (legacy endpoint — rewrites sheet)
app.post('/api/drive/sync-all', requireAdmin, async (req, res) => {
  try {
    const { content } = req.body;
    const users = Array.isArray(content) ? content : [];
    const token = await getToken();
    const existingUsers = await getAllUsers(token);
    const mergedUsers = users.map(u => {
      const existing = existingUsers.find(e => e.id === u.id || e.email === u.email) || {};
      return {
        ...existing,
        ...u,
        id:u.id || existing.id,
        email:(u.email || existing.email || '').toLowerCase().trim(),
        passHash:u.passHash || existing.passHash || '',
        files:u.files || existing.files || [],
        status:u.status || existing.status || 'active'
      };
    });
    const sid2 = await getSheetId(token);
    await gApi(token,'POST','sheets.googleapis.com',
      `/v4/spreadsheets/${sid2}/values/${encodeURIComponent(`${SHEET}!A2:J2000`)}:clear`,{}); // clear data rows
    if (mergedUsers.length) await sheetsAppend(token, mergedUsers.map(u=>userToRow({...u})));
    res.json({success:true, count:mergedUsers.length, message:`تمت مزامنة ${mergedUsers.length} مستخدم ✓`});
  } catch(e) {
    console.error('[sync-all]', e.message);
    res.status(500).json({success:false, error:e.message});
  }
});

// Upload single user (legacy endpoint — updates sheet)
app.post('/api/drive/upload', requireUserOrAdmin, async (req, res) => {
  try {
    const { content, userId } = req.body;
    if (!content) return res.status(400).json({success:false,error:'content required'});
    const id     = content.id || userId;
    if (!requireSelfOrAdmin(req, res, id)) {
      return res.status(403).json({ success:false, error:'غير مصرح بتعديل هذا المستخدم' });
    }
    const found = await findUserById(req.googleToken, id);
    const row = userToRow({
      ...(found?.user || {}),
      ...content,
      id,
      passHash:req.isAdmin ? (content.passHash || found?.user?.passHash || '') : (found?.user?.passHash || ''),
      status:req.isAdmin ? (content.status || found?.user?.status || 'active') : (found?.user?.status || 'active'),
      pass:undefined
    });
    if (found?.rowIdx>0) await sheetsWrite(req.googleToken, `${SHEET}!A${found.rowIdx}:J${found.rowIdx}`, [row]);
    else await sheetsAppend(req.googleToken, [row]);
    res.json({success:true, message:'تم الحفظ في Sheets ✓'});
  } catch(e) {
    console.error('[upload]', e.message);
    res.status(500).json({success:false, error:e.message});
  }
});

// Drive list / sheet info
app.get('/api/drive/list', requireAdmin, async (req, res) => {
  try {
    const token = await getToken();
    const sid   = await getSheetId(token);
    const users = await getAllUsers(token);
    res.json({
      success:true, sheetId:sid,
      sheetUrl:`https://docs.google.com/spreadsheets/d/${sid}`,
      userCount:users.length,
      files:[{id:sid,name:'MyMyeloma_Users (Google Sheet)',type:'spreadsheet'}]
    });
  } catch(e) {
    console.error('[list]', e.message);
    res.status(500).json({success:false, error:e.message});
  }
});


// ─── GOOGLE DRIVE FILE STORAGE ────────────────────────────────────────────

// ─── CLOUDINARY HELPERS ──────────────────────────────────────────
function cldSign(params) {
  // Build sorted query string then SHA1
  const str = Object.keys(params).sort()
    .map(k => `${k}=${params[k]}`).join('&') + CLD_SECRET;
  return crypto.createHash('sha1').update(str).digest('hex');
}

function cldRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${CLD_KEY}:${CLD_SECRET}`).toString('base64');
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'api.cloudinary.com',
      path,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const rq = https.request(opts, resp => {
      const cs = []; resp.on('data', c => cs.push(c));
      resp.on('end', () => {
        const raw = Buffer.concat(cs).toString();
        if (resp.statusCode >= 400) return reject(new Error(`Cloudinary ${resp.statusCode}: ${raw.slice(0,300)}`));
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    rq.on('error', reject); rq.write(data); rq.end();
  });
}

// Upload file to Cloudinary (base64)
app.post('/api/drive/file-upload', requireUserOrAdmin, async (req, res) => {
  try {
    const { fileName, mimeType, base64Data } = req.body;
    const userId = req.body.userId || req.authUser?.id;
    if (!base64Data || !fileName) return res.status(400).json({ success: false, error: 'fileName and base64Data required' });
    if (!requireSelfOrAdmin(req, res, userId)) {
      return res.status(403).json({ success:false, error:'غير مصرح برفع ملف لهذا المستخدم' });
    }
    if (!CLD_CLOUD || !CLD_KEY || !CLD_SECRET)
      return res.status(503).json({ success: false, error: 'Cloudinary غير مضبوط في البيئة' });

    const timestamp  = Math.floor(Date.now() / 1000);
    const publicId   = `mymyeloma/${userId || 'u'}/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const resourceType = (mimeType || '').startsWith('image/') ? 'image' : 'raw';
    const sigParams  = { public_id: publicId, timestamp };
    const signature  = cldSign(sigParams);

    // POST multipart to Cloudinary upload API
    const boundary = 'mm_cld_' + Date.now();
    const addPart  = (name, value) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;

    const parts = Buffer.concat([
      Buffer.from(addPart('api_key',   CLD_KEY)),
      Buffer.from(addPart('timestamp', timestamp)),
      Buffer.from(addPart('public_id', publicId)),
      Buffer.from(addPart('signature', signature)),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"\r\n\r\n`),
      Buffer.from(`data:${mimeType || 'application/octet-stream'};base64,${base64Data}`),
      Buffer.from(`\r\n--${boundary}--`)
    ]);

    const d = await new Promise((resolve, reject) => {
      const rq = https.request({
        hostname: 'api.cloudinary.com',
        path: `/v1_1/${CLD_CLOUD}/${resourceType}/upload`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': parts.length
        }
      }, resp => {
        const cs = []; resp.on('data', c => cs.push(c));
        resp.on('end', () => {
          const raw = Buffer.concat(cs).toString();
          if (resp.statusCode >= 400) return reject(new Error(`Cloudinary upload HTTP ${resp.statusCode}: ${raw.slice(0,300)}`));
          try { resolve(JSON.parse(raw)); } catch { resolve({}); }
        });
      });
      rq.on('error', reject); rq.write(parts); rq.end();
    });

    console.log(`☁️ Cloudinary upload: ${d.public_id} by ${userId || '?'}`);
    res.json({ success: true, fileId: d.public_id, fileName, viewLink: d.secure_url });
  } catch (e) {
    console.error('[file-upload]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Proxy/download file from Cloudinary
app.get('/api/drive/file/:fileId(*)', async (req, res) => {
  try {
    const publicId = req.params.fileId;
    const isImage  = /\.(jpg|jpeg|png|gif|webp)$/i.test(publicId);
    const isPDF    = /\.pdf$/i.test(publicId) || publicId.includes('.pdf');
    const resourceType = isImage ? 'image' : 'raw';
    const url = `https://res.cloudinary.com/${CLD_CLOUD}/${resourceType}/upload/${publicId}`;

    // اضبط الـ Content-Type الصح
    let contentType = 'application/octet-stream';
    if (isPDF)   contentType = 'application/pdf';
    else if (/\.png$/i.test(publicId))  contentType = 'image/png';
    else if (/\.(jpg|jpeg)$/i.test(publicId)) contentType = 'image/jpeg';

    // اسم الملف من آخر جزء في الـ publicId
    const rawName = publicId.split('/').pop() || 'file';
    const fileName = decodeURIComponent(rawName);

    https.get(url, remote => {
      const finalType = remote.headers['content-type'] || contentType;
      res.setHeader('Content-Type', finalType);
      res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
      if (remote.headers['content-length'])
        res.setHeader('Content-Length', remote.headers['content-length']);
      remote.pipe(res);
      remote.on('error', () => { if(!res.headersSent) res.status(500).end(); });
    }).on('error', e => { if(!res.headersSent) res.status(500).json({ error: e.message }); });
  } catch (e) {
    console.error('[file-download]', e.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: e.message });
  }
});

// Delete file from Cloudinary
app.delete('/api/drive/file/:fileId(*)', requireUserOrAdmin, async (req, res) => {
  try {
    const publicId   = req.params.fileId;
    if (!req.isAdmin) {
      const ownsFile = (req.authUser?.files || []).some(f => f.driveFileId === publicId);
      if (!ownsFile) return res.status(403).json({ success:false, error:'غير مصرح بحذف هذا الملف' });
    }
    const timestamp  = Math.floor(Date.now() / 1000);
    const isImage    = /\.(jpg|jpeg|png|gif|webp)$/i.test(publicId);
    const resourceType = isImage ? 'image' : 'raw';
    const signature  = cldSign({ public_id: publicId, timestamp });
    await cldRequest('POST', `/v1_1/${CLD_CLOUD}/${resourceType}/destroy`, {
      public_id: publicId, api_key: CLD_KEY, timestamp, signature
    });
    res.json({ success: true, message: 'تم حذف الملف ✓' });
  } catch (e) {
    console.error('[file-delete]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── SHARE CODE (مشاركة مع المرافق / QR) ────────────────────────
// GET /api/users/share/:code — بيرجع بيانات المريض للمرافق بدون باسورد
app.get('/api/users/share/:code', async (req, res) => {
  try {
    const code = (req.params.code || '').toUpperCase().trim();
    if (!code) return res.status(400).json({ success: false, error: 'كود مطلوب' });

    const token = await getToken();
    const users = await getAllUsers(token);
    const user  = users.find(u => (u.shareCode || '').toUpperCase() === code);

    if (!user)
      return res.status(404).json({ success: false, error: 'الكود غير صحيح أو منتهي الصلاحية' });

    // أرجع فقط البيانات المسموح بمشاركتها — بدون باسورد أو إيميل أو id
    res.json({
      success: true,
      patient: {
        name:      user.name,
        hosp:      user.hosp,
        doc:       user.doc,
        phone:     user.phone,
        meds:      user.meds      || [],
        chemo:     user.chemo     || [],
        labs:      user.labs      || [],
        visits:    user.visits    || [],
        symptoms:  user.symptoms  || [],
        vitals:    user.vitals    || [],
        shareCode: user.shareCode || ''
      }
    });
  } catch (e) {
    console.error('[share]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── RESTORE (alias for login — same result) ──────────────────────
// POST /api/users/restore — نفس login بالظبط، موجود عشان الـ frontend بيكاله
app.post('/api/users/restore', async (req, res) => {
  try {
    const { identifier, passHash } = req.body;
    if (!identifier || !passHash)
      return res.status(400).json({ success: false, error: 'identifier و passHash مطلوبين' });

    const token = await getToken();
    const rows  = await sheetsRead(token, `${SHEET}!A2:J2000`);
    const id    = identifier.toLowerCase().trim();
    let user    = null;

    for (const row of rows) {
      if (row[2]?.toLowerCase().trim() === id || row[1]?.toLowerCase().trim() === id) {
        user = rowToUser(row); break;
      }
    }

    if (!user)     return res.status(401).json({ success: false, error: 'المستخدم غير موجود' });
    if (user.passHash !== passHash)
      return res.status(401).json({ success: false, error: 'كلمة السر غير صحيحة' });
    if (user.status === 'blocked')
      return res.status(403).json({ success: false, error: 'الحساب محظور' });

    res.json({ success: true, user: safeUser(user), sessionToken:makeUserToken(user), message: '✓ تم استرداد البيانات' });
  } catch (e) {
    console.error('[restore]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const lines = (CREDS.key||'').split('\n').length;
  console.log(`🧬 MyMyeloma Backend v5 — port ${PORT}`);
  console.log(`📧 Email: ${CREDS.email||'MISSING'}`);
  console.log(`🔑 Key: ${CREDS.key?'LOADED ✓':'MISSING ✗'} (${lines} lines)`);
  console.log(`📁 Folder: ${FOLDER_ID||'(none)'}`);
  console.log(`📊 Sheet: ${_sid||'(auto-create on first request)'}`);
  console.log(`🟢 Node: ${process.version}`);
});
