// backend/server.js
// ⚠️ هذا الخادم ضروري لاستخدام المفتاح الخاص بأمان

require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Security middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:8000'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// File upload config (for PDF/images)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    if(allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('نوع الملف غير مدعوم'), false);
  }
});

// Google Drive Auth with Service Account
const auth = new google.auth.GoogleAuth({
  credentials: {
    type: 'service_account',
    project_id: process.env.GCLOUD_PROJECT,
    private_key_id: process.env.GCLOUD_PRIVATE_KEY_ID,
    private_key: process.env.GCLOUD_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.GCLOUD_CLIENT_EMAIL,
    client_id: process.env.GCLOUD_CLIENT_ID,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: process.env.GCLOUD_CLIENT_X509_URL,
    universe_domain: 'googleapis.com'
  },
  scopes: ['https://www.googleapis.com/auth/drive.file']
});

const drive = google.drive({ version: 'v3', auth });

const FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// ═══════════════════════════════════════════════════════════════
// 📡 API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Upload JSON data to Drive
app.post('/api/drive/upload', async (req, res) => {
  try{
    const { userId, fileName, content, folderId = FOLDER_ID } = req.body;
    
    const fileMetadata = {
      name: fileName,
      parents: [folderId],
      mimeType: 'application/json',
      appProperties: { userId, uploadedBy: 'mymyeloma-app' }
    };
    
    const media = {
      mimeType: 'application/json',
      body: JSON.stringify(content, null, 2)
    };
    
    const file = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, name, webViewLink, createdTime'
    });
    
    console.log(`✅ Uploaded: ${fileName} (${file.data.id})`);
    res.json({ 
      success: true, 
      fileId: file.data.id, 
      webViewLink: file.data.webViewLink,
      message: 'تم الرفع بنجاح'
    });
    
  } catch(err){
    console.error('❌ Upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Upload file (PDF/Image) to Drive
app.post('/api/drive/upload-file', upload.single('file'), async (req, res) => {
  try{
    if(!req.file) throw new Error('No file uploaded');
    
    const { userId, fileId, folderId = FOLDER_ID } = req.body;
    const fileName = `MM_${userId}_${fileId}_${req.file.originalname}`;
    
    const fileMetadata = {
      name: fileName,
      parents: [folderId],
      appProperties: { userId, fileId, uploadedBy: 'mymyeloma-app' }
    };
    
    const media = {
      mimeType: req.file.mimetype,
      body: req.file.buffer
    };
    
    const file = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, name, webViewLink, webContentLink'
    });
    
    // Make file viewable by anyone with link (optional)
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });
    
    console.log(`✅ File uploaded: ${fileName}`);
    res.json({
      success: true,
      fileId: file.data.id,
      webViewLink: file.data.webViewLink,
      webContentLink: file.data.webContentLink,
      message: 'تم رفع الملف بنجاح'
    });
    
  } catch(err){
    console.error('❌ File upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sync all users data
app.post('/api/drive/sync-all', async (req, res) => {
  try{
    const { fileName, content, folderId = FOLDER_ID } = req.body;
    
    const fileMetadata = {
      name: fileName || `MM_AllUsers_${new Date().toISOString().split('T')[0]}.json`,
      parents: [folderId],
      mimeType: 'application/json'
    };
    
    const media = {
      mimeType: 'application/json',
      body: JSON.stringify(content, null, 2)
    };
    
    const file = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, name'
    });
    
    res.json({ 
      success: true, 
      count: content?.length || 0,
      fileId: file.data.id,
      message: `تمت مزامنة ${content?.length || 0} مستخدم`
    });
    
  } catch(err){
    console.error('❌ Bulk sync error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// List files in folder (for admin)
app.get('/api/drive/list', async (req, res) => {
  try{
    const { userId } = req.query;
    let query = `'${FOLDER_ID}' in parents and trashed=false`;
    if(userId) query += ` and appProperties has { key='userId', value='${userId}' }`;
    
    const response = await drive.files.list({
      q: query,
      fields: 'files(id, name, mimeType, size, createdTime, webViewLink)',
      orderBy: 'createdTime desc'
    });
    
    res.json({ success: true, files: response.data.files || [] });
    
  } catch(err){
    console.error('❌ List error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
// 🚀 START SERVER
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`🧬 MyMyeloma Backend running on port ${PORT}`);
  console.log(`📁 Drive Folder: ${FOLDER_ID}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔄 Shutting down...');
  process.exit(0);
});