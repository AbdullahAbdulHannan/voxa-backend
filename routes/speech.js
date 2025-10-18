const express = require('express');
const router = express.Router();
const multer = require('multer');
const { transcribeAudioDirectly } = require('../services/speechService');
const { auth } = require('../middleware/authMiddleware');

// Configure multer for file upload
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'), false);
    }
  }
});

// Transcribe audio file
router.post('/transcribe', auth, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'No audio file provided' 
      });
    }

    const audioBuffer = req.file.buffer;
    const languageCode = req.body.language || 'en-US';
    
    // Use direct transcription for shorter audio
    const transcription = await transcribeAudioDirectly(audioBuffer, languageCode);
    
    res.json({
      success: true,
      text: transcription
    });
    
  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error transcribing audio'
    });
  }
});

module.exports = router;
