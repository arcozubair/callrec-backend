const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Storage: MegaStorage } = require('megajs');

// ==========================================
// Mega.nz API Configuration (Free 20GB)
// ==========================================
// IMPORTANT: Standard folder links don't allow anonymous uploads. 
// You MUST enter your Mega email and password here for it to work.
const MEGA_EMAIL = 'code.shahid11@gmail.com'; 
const MEGA_PASSWORD = 'Shahid@009'; 
let megaStorage = null;
let megaTargetFolder = null;

if (MEGA_EMAIL && MEGA_PASSWORD) {
  console.log('🔄 Logging into Mega.nz...');
  megaStorage = new MegaStorage({ email: MEGA_EMAIL, password: MEGA_PASSWORD });
  
  megaStorage.on('ready', () => {
    console.log('✅ Mega.nz integration enabled and logged in!');
    // Find or create 'CallRecordCatch' folder in Mega root
    megaTargetFolder = megaStorage.root.children.find(f => f.name === 'CallRecordCatch');
    if (!megaTargetFolder) {
      megaStorage.root.mkdir('CallRecordCatch', (err, folder) => {
        if (!err) megaTargetFolder = folder;
      });
    }
  });
} else {
  console.log('⚠️ Mega.nz integration disabled. (Add MEGA_EMAIL and MEGA_PASSWORD)');
}

async function uploadToMega(filePath, fileName) {
  if (!megaStorage || !megaStorage.root) {
    console.log('⚠️ [MEGA] Storage not ready yet. Skipping upload.');
    return;
  }
  
  // Use target folder if it exists, otherwise upload directly to the main Mega Drive (root)
  const target = megaTargetFolder || megaStorage.root;

  try {
    console.log(`[MEGA] Uploading ${fileName}...`);
    const fileStream = fs.createReadStream(filePath);
    const fileSize = fs.statSync(filePath).size;
    
    target.upload({ name: fileName, size: fileSize }, fileStream, (err, file) => {
      if (err) {
        console.error(`❌ [MEGA] Failed to upload ${fileName}:`, err.message || err);
      } else {
        console.log(`✅ [MEGA] Uploaded ${fileName} successfully!`);
      }
    });
  } catch (error) {
    console.error(`❌ [MEGA] Upload error for ${fileName}:`, error.message);
  }
}



const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS so any website or client can access the API
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Directories setup
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'recordings_db.json');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Serve uploaded audio files publicly
app.use('/uploads', express.static(UPLOADS_DIR));

// Configure Multer for File Uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit per file
});

// Simple JSON Database helper functions
function loadDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
    return [];
  }
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    return [];
  }
}

function saveDatabase(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Health Check / Root Endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    app: 'Call Record Catch Backend Server',
    endpoints: {
      upload: 'POST /upload',
      checkDuplicate: 'GET /api/recordings/check-duplicate',
    },
  });
});

function extractDurationFromFileName(fileName = '') {
  if (!fileName) return 0;
  const secMatch = fileName.match(/(\d+)\s*(s|sec|seconds)/i);
  if (secMatch) return parseInt(secMatch[1], 10);
  const minSecMatch = fileName.match(/(\d+)\s*m\s*(\d+)?\s*s?/i);
  if (minSecMatch) {
    const mins = parseInt(minSecMatch[1], 10);
    const secs = minSecMatch[2] ? parseInt(minSecMatch[2], 10) : 0;
    return mins * 60 + secs;
  }
  return 0;
}

function getFileChecksum(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  } catch (e) {
    return null;
  }
}

