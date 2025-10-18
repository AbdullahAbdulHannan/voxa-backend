const speech = require('@google-cloud/speech');
const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Initialize Google Cloud clients
const speechClient = new speech.SpeechClient({
  keyFilename: path.join(__dirname, '../../google-credentials.json')
});

const storage = new Storage({
  keyFilename: path.join(__dirname, '../../google-credentials.json')
});

const BUCKET_NAME = 'voxa-ai-audio-files'; // Create this bucket in Google Cloud Storage

// Upload audio file to Google Cloud Storage
async function uploadAudioToGCS(audioBuffer) {
  const bucket = storage.bucket(BUCKET_NAME);
  const filename = `audio-${uuidv4()}.wav`;
  const file = bucket.file(filename);
  
  await file.save(audioBuffer, {
    metadata: { contentType: 'audio/wav' },
  });

  // Make the file public (optional, only if you need public access)
  await file.makePublic();
  
  return `gs://${BUCKET_NAME}/${filename}`;
}

// Transcribe audio using Google Speech-to-Text
async function transcribeAudio(audioBuffer, languageCode = 'en-US') {
  try {
    // Upload to GCS first (required for longer audio files)
    const gcsUri = await uploadAudioToGCS(audioBuffer);
    
    const audio = {
      uri: gcsUri,
    };

    const config = {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode: languageCode,
      enableAutomaticPunctuation: true,
      model: 'latest_long', // Best for longer audio files
    };

    const request = {
      audio: audio,
      config: config,
    };

    const [operation] = await speechClient.longRunningRecognize(request);
    const [response] = await operation.promise();

    // Get the transcription
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');

    return transcription;
  } catch (error) {
    console.error('Error transcribing audio:', error);
    throw new Error(`Speech-to-text error: ${error.message}`);
  }
}

// For direct audio buffer processing (shorter audio)
async function transcribeAudioDirectly(audioBuffer, languageCode = 'en-US') {
  const audioBytes = audioBuffer.toString('base64');
  
  const audio = {
    content: audioBytes,
  };
  
  const config = {
    encoding: 'LINEAR16',
    sampleRateHertz: 16000,
    languageCode: languageCode,
    enableAutomaticPunctuation: true,
  };

  const request = {
    audio: audio,
    config: config,
  };

  try {
    const [response] = await speechClient.recognize(request);
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');
    
    return transcription || "I couldn't transcribe that. Could you try again?";
  } catch (error) {
    console.error('Direct transcription error:', error);
    throw new Error(`Speech recognition failed: ${error.message}`);
  }
}

module.exports = {
  transcribeAudio,
  transcribeAudioDirectly
};
