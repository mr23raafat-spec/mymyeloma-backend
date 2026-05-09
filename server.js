/**
 * MyMyeloma Backend Server
 * Fixes: DECODER routines::unsupported (Private Key format issue in Render)
 */

const express    = require('express');
const cors       = require('cors');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── PRIVATE KEY FIX ─────────────────────────────────────────────
// Render stores env vars as single-line strings.
// The private key needs real newlines, not literal \n characters.
function fixPrivateKey(key) {
  if (!key) return '';
  // If key already has real newlines, return as-is
  if (key.includes('\n') && !key.includes('\\n')) return key;
  // Replace literal \n with real newlines
  return key.replace(/\\n/g, '\n');
}

const PRIVATE_KEY    = fixPrivateKey(process.env.GOOGLE_PRIVATE_KEY || '');
const CLIENT_EMAIL   = process.env.GOOGLE_CLIENT_EMAIL || '';
const DRIVE_FOLDER   = process.env.DRIVE_FOLDER_ID     || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGINS     || '*';

// ─── MIDDLEWARES ──────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    // Allow configured origins + localhost for dev
    const allowed = ALLOWED_ORIGIN.split(',').map(s => s.trim());
    if (!origin || allowed.includes('*') || allowed.includes(origin) || origin.includes('localhost')) {
      cb(null, true);
    } else {
      cb(new Error('CORS: Origin not allowed — ' + origin));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// ─── GOOGLE AUTH ──────────────────────────────────────────────────
function getAuth() {
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    throw new Error('Google credentials not configured in environment variables');
  }
  return new google.auth.JWT({
    email: CLIENT_EMAIL,
    key:   PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
}

function getDrive() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

// ─── HELPER: Find or Create File ─────────────────────────────────
async function findOrCreateFile(drive, folderId, fileName) {
  // Search for existing file with this name in folder
  const search = await drive.files.list({
    q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id,name)',
    spaces: 'drive'
  });
  return search.data.files?.[0]?.id || null;
}

// ─── HELPER: Upsert JSON File ────────────────────────────────────
async function upsertJsonFile(drive, folderId, fileName, content) {
  const { Readable } = require('stream');
  const jsonStr = JSON.stringify(content, null, 2);

  // Wrap string in a Node.js readable stream
  const toStream = (str) => {
    const s = new Readable();
    s.push(str);
    s.push(null);
    return s;
  };

  const existingId = await findOrCreateFile(drive, folderId, fileName);

  if (existingId) {
    // Update existing file
    const res = await drive.files.update({
      fileId: existingId,
      media: { mimeType: 'application/json', body: toStream(jsonStr) },
      fields: 'id,webViewLink'
    });
    return { fileId: res.data.id, webViewLink: res.data.webViewLink, action: 'updated' };
  } else {
    // Create new file
    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
        mimeType: 'application/json'
      },
      media: { mimeType: 'application/json', body: toStream(jsonStr) },
      fields: 'id,webViewLink'
    });
    return { fileId: res.data.id, webViewLink: res.data.webViewLink, action: 'created' };
  }
}

// ─── ROUTES ──────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    drive:     !!CLIENT_EMAIL && !!PRIVATE_KEY,
    folder:    DRIVE_FOLDER
  });
});

// Test Drive connection
app.get('/api/drive/list', async (req, res) => {
  try {
    const drive = getDrive();
    const result = await drive.files.list({
      q:      `'${DRIVE_FOLDER}' in parents and trashed=false`,
      fields: 'files(id,name,modifiedTime,size)',
      pageSize: 20
    });
    res.json({ success: true, files: result.data.files || [] });
  } catch (e) {
    console.error('[drive/list]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Upload / update a single user file
app.post('/api/drive/upload', async (req, res) => {
  try {
    const { userId, fileName, content, folderId } = req.body;
    if (!fileName || !content) {
      return res.status(400).json({ success: false, error: 'fileName and content are required' });
    }

    const targetFolder = folderId || DRIVE_FOLDER;
    const drive        = getDrive();
    const safeContent  = { ...content, pass: undefined }; // never store passwords

    const result = await upsertJsonFile(drive, targetFolder, fileName, safeContent);

    res.json({
      success:     true,
      fileId:      result.fileId,
      webViewLink: result.webViewLink,
      action:      result.action,
      message:     `تم ${result.action === 'updated' ? 'تحديث' : 'إنشاء'} ملف ${fileName} بنجاح ✓`
    });
  } catch (e) {
    console.error('[drive/upload]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Sync all users (admin bulk upload)
app.post('/api/drive/sync-all', async (req, res) => {
  try {
    const { fileName, content, folderId } = req.body;
    if (!content) return res.status(400).json({ success: false, error: 'content is required' });

    const targetFolder = folderId || DRIVE_FOLDER;
    const drive        = getDrive();

    // Save the all_users file
    const allFile = await upsertJsonFile(
      drive, targetFolder,
      fileName || `MM_AllUsers_${new Date().toISOString().split('T')[0]}.json`,
      content
    );

    // Also save individual files for each user
    const results = [];
    if (Array.isArray(content)) {
      for (const user of content) {
        try {
          const r = await upsertJsonFile(
            drive, targetFolder,
            `user_${user.id}.json`,
            { ...user, pass: undefined }
          );
          results.push({ id: user.id, name: user.name, fileId: r.fileId, ok: true });
        } catch (e2) {
          results.push({ id: user.id, name: user.name, error: e2.message, ok: false });
        }
      }
    }

    res.json({
      success:  true,
      fileId:   allFile.fileId,
      count:    Array.isArray(content) ? content.length : 1,
      results,
      message:  `تمت مزامنة ${Array.isArray(content) ? content.length : 1} مستخدم بنجاح ✓`
    });
  } catch (e) {
    console.error('[drive/sync-all]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Upload a file binary (PDF/image) to Drive
app.post('/api/drive/upload-file', async (req, res) => {
  try {
    // Use multer for multipart form
    const multer = require('multer');
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

    upload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ success: false, error: err.message });
      if (!req.file) return res.status(400).json({ success: false, error: 'No file provided' });

      const { userId, fileId, folderId } = req.body;
      const drive      = getDrive();
      const targetFolder = folderId || DRIVE_FOLDER;

      const { Readable } = require('stream');
      const stream = new Readable();
      stream.push(req.file.buffer);
      stream.push(null);

      const result = await drive.files.create({
        requestBody: {
          name:    req.file.originalname,
          parents: [targetFolder],
          appProperties: { userId, fileId }
        },
        media: { mimeType: req.file.mimetype, body: stream },
        fields: 'id,webViewLink'
      });

      res.json({
        success:     true,
        fileId:      result.data.id,
        webViewLink: result.data.webViewLink,
        message:     'تم رفع الملف بنجاح ✓'
      });
    });
  } catch (e) {
    console.error('[drive/upload-file]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🧬 MyMyeloma Backend running on port ${PORT}`);
  console.log(`📁 Drive Folder: ${DRIVE_FOLDER}`);
  console.log(`📧 Client Email: ${CLIENT_EMAIL}`);
  console.log(`🔑 Private Key: ${PRIVATE_KEY ? 'LOADED ✓' : 'MISSING ✗'}`);
  if (PRIVATE_KEY) {
    const lines = PRIVATE_KEY.split('\n').length;
    console.log(`   Key lines: ${lines} ${lines > 5 ? '✓' : '✗ (might be malformed)'}`);
  }
});