// Helper function to read all sidecar JSON files from uploads directory
function loadSidecarRecordings() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    return [];
  }
  try {
    const jsonFiles = fs.readdirSync(UPLOADS_DIR).filter((f) => f.endsWith('.json') && f !== 'recordings_db.json');
    const recordings = [];
    const seenIds = new Set();
    const seenChecksums = new Set();

    for (const jsonFile of jsonFiles) {
      const jsonPath = path.join(UPLOADS_DIR, jsonFile);
      try {
        const content = fs.readFileSync(jsonPath, 'utf8');
        const parsed = JSON.parse(content);
        const correspondingAudioPath = path.join(UPLOADS_DIR, parsed.fileName);

        // 1. Clean up orphan JSON if the target audio file does not exist
        if (!fs.existsSync(correspondingAudioPath)) {
          try { fs.unlinkSync(jsonPath); } catch (e) {}
          continue;
        }

        // 2. Prevent duplicate entries by ID in returned list
        if (parsed.id && seenIds.has(parsed.id)) {
          continue;
        }
        if (parsed.id) seenIds.add(parsed.id);

        // 3. Prevent duplicate entries by Checksum in returned list
        if (parsed.checksum) {
          if (seenChecksums.has(parsed.checksum)) {
            continue;
          }
          seenChecksums.add(parsed.checksum);
        }

        delete parsed.audioUrl;
        recordings.push(parsed);
      } catch (e) {
        // Skip invalid JSON
      }
    }

    return recordings.sort((a, b) => new Date(b.uploadedAt || b.dateTime) - new Date(a.uploadedAt || a.dateTime));
  } catch (err) {
    return [];
  }
}

/**
 * Duplicate Protection Lookup
 * Finds existing recording by SHA-256 checksum (and optional deviceId).
 */
function findRecordingByChecksum(checksum, deviceId = null) {
  if (!checksum) return null;
  const recordings = loadSidecarRecordings();

  if (deviceId) {
    const exactMatch = recordings.find((r) => r.checksum === checksum && r.deviceId === deviceId);
    if (exactMatch) return exactMatch;
  }

  return recordings.find((r) => r.checksum === checksum);
}

/**
 * Check Duplicate Pre-flight Endpoint
 */
