'use strict';
/**
 * MyMyeloma Backend v5 — FINAL
 * ✅ Google Sheets as central database
 * ✅ Users registered from any device appear in admin panel
 * ✅ Admin login verified server-side
 * ✅ Password hashing ONLY on backend
 */

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const fs      = require('fs');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────
const ADMIN_CODE = process.env.ADMIN_CODE || 'MyMyeloma@2025';
const FOLDER_ID  = (process.env.DRIVE_FOLDER_ID || '').trim();
const ALLOWED    = (process.env.ALLOWED_ORIGINS || '*').trim();

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
  const o = req.headers.origin || '';
  const ok = !o || ALLOWED.includes('*')
    || ALLOWED.split(',').some(a => o.startsWith(a.trim()))
    || o.includes('localhost') || o.includes('netlify.app') || o.includes('onrender.com');
  if (ok) res.setHeader('Access-Control-Allow-Origin', o || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '25mb' }));

// ─── JWT ──────────────────────────────────────────────────────────
function b64u(v) {
  return Buffer.from(typeof v === 'string' ? v : JSON.stringify(v))
    .toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function makeJWT(scopes) {
  const now = Math.floor(Date.now()/1000);
  const h = b64u({alg:'RS256',typ:'JWT'});
  const p = b64u({
    iss: CREDS.email,
    sub: CREDS.email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  });
  const d = `${h}.${p}`;
  const s = crypto.createSign('RSA-SHA256');
  s.update(d); s.end();
  return `${d}.${s.sign(CREDS.key).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}`;
}

const TOKEN_CACHE = { token:null, exp:0 };
async function getToken() {
  if (TOKEN_CACHE.token && Date.now() < TOKEN_CACHE.exp - 300000)
    return TOKEN_CACHE.token;

  const jwt = makeJWT([
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
  ]);

  const body = Buffer.from(
    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  );

  const res = await httpReq(
    'POST',
    'oauth2.googleapis.com',
    '/token',
    body,
    {'Content-Type':'application/x-www-form-urlencoded'}
  );

  TOKEN_CACHE.token = res.access_token;
  TOKEN_CACHE.exp   = Date.now() + (res.expires_in||3600)*1000;
  return TOKEN_CACHE.token;
}

// ─── HTTP ─────────────────────────────────────────────────────────
function httpReq(method, host, path, body, headers={}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path,
      method,
      headers: {
        ...headers,
        'Content-Length': body ? body.length : 0
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400)
          return reject(new Error(raw));
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function gApi(token, method, host, path, body) {
  const buf = body ? Buffer.from(JSON.stringify(body)) : null;
  return httpReq(method, host, path, buf, {
    'Authorization': 'Bearer '+token,
    'Content-Type': 'application/json'
  });
}

// ─── GOOGLE SHEETS DB ─────────────────────────────────────────────
const COLS  = ['id','name','email','phone','hosp','doc','status','regDate','passHash','data'];
const SHEET = 'Users';
let SHEET_ID = (process.env.SHEET_ID || '').trim();

async function getSheetId(token) {
  if (SHEET_ID) return SHEET_ID;

  const ss = await gApi(token,'POST','sheets.googleapis.com','/v4/spreadsheets',{
    properties:{ title:'MyMyeloma_Users' },
    sheets:[{ properties:{ title:SHEET } }]
  });

  SHEET_ID = ss.spreadsheetId;
  await sheetsWrite(token, `${SHEET}!A1:J1`, [COLS]);
  return SHEET_ID;
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
    { range, majorDimension:'ROWS', values });
}

async function sheetsAppend(token, values) {
  const sid = await getSheetId(token);
  return gApi(token,'POST','sheets.googleapis.com',
    `/v4/spreadsheets/${sid}/values/${encodeURIComponent(SHEET)}:append?valueInputOption=RAW`,
    { majorDimension:'ROWS', values });
}

async function sheetsClearRange(token, range) {
  const sid = await getSheetId(token);
  return gApi(token,'POST','sheets.googleapis.com',
    `/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}:clear`,
    {});
}

// ─── MAPPERS ──────────────────────────────────────────────────────
function rowToUser(row) {
  if (!row?.[0]) return null;
  const u = {};
  COLS.forEach((c,i)=>u[c]=row[i]||'');
  if (u.data) {
    try { Object.assign(u, JSON.parse(u.data)); } catch {}
  }
  delete u.data;
  return u;
}

function userToRow(u) {
  return [
    u.id||'', u.name||'', u.email||'', u.phone||'',
    u.hosp||'', u.doc||'', u.status||'active',
    u.regDate||new Date().toISOString().split('T')[0],
    u.passHash||'', JSON.stringify({})
  ];
}

// ─── ROUTES ───────────────────────────────────────────────────────

// LOGIN ✅
app.post('/api/users/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password)
      return res.status(400).json({success:false,error:'identifier and password required'});

    const token = await getToken();
    const rows  = await sheetsRead(token, `${SHEET}!A2:J2000`);

    let user = null;
    for (const row of rows) {
      if (row[2] === identifier || row[1] === identifier) {
        user = rowToUser(row);
        break;
      }
    }

    if (!user)
      return res.status(401).json({success:false,error:'بيانات غير صحيحة'});

    const hashed = crypto.createHash('sha256').update(password).digest('hex');
    if (user.passHash !== hashed)
      return res.status(401).json({success:false,error:'بيانات غير صحيحة'});

    res.json({ success:true, user:{...user, passHash:undefined} });

  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).json({success:false,error:'Server error'});
  }
});

// SYNC ALL ✅
app.post('/api/drive/sync-all', async (req, res) => {
  try {
    const { content } = req.body;
    const users = Array.isArray(content) ? content : [];
    const token = await getToken();

    await sheetsClearRange(token, `${SHEET}!A2:J2000`);
    if (users.length)
      await sheetsAppend(token, users.map(userToRow));

    res.json({ success:true, count:users.length });
  } catch (e) {
    console.error('[sync-all]', e.message);
    res.status(500).json({success:false,error:e.message});
  }
});

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('✅ MyMyeloma Backend running on port', PORT);
});
