'use strict';
/**
 * MyMyeloma Backend v5 — FINAL (Fixed)
 * ✅ Google Sheets as central database
 * ✅ Case-insensitive login (email & name)
 * ✅ Email always saved as lowercase
 * ✅ Share code route for caregivers (QR)
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
const ADMIN_CODE = process.env.ADMIN_CODE || 'MyMyeloma@2025';
const FOLDER_ID  = (process.env.DRIVE_FOLDER_ID  || '').trim();
const ALLOWED    = (process.env.ALLOWED_ORIGINS   || '*').trim();
const RESEND_KEY = (process.env.RESEND_API_KEY    || '').trim();

// ─── CREDENTIALS ─────────────────────────────────────────────────
function loadCreds() {
  const p = '/etc/secrets/service-account.json';
  if (fs.existsSync(p)) {
    const sa = JSON.parse(fs.readFileSync(p, 'utf8'));
    console.log('🔑 Credentials: Secret File');
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
  const ok = !o || ALLOWED.includes('*')
    || ALLOWED.split(',').some(a => o.startsWith(a.trim()))
    || o.includes('localhost') || o.includes('netlify.app') || o.includes('onrender.com');
  if (ok) res.setHeader('Access-Control-Allow-Origin', o || '*');
  res.setHeader('Access-Control-Allow-Methods',  'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',  'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age',        '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '25mb' }));

// ─── JWT ──────────────────────────────────────────────────────────
function b64u(v) {
  return Buffer.from(typeof v === 'string' ? v : JSON.stringify(v))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function makeJWT(scopes) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg: 'RS256', typ: 'JWT' });
  const p = b64u({
    iss: CREDS.email, sub: CREDS.email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  });
  const d = `${h}.${p}`;
  const s = crypto.createSign('RSA-SHA256');
  s.update(d); s.end();
  return `${d}.${s.sign(CREDS.key).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}`;
}

const TC = { t: null, e: 0 };
async function getToken() {
  if (TC.t && Date.now() < TC.e - 300000) return TC.t;
  const jwt = makeJWT([
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
  ]);
  const body = Buffer.from(
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  );
  const d = await httpReq('POST', 'oauth2.googleapis.com', '/token', body,
    { 'Content-Type': 'application/x-www-form-urlencoded' });
  if (!d.access_token) throw new Error('OAuth failed: ' + JSON.stringify(d));
  TC.t = d.access_token;
  TC.e = Date.now() + (d.expires_in || 3600) * 1000;
  return TC.t;
}

// ─── HTTP ─────────────────────────────────────────────────────────
function httpReq(method, host, path, body, hdrs = {}) {
  return new Promise((resolve, reject) => {
    const buf = body
      ? (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      : null;
    const r = https.request({
      hostname: host, path, method,
      headers: { 'Content-Length': buf ? buf.length : 0, ...hdrs }
    }, resp => {
      const cs = [];
      resp.on('data', c => cs.push(c));
      resp.on('end', () => {
        const raw = Buffer.concat(cs).toString();
        if (resp.statusCode >= 400)
          return reject(new Error(`HTTP ${resp.statusCode} ${path}: ${raw.slice(0, 500)}`));
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    r.on('error', reject);
    if (buf) r.write(buf);
    r.end();
  });
}

function gApi(token, method, host, path, body) {
  const buf = body ? Buffer.from(JSON.stringify(body)) : null;
  return httpReq(method, host, path, buf, {
    'Authorization': 'Bearer ' + token,
    'Content-Type':  'application/json',
    ...(buf ? { 'Content-Length': buf.length } : {})
  });
}

// ─── GOOGLE SHEETS DB ─────────────────────────────────────────────
// Sheet columns: id | name | email | phone | hosp | doc | status | regDate | passHash | data
const COLS  = ['id', 'name', 'email', 'phone', 'hosp', 'doc', 'status', 'regDate', 'passHash', 'data'];
const SHEET = 'Users';
let _sid    = (process.env.SHEET_ID || '').trim();

async function getSheetId(token) {
  if (_sid) return _sid;

  if (FOLDER_ID) {
    const q = encodeURIComponent(
      `name='MyMyeloma_Users' and '${FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.spreadsheet'`
    );
    const r = await gApi(token, 'GET', 'www.googleapis.com',
      `/drive/v3/files?q=${q}&fields=files(id)`);
    if (r.files?.length) {
      _sid = r.files[0].id;
      console.log('📊 Found sheet:', _sid);
      return _sid;
    }
  }

  const ss = await gApi(token, 'POST', 'sheets.googleapis.com', '/v4/spreadsheets', {
    properties: { title: 'MyMyeloma_Users' },
    sheets:     [{ properties: { title: SHEET } }]
  });
  _sid = ss.spreadsheetId;
  console.log('📊 Created new sheet:', _sid);

  await sheetsWrite(token, `${SHEET}!A1:J1`, [COLS]);

  if (FOLDER_ID) {
    await gApi(token, 'PATCH', 'www.googleapis.com',
      `/drive/v3/files/${_sid}?addParents=${FOLDER_ID}&fields=id`, null);
  }
  return _sid;
}

async function sheetsRead(token, range) {
  const sid = await getSheetId(token);
  const r   = await gApi(token, 'GET', 'sheets.googleapis.com',
    `/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}`);
  return r.values || [];
}

async function sheetsWrite(token, range, values) {
  const sid = await getSheetId(token);
  return gApi(token, 'PUT', 'sheets.googleapis.com',
    `/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { range, majorDimension: 'ROWS', values });
}

async function sheetsAppend(token, values) {
  const sid = await getSheetId(token);
  return gApi(token, 'POST', 'sheets.googleapis.com',
    `/v4/spreadsheets/${sid}/values/${encodeURIComponent(SHEET)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { majorDimension: 'ROWS', values });
}

async function sheetsClearRow(token, rowIdx) {
  const sid = await getSheetId(token);
  return gApi(token, 'POST', 'sheets.googleapis.com',
    `/v4/spreadsheets/${sid}/values/${encodeURIComponent(`${SHEET}!A${rowIdx}:J${rowIdx}`)}:clear`, {});
}

// ─── ROW HELPERS ─────────────────────────────────────────────────
function rowToUser(row) {
  if (!row?.[0]) return null;
  const u = {};
  COLS.forEach((c, i) => u[c] = row[i] || '');
  if (u.data) { try { Object.assign(u, JSON.parse(u.data)); } catch {} }
  delete u.data;
  return u;
}

function userToRow(u) {
  const extra = {
    labs:      u.labs      || [],
    chemo:     u.chemo     || [],
    meds:      u.meds      || [],
    visits:    u.visits    || [],
    files:     (u.files    || []).map(f => ({
      id: f.id, name: f.name, type: f.type, size: f.size, uploadedAt: f.uploadedAt
    })),
    symptoms:  u.symptoms  || [],
    vitals:    u.vitals    || [],
    medLogs:   (u.medLogs  || []).slice(-500),
    shareCode: u.shareCode || '',
    settings:  u.settings  || {},
    lastSync:  u.lastSync  || ''
  };
  return [
    u.id       || '',
    u.name     || '',
    // ✅ FIX: دايماً احفظ الإيميل بـ lowercase
    (u.email   || '').toLowerCase().trim(),
    u.phone    || '',
    u.hosp     || '',
    u.doc      || '',
    u.status   || 'active',
    u.regDate  || new Date().toISOString().split('T')[0],
    u.passHash || u.pass || '',
    JSON.stringify(extra)
  ];
}

async function getAllUsers(token) {
  const rows = await sheetsRead(token, `${SHEET}!A2:J2000`);
  return rows.map(rowToUser).filter(Boolean);
}

async function findUserRowIdx(token, userId) {
  const rows = await sheetsRead(token, `${SHEET}!A2:A2000`);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === userId) return i + 2;
  }
  return -1;
}

async function findUserByEmail(token, email) {
  const rows = await sheetsRead(token, `${SHEET}!A2:J2000`);
  for (const row of rows) {
    if (row[2]?.toLowerCase() === email?.toLowerCase().trim()) {
      return { user: rowToUser(row), rowIdx: rows.indexOf(row) + 2 };
    }
  }
  return null;
}

// ─── EMAIL via Resend ─────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) { console.warn('⚠️  RESEND_API_KEY missing — email not sent'); return false; }
  const body = Buffer.from(JSON.stringify({
    from:    'MyMyeloma Care <onboarding@resend.dev>',
    to:      [to],
    subject, html
  }));
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: {
        'Authorization':  `Bearer ${RESEND_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': body.length
      }
    }, resp => {
      const cs = [];
      resp.on('data', c => cs.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode, body: Buffer.concat(cs).toString() }));
    });
    req.on('error', reject); req.write(body); req.end();
  });
  console.log(`📧 Email to ${to}: HTTP ${res.status}`);
  return res.status < 300;
}

// ─── IN-MEMORY OTP STORE (10 min) ────────────────────────────────
const otpStore = new Map(); // email → { code, exp }

// ─── ROUTES ───────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  const lines = (CREDS.key || '').split('\n').length;
  res.json({
    status: 'ok', version: 'v5-fixed', time: new Date().toISOString(),
    node: process.version, keyOk: lines >= 25,
    sheetId: _sid || '(auto-create)', folder: FOLDER_ID
  });
});

// ─── Admin login ──────────────────────────────────────────────────
app.post('/api/admin/verify', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ success: false, error: 'Code required' });
  if (code !== ADMIN_CODE) return res.status(401).json({ success: false, error: 'كود الأدمن غير صحيح' });
  const token = crypto.createHmac('sha256', ADMIN_CODE)
    .update('admin:' + Math.floor(Date.now() / 3600000)).digest('hex');
  res.json({ success: true, token, message: 'مرحباً بالأدمن 👑' });
});

// ─── Register ─────────────────────────────────────────────────────
app.post('/api/users/register', async (req, res) => {
  try {
    const u = req.body;
    if (!u.id || !u.email || !u.name)
      return res.status(400).json({ success: false, error: 'id, email, name مطلوبين' });

    const token = await getToken();

    // ✅ FIX: تحقق من الإيميل بعد lowercase
    const existing = await findUserByEmail(token, u.email);
    if (existing)
      return res.status(409).json({ success: false, error: 'البريد الإلكتروني مسجّل مسبقاً' });

    const row = userToRow({
      ...u,
      email:   u.email.toLowerCase().trim(), // ✅ FIX
      status:  'active',
      regDate: u.regDate || new Date().toISOString().split('T')[0]
    });
    await sheetsAppend(token, [row]);
    console.log(`✅ New user registered: ${u.name} <${u.email.toLowerCase()}>`);
    res.json({ success: true, message: '✓ تم التسجيل بنجاح', userId: u.id });
  } catch (e) {
    console.error('[register]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Login ────────────────────────────────────────────────────────
// ✅ FIX: مقارنة case-insensitive للإيميل والاسم
app.post('/api/users/login', async (req, res) => {
  try {
    const { identifier, passHash } = req.body;
    if (!identifier || !passHash)
      return res.status(400).json({ success: false, error: 'identifier و passHash مطلوبين' });

    const token = await getToken();
    const rows  = await sheetsRead(token, `${SHEET}!A2:J2000`);

    // ✅ FIX: normalize الـ identifier قبل المقارنة
    const id = identifier.toLowerCase().trim();
    let user  = null;

    for (const row of rows) {
      const emailMatch = row[2]?.toLowerCase().trim() === id;
      const nameMatch  = row[1]?.toLowerCase().trim() === id;
      if (emailMatch || nameMatch) {
        user = rowToUser(row);
        break;
      }
    }

    if (!user)
      return res.status(401).json({ success: false, error: 'المستخدم غير موجود' });
    if (user.passHash !== passHash)
      return res.status(401).json({ success: false, error: 'كلمة السر غير صحيحة' });
    if (user.status === 'blocked')
      return res.status(403).json({ success: false, error: 'الحساب محظور' });

    const safeUser = { ...user, passHash: undefined, pass: undefined };
    res.json({ success: true, user: safeUser, message: '✓ مرحباً بك' });
  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Forgot Password (OTP) ────────────────────────────────────────
app.post('/api/users/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'email مطلوب' });

    const token = await getToken();
    const found = await findUserByEmail(token, email);
    if (!found) return res.status(404).json({ success: false, error: 'البريد غير مسجّل' });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(email.toLowerCase(), { code, exp: Date.now() + 10 * 60 * 1000 });

    const sent = await sendEmail(
      email,
      'رمز استعادة كلمة السر — MyMyeloma Care 🔐',
      `<div dir="rtl" style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e0e0e0;border-radius:12px">
        <h2 style="color:#1a73e8">MyMyeloma Care 🧬</h2>
        <p>مرحباً ${found.user.name}،</p>
        <p>طلبت استعادة كلمة السر. رمز التحقق الخاص بك:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#f5f5f5;border-radius:8px;margin:16px 0">${code}</div>
        <p style="color:#666;font-size:13px">صالح لمدة 10 دقائق فقط. لا تشاركه مع أحد.</p>
        <hr/><p style="color:#999;font-size:11px">MyMyeloma Care — رعايتك الصحية في يدك</p>
      </div>`
    );

    if (sent) {
      res.json({ success: true, message: `تم إرسال الرمز إلى ${email}` });
    } else {
      // Dev mode fallback
      res.json({ success: true, message: 'تم إنشاء الرمز', resetCode: code });
    }
  } catch (e) {
    console.error('[forgot-password]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Reset Password ───────────────────────────────────────────────
app.post('/api/users/reset-password', async (req, res) => {
  try {
    const { email, resetCode, newPassHash } = req.body;
    if (!email || !resetCode || !newPassHash)
      return res.status(400).json({ success: false, error: 'email, resetCode, newPassHash مطلوبين' });

    const key = email.toLowerCase();
    const otp = otpStore.get(key);
    if (!otp || otp.code !== resetCode || Date.now() > otp.exp)
      return res.status(401).json({ success: false, error: 'رمز التحقق غير صحيح أو منتهي الصلاحية' });

    otpStore.delete(key);

    const token = await getToken();
    const found = await findUserByEmail(token, email);
    if (!found) return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });

    const { user, rowIdx } = found;
    user.passHash = newPassHash;
    const row = userToRow(user);
    await sheetsWrite(token, `${SHEET}!A${rowIdx}:J${rowIdx}`, [row]);
    res.json({ success: true, message: '✓ تم تغيير كلمة السر بنجاح' });
  } catch (e) {
    console.error('[reset-password]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Get all users (admin) ────────────────────────────────────────
app.get('/api/users', async (req, res) => {
  try {
    const token = await getToken();
    const users = await getAllUsers(token);
    const safe  = users.map(u => ({ ...u, passHash: undefined, pass: undefined }));
    res.json({ success: true, users: safe, count: safe.length });
  } catch (e) {
    console.error('[users]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Update user data ─────────────────────────────────────────────
app.post('/api/users/update', async (req, res) => {
  try {
    const u = req.body;
    if (!u.id) return res.status(400).json({ success: false, error: 'id مطلوب' });

    const token  = await getToken();
    const rowIdx = await findUserRowIdx(token, u.id);
    const row    = userToRow(u);

    if (rowIdx > 0) {
      await sheetsWrite(token, `${SHEET}!A${rowIdx}:J${rowIdx}`, [row]);
    } else {
      await sheetsAppend(token, [row]);
    }
    res.json({ success: true, message: '✓ تم تحديث البيانات' });
  } catch (e) {
    console.error('[update]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Block / Unblock ──────────────────────────────────────────────
app.post('/api/users/block', async (req, res) => {
  try {
    const { userId, status } = req.body;
    const token  = await getToken();
    const rowIdx = await findUserRowIdx(token, userId);
    if (rowIdx < 0) return res.status(404).json({ success: false, error: 'User not found' });
    await sheetsWrite(token, `${SHEET}!G${rowIdx}`, [[status || 'blocked']]);
    res.json({ success: true, message: '✓ تم تحديث الحالة' });
  } catch (e) {
    console.error('[block]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Delete user ──────────────────────────────────────────────────
app.delete('/api/users/:id', async (req, res) => {
  try {
    const token  = await getToken();
    const rowIdx = await findUserRowIdx(token, req.params.id);
    if (rowIdx > 0) await sheetsClearRow(token, rowIdx);
    res.json({ success: true, message: '✓ تم الحذف' });
  } catch (e) {
    console.error('[delete]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── ✅ NEW: Share Code (المرافق / QR) ───────────────────────────
// المرافق يدخل الكود → يشوف ملخص المريض بدون باسورد
app.get('/api/users/share/:code', async (req, res) => {
  try {
    const code = (req.params.code || '').toUpperCase().trim();
    if (!code) return res.status(400).json({ success: false, error: 'كود مطلوب' });

    const token = await getToken();
    const users = await getAllUsers(token);
    const user  = users.find(u => (u.shareCode || '').toUpperCase() === code);

    if (!user)
      return res.status(404).json({ success: false, error: 'الكود غير صحيح أو منتهي الصلاحية' });

    // أرجع فقط البيانات المسموح بمشاركتها
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
        // ❌ لا passHash، لا email، لا id
      }
    });
  } catch (e) {
    console.error('[share]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Sync all (legacy) ────────────────────────────────────────────
app.post('/api/drive/sync-all', async (req, res) => {
  try {
    const { content } = req.body;
    const users = Array.isArray(content) ? content : [];
    const token = await getToken();
    const sid2  = await getSheetId(token);
    await gApi(token, 'POST', 'sheets.googleapis.com',
      `/v4/spreadsheets/${sid2}/values/${encodeURIComponent(`${SHEET}!A2:J2000`)}:clear`, {});
    if (users.length) await sheetsAppend(token, users.map(u => userToRow({ ...u })));
    res.json({ success: true, count: users.length, message: `✓ تمت مزامنة ${users.length} مستخدم` });
  } catch (e) {
    console.error('[sync-all]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Upload single user (legacy) ─────────────────────────────────
app.post('/api/drive/upload', async (req, res) => {
  try {
    const { content, userId } = req.body;
    if (!content) return res.status(400).json({ success: false, error: 'content مطلوب' });

    const token  = await getToken();
    const id     = content.id || userId;
    const rowIdx = await findUserRowIdx(token, id);
    const row    = userToRow({ ...content, pass: undefined });

    if (rowIdx > 0) await sheetsWrite(token, `${SHEET}!A${rowIdx}:J${rowIdx}`, [row]);
    else await sheetsAppend(token, [row]);
    res.json({ success: true, message: '✓ تم الحفظ في Sheets' });
  } catch (e) {
    console.error('[upload]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Drive list / sheet info ──────────────────────────────────────
app.get('/api/drive/list', async (req, res) => {
  try {
    const token = await getToken();
    const sid   = await getSheetId(token);
    const users = await getAllUsers(token);
    res.json({
      success:    true,
      sheetId:    sid,
      sheetUrl:   `https://docs.google.com/spreadsheets/d/${sid}`,
      userCount:  users.length,
      files:      [{ id: sid, name: 'MyMyeloma_Users (Google Sheet)', type: 'spreadsheet' }]
    });
  } catch (e) {
    console.error('[list]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── File upload to Drive ─────────────────────────────────────────
app.post('/api/drive/file-upload', async (req, res) => {
  try {
    const { fileName, mimeType, base64Data, userId } = req.body;
    if (!base64Data || !fileName)
      return res.status(400).json({ success: false, error: 'fileName و base64Data مطلوبين' });
    if (!FOLDER_ID)
      return res.status(503).json({ success: false, error: 'DRIVE_FOLDER_ID غير مضبوط في البيئة' });

    const token    = await getToken();
    const buffer   = Buffer.from(base64Data, 'base64');
    const mime     = mimeType || 'application/octet-stream';
    const boundary = '-------mm_boundary_' + Date.now();
    const metaPart = JSON.stringify({ name: fileName, parents: [FOLDER_ID] });

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaPart}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--`)
    ]);

    const d = await new Promise((resolve, reject) => {
      const rq = https.request({
        hostname: 'www.googleapis.com',
        path:     '/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,size',
        method:   'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  `multipart/related; boundary=${boundary}`,
          'Content-Length': body.length
        }
      }, resp => {
        const cs = [];
        resp.on('data', c => cs.push(c));
        resp.on('end', () => {
          const raw = Buffer.concat(cs).toString();
          if (resp.statusCode >= 400) return reject(new Error(`Drive upload HTTP ${resp.statusCode}: ${raw}`));
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        });
      });
      rq.on('error', reject); rq.write(body); rq.end();
    });

    console.log(`📁 File uploaded: ${d.id} (${fileName}) by user ${userId || '?'}`);
    res.json({ success: true, fileId: d.id, fileName: d.name, viewLink: d.webViewLink });
  } catch (e) {
    console.error('[file-upload]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Download/proxy file from Drive ──────────────────────────────
app.get('/api/drive/file/:fileId', async (req, res) => {
  try {
    const token  = await getToken();
    const { fileId } = req.params;
    const meta   = await gApi(token, 'GET', 'www.googleapis.com',
      `/drive/v3/files/${fileId}?fields=name,mimeType,size`);

    await new Promise((resolve, reject) => {
      https.get({
        hostname: 'www.googleapis.com',
        path:     `/drive/v3/files/${fileId}?alt=media`,
        headers:  { 'Authorization': `Bearer ${token}` }
      }, resp => {
        res.setHeader('Content-Type',        meta.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(meta.name)}"`);
        if (meta.size) res.setHeader('Content-Length', meta.size);
        resp.pipe(res);
        resp.on('end', resolve); resp.on('error', reject);
      }).on('error', reject);
    });
  } catch (e) {
    console.error('[file-download]', e.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Delete file from Drive ───────────────────────────────────────
app.delete('/api/drive/file/:fileId', async (req, res) => {
  try {
    const token = await getToken();
    await gApi(token, 'DELETE', 'www.googleapis.com',
      `/drive/v3/files/${req.params.fileId}`, null);
    res.json({ success: true, message: '✓ تم حذف الملف' });
  } catch (e) {
    console.error('[file-delete]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const lines = (CREDS.key || '').split('\n').length;
  console.log(`🧬 MyMyeloma Backend v5-fixed — port ${PORT}`);
  console.log(`📧 Email:  ${CREDS.email  || 'MISSING'}`);
  console.log(`🔑 Key:    ${CREDS.key    ? 'LOADED ✓' : 'MISSING ✗'} (${lines} lines)`);
  console.log(`📁 Folder: ${FOLDER_ID    || '(none)'}`);
  console.log(`📊 Sheet:  ${_sid         || '(auto-create on first request)'}`);
  console.log(`🟢 Node:   ${process.version}`);
});