app.get('/api/recordings/check-duplicate', (req, res) => {
  try {
    const { checksum, deviceId } = req.query;
    if (!checksum) {
      return res.status(400).json({ success: false, message: 'Checksum parameter is required.' });
    }

    const existing = findRecordingByChecksum(checksum, deviceId);
    if (existing) {
      const host = req.get('host');
      const protocol = req.protocol;
      const remoteUrl = `${protocol}://${host}/uploads/${encodeURIComponent(existing.fileName)}`;

      console.log(`[CHECK DUPLICATE] Match found for checksum ${checksum.substring(0, 12)}... (${existing.fileName})`);

      return res.json({
        success: true,
        duplicate: true,
        alreadyUploaded: true,
        recording: {
          id: existing.id,
          fileName: existing.fileName,
          remoteUrl,
          checksum: existing.checksum,
          deviceId: existing.deviceId,
        },
      });
    }

    return res.json({
      success: true,
      duplicate: false,
      alreadyUploaded: false,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to check duplicate.' });
  }
});

/**
 * Upload Endpoint Handler
 * Duplicate-safe: checks SHA-256 checksum before permanently saving files.
 */
function handleUpload(req, res) {
  try {
    const uploadedFile = (req.files && req.files.length > 0) ? req.files[0] : req.file;
    
    // Parse incoming metadata payload
    let meta = {};
    if (req.body.metadata) {
      try {
        meta = typeof req.body.metadata === 'string' ? JSON.parse(req.body.metadata) : req.body.metadata;
      } catch (e) {
        meta = {};
      }
    }

    let checksum = req.body.checksum || meta.checksum;
    const deviceId = req.body.deviceId || meta.deviceId || 'Mobile App';

    if (!uploadedFile) {
      return res.status(400).json({ success: false, message: 'No audio file uploaded.' });
    }

    // Auto-compute SHA-256 checksum if missing from client
    if (!checksum && uploadedFile && uploadedFile.path) {
      checksum = getFileChecksum(uploadedFile.path);
    }

    const actualFileName = req.body.fileName || meta.fileName || uploadedFile.originalname;

    // ---------------------------------------------------------
    // Backend Duplicate Check (Unique Constraint Protection)
    // ---------------------------------------------------------
    if (checksum) {
      const existing = findRecordingByChecksum(checksum, deviceId);
      if (existing) {
        // Clean up Multer temporary upload file if present
        if (uploadedFile && uploadedFile.path && fs.existsSync(uploadedFile.path)) {
          try { fs.unlinkSync(uploadedFile.path); } catch (e) {}
        }
        // Clean up sidecar JSON if it was generated for actualFileName
        const sidecarPath = path.join(UPLOADS_DIR, `${actualFileName}.json`);
        if (fs.existsSync(sidecarPath)) {
          try { fs.unlinkSync(sidecarPath); } catch (e) {}
        }

        const host = req.get('host');
        const protocol = req.protocol;
        const remoteUrl = `${protocol}://${host}/uploads/${encodeURIComponent(existing.fileName)}`;

        console.log(`[DUPLICATE DETECTED] Skipped duplicate upload for checksum ${checksum.substring(0, 12)}... (${existing.fileName})`);

        return res.status(200).json({
          success: true,
          duplicate: true,
          alreadyUploaded: true,
          message: 'Recording already uploaded previously.',
          id: existing.id,
          recording: {
            id: existing.id,
            fileName: existing.fileName,
            remoteUrl,
            checksum: existing.checksum,
            deviceId: existing.deviceId,
          },
        });
      }
    }

    const finalAudioPath = path.join(UPLOADS_DIR, actualFileName);

    // If Multer saved file under temp name, rename to actual unmodified name
    if (uploadedFile.path !== finalAudioPath) {
      try {
        fs.renameSync(uploadedFile.path, finalAudioPath);
      } catch (renameErr) {
        fs.copyFileSync(uploadedFile.path, finalAudioPath);
        try { fs.unlinkSync(uploadedFile.path); } catch (e) {}
      }
    }

    const recordingId = meta.id || `rec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const phoneNumber = req.body.phoneNumber || meta.phoneNumber || 'Unknown number';
    const dateTime = req.body.dateTime || meta.dateTime || new Date().toISOString();

    let duration = Number(req.body.duration || meta.duration || 0);
    if (!duration || duration === 0) {
      duration = extractDurationFromFileName(actualFileName);
    }

    const uploadedAt = new Date().toISOString();

    const metadataPayload = {
      id: recordingId,
      fileName: actualFileName,
      phoneNumber: phoneNumber,
      dateTime: dateTime,
      duration: duration,
      fileSize: uploadedFile.size,
      mimeType: uploadedFile.mimetype || 'audio/mpeg',
      checksum: checksum || null,
      deviceId: deviceId,
      uploadedAt: uploadedAt,
    };

    // Save sidecar .json metadata file alongside audio file
    const sidecarJsonPath = path.join(UPLOADS_DIR, `${actualFileName}.json`);
    fs.writeFileSync(sidecarJsonPath, JSON.stringify(metadataPayload, null, 2));

    console.log(`[UPLOAD SUCCESS] Saved ${actualFileName} & sidecar JSON (Checksum: ${checksum ? checksum.substring(0, 10) + '...' : 'none'})`);

    const host = req.get('host');
    const protocol = req.protocol;
    const remoteUrl = `${protocol}://${host}/uploads/${encodeURIComponent(actualFileName)}`;



    // Background process for Mega.nz upload
    if (megaStorage) {
      uploadToMega(finalAudioPath, actualFileName);
      uploadToMega(sidecarJsonPath, `${actualFileName}.json`);
    }

    return res.status(200).json({
      success: true,
      duplicate: false,
      alreadyUploaded: false,
      message: 'Call recording and sidecar JSON saved successfully.',
      id: recordingId,
      recording: {
        ...metadataPayload,
        remoteUrl,
      },
    });
  } catch (error) {
    console.error('[UPLOAD ERROR]', error);
    return res.status(500).json({ success: false, message: error.message || 'Server error during upload.' });
  }
}

app.post('/api/recordings', upload.any(), handleUpload);
app.post('/upload', upload.any(), handleUpload);

/**
 * GET /api/recordings
 * Returns call recordings derived from sidecar JSON files.
 */
app.get('/api/recordings', (req, res) => {
  try {
    const sidecarRecordings = loadSidecarRecordings();
    const host = req.get('host');
    const protocol = req.protocol;

    const formattedList = sidecarRecordings.map((rec) => {
      const calculatedDuration = rec.duration || extractDurationFromFileName(rec.fileName);
      return {
        id: rec.id,
        phoneNumber: rec.phoneNumber,
        dateTime: rec.dateTime,
        duration: calculatedDuration,
        fileName: rec.fileName,
        fileSize: rec.fileSize,
        mimeType: rec.mimeType,
        checksum: rec.checksum,
        deviceId: rec.deviceId,
        audioUrl: `${protocol}://${host}/uploads/${encodeURIComponent(rec.fileName)}`,
        uploadedAt: rec.uploadedAt,
      };
    });

    return res.json(formattedList);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch recordings.' });
  }
});

/**
 * GET /api/recordings/:id
 * Get single recording metadata from sidecar JSON
 */
app.get('/api/recordings/:id', (req, res) => {
  const sidecarRecordings = loadSidecarRecordings();
  const found = sidecarRecordings.find((r) => r.id === req.params.id || r.fileName === req.params.id);

  if (!found) {
    return res.status(404).json({ success: false, message: 'Recording not found.' });
  }

  const host = req.get('host');
  const protocol = req.protocol;

  return res.json({
    ...found,
    audioUrl: `${protocol}://${host}/uploads/${encodeURIComponent(found.fileName)}`,
  });
});

/**
 * DELETE /api/recordings/:id
 * Delete recording audio file and its sidecar .json metadata file
 */
app.delete('/api/recordings/:id', (req, res) => {
  const sidecarRecordings = loadSidecarRecordings();
  const itemToDelete = sidecarRecordings.find((r) => r.id === req.params.id || r.fileName === req.params.id);

  if (!itemToDelete) {
    return res.status(404).json({ success: false, message: 'Recording not found.' });
  }

  // Delete audio file
  const audioPath = path.join(UPLOADS_DIR, itemToDelete.fileName);
  if (fs.existsSync(audioPath)) {
    try { fs.unlinkSync(audioPath); } catch (e) {}
  }

  // Delete sidecar JSON file
  const sidecarPath = path.join(UPLOADS_DIR, `${itemToDelete.fileName}.json`);
  if (fs.existsSync(sidecarPath)) {
    try { fs.unlinkSync(sidecarPath); } catch (e) {}
  }

  return res.json({ success: true, message: 'Recording and sidecar JSON deleted.' });
});

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // Filter IPv4, non-internal (127.0.0.1), and non-link-local (169.254.x.x)
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        ips.push(net.address);
      }
    }
  }
  // Sort to prioritize 192.168.x.x and 10.x.x.x
  ips.sort((a, b) => {
    if (a.startsWith('192.168.') || a.startsWith('10.')) return -1;
    if (b.startsWith('192.168.') || b.startsWith('10.')) return 1;
    return 0;
  });
  return ips.length > 0 ? ips : ['localhost'];
}

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  const primaryIp = ips[0];
  console.log(`===================================================`);
  console.log(`🚀 Call Record Backend Server is running!`);
  console.log(`📡 Local Access: http://localhost:${PORT}`);
  ips.forEach((ip) => {
    console.log(`🌐 Network Access (Device/Mobile): http://${ip}:${PORT}`);
  });
  console.log(`📲 Upload Endpoint: POST http://${primaryIp}:${PORT}/upload`);
  console.log(`🔎 Check Duplicate: GET http://${primaryIp}:${PORT}/api/recordings/check-duplicate`);
  console.log(`===================================================`);
});
