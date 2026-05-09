/**
 * MyMyeloma Backend — v3
 * Fix: "DECODER routines::unsupported"
 * Solution: Build JWT + call Google APIs manually using node:crypto
 *           (bypasses googleapis library entirely — no OpenSSL issues)
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ─── ENV VARS ─────────────────────────────────────────────────────
function fixKey(k) {
  if (!k) return '';
  return k.replace(/\\n/g, '\n').trim();
}

const CLIENT_EMAIL   = (process.env.GOOGLE_CLIENT_EMAIL || '').trim();
const PRIVATE_KEY    = fixKey(process.env.GOOGLE_PRIVATE_KEY || '');
const DRIVE_FOLDER   = (process.env.DRIVE_FOLDER_ID  || '').trim();
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGINS  || '*').trim();

// ─── CORS ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin  = req.headers.origin || '';
  const allowed = ALLOWED_ORIGIN.split(',').map(s => s.trim());
  const ok = !origin
    || allowed.includes('*')
    || allowed.some(o => origin.startsWith(o))
    || origin.includes('localhost');

  if (ok) res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ─── JWT BUILDER ──────────────────────────────────────────────────
function b64url(str) {
  return Buffer.from(typeof str === 'string' ? str : JSON.stringify(str))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJWT(email, pemKey, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url({ alg: 'RS256', typ: 'JWT' });
  const pay = b64url({
    iss:   email,
    scope: Array.isArray(scopes) ? scopes.join(' ') : scopes,
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  });
  const data   = hdr + '.' + pay;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  signer.end();
  const sig = signer.sign(pemKey)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return data + '.' + sig;
}

// ─── OAUTH TOKEN ──────────────────────────────────────────────────
const tokenCache = { token: null, exp: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 300000) {
    return tokenCache.token;
  }
  const jwt  = makeJWT(CLIENT_EMAIL, PRIVATE_KEY, ['https://www.googleapis.com/auth/drive']);
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const data = await post('oauth2.googleapis.com', '/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded'
  });
  if (!data.access_token) throw new Error('OAuth failed: ' + JSON.stringify(data));
  tokenCache.token = data.access_token;
  tokenCache.exp   = Date.now() + (data.expires_in || 3600) * 1000;
  return tokenCache.token;
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────
function request(method, host, path, bodyBuf, headers) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: host, path, method,
      headers: { 'Content-Length': bodyBuf ? bodyBuf.length : 0, ...headers }
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} ${path}: ${raw.slice(0, 400)}`));
        }
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function post(host, path, body, headers = {}) {
  const buf = Buffer.from(body);
  return request('POST', host, path, buf, {
    'Content-Type': 'application/json', ...headers
  });
}

async function driveGet(token, path) {
  return request('GET', 'www.googleapis.com', path, null, {
    Authorization: 'Bearer ' + token
  });
}

// Multipart upload (create file with content in one request)
function driveMultipart(token, method, path, meta, mediaBuf, mimeType) {
  const bound = 'mymb_' + Date.now();
  const parts  = Buffer.concat([
    Buffer.from(`--${bound}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(JSON.stringify(meta)),
    Buffer.from(`\r\n--${bound}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    mediaBuf,
    Buffer.from(`\r\n--${bound}--`)
  ]);
  return request(method, 'www.googleapis.com', path, parts, {
    Authorization:  'Bearer ' + token,
    'Content-Type': `multipart/related; boundary=${bound}`
  });
}

// Simple media-only PATCH (update content of existing file)
function drivePatch(token, fileId, buf, mimeType) {
  return request('PATCH', 'www.googleapis.com',
    `/upload/drive/v3/files/${fileId}?uploadType=media`,
    buf,
    { Authorization: 'Bearer ' + token, 'Content-Type': mimeType }
  );
}

// ─── DRIVE HELPERS ────────────────────────────────────────────────
async function findFile(token, folderId, name) {
  const q = encodeURIComponent(`name='${name.replace(/'/g,"\\'")}' and '${folderId}' in parents and trashed=false`);
  const r = await driveGet(token, `/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`);
  return r.files?.[0] || null;
}

async function upsertJSON(token, folderId, name, content) {
  const buf      = Buffer.from(JSON.stringify(content, null, 2));
  const existing = await findFile(token, folderId, name);

  if (existing) {
    const r = await drivePatch(token, existing.id, buf, 'application/json');
    return { fileId: r.id || existing.id, action: 'updated', name };
  }

  const r = await driveMultipart(
    token, 'POST',
    '/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    { name, parents: [folderId], mimeType: 'application/json' },
    buf, 'application/json'
  );
  return { fileId: r.id, webViewLink: r.webViewLink, action: 'created', name };
}

// ─── ROUTES ───────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const lines = PRIVATE_KEY.split('\n').length;
  res.json({
    status: 'ok',
    time:   new Date().toISOString(),
    node:   process.version,
    creds:  { email: !!CLIENT_EMAIL, keyLines: lines, keyOk: lines >= 25 },
    folder: DRIVE_FOLDER
  });
});

app.get('/api/drive/list', async (req, res) => {
  try {
    const token = await getToken();
    const q     = encodeURIComponent(`'${DRIVE_FOLDER}' in parents and trashed=false`);
    const data  = await driveGet(token, `/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime,size)&pageSize=20`);
    res.json({ success: true, files: data.files || [], count: data.files?.length || 0 });
  } catch (e) {
    console.error('[list]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/drive/upload', async (req, res) => {
  try {
    const { fileName, content, folderId } = req.body;
    if (!fileName || content === undefined) {
      return res.status(400).json({ success: false, error: 'fileName and content required' });
    }
    const token  = await getToken();
    const folder = folderId || DRIVE_FOLDER;
    const safe   = { ...content, pass: undefined };
    const result = await upsertJSON(token, folder, fileName, safe);
    res.json({
      success: true, ...result,
      message: `${result.action === 'updated' ? 'تحديث' : 'رفع'} ${fileName} ✓`
    });
  } catch (e) {
    console.error('[upload]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/drive/sync-all', async (req, res) => {
  try {
    const { fileName, content, folderId } = req.body;
    if (!content) return res.status(400).json({ success: false, error: 'content required' });

    const token  = await getToken();
    const folder = folderId || DRIVE_FOLDER;
    const name   = fileName || `MM_AllUsers_${new Date().toISOString().split('T')[0]}.json`;

    const master = await upsertJSON(token, folder, name, content);

    // Individual user files — batches of 5
    const users   = Array.isArray(content) ? content : [];
    const results = [];
    for (let i = 0; i < users.length; i += 5) {
      const settled = await Promise.allSettled(
        users.slice(i, i + 5).map(u =>
          upsertJSON(token, folder, `user_${u.id}.json`, { ...u, pass: undefined })
        )
      );
      settled.forEach((r, j) => {
        const u = users[i + j];
        results.push(r.status === 'fulfilled'
          ? { id: u.id, name: u.name, ok: true }
          : { id: u.id, name: u.name, ok: false, error: r.reason?.message });
      });
    }

    const ok  = results.filter(r => r.ok).length;
    const bad = results.filter(r => !r.ok).length;
    res.json({
      success: true, master,
      total: users.length, synced: ok, failed: bad, results,
      message: `تمت مزامنة ${ok}/${users.length} مستخدم ✓`
    });
  } catch (e) {
    console.error('[sync-all]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/drive/upload-file', async (req, res) => {
  try {
    const { name, mimeType, folderId, userId, base64 } = req.body;
    if (!name || !base64) return res.status(400).json({ success: false, error: 'name and base64 required' });

    const token  = await getToken();
    const folder = folderId || DRIVE_FOLDER;
    const buf    = Buffer.from(base64, 'base64');
    const mime   = mimeType || 'application/octet-stream';

    const r = await driveMultipart(
      token, 'POST',
      '/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
      { name, parents: [folder], mimeType: mime, appProperties: { userId: userId || '' } },
      buf, mime
    );
    res.json({ success: true, fileId: r.id, webViewLink: r.webViewLink });
  } catch (e) {
    console.error('[upload-file]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const lines = PRIVATE_KEY.split('\n').length;
  console.log(`🧬 MyMyeloma Backend v3 on port ${PORT}`);
  console.log(`📁 Drive Folder: ${DRIVE_FOLDER}`);
  console.log(`📧 Client Email: ${CLIENT_EMAIL}`);
  console.log(`🔑 Private Key: ${PRIVATE_KEY ? 'LOADED ✓' : 'MISSING ✗'} (${lines} lines)`);
  console.log(`🟢 Node: ${process.version} | No googleapis — pure crypto ⚡`);
});
