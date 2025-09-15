const axios = require('axios');
const crypto = require('crypto');
const Reminder = require('../models/reminderModel');

function buildNotificationText(reminder, user) {
  // Simple text. You can enhance with user prefs or templates.
  const name = user?.fullname?.split(' ')[0] || 'there';
  const when = reminder.startDate ? new Date(reminder.startDate) : null;
  let timePart = '';
  if (when) {
    const diffMin = Math.max(0, Math.round((when.getTime() - Date.now()) / 60000));
    if (diffMin <= 1) timePart = 'in less than a minute';
    else timePart = `in ${diffMin} minutes`;
  }
  if (reminder.type === 'Task') {
    return `Hey ${name}, your task ${reminder.title} is due ${timePart}.`;
  }
  if (reminder.type === 'Meeting') {
    return `Hey ${name}, you have a meeting ${reminder.title} ${timePart}.`;
  }
  if (reminder.type === 'Location') {
    const loc = reminder.location?.name || 'your saved place';
    return `Hey ${name}, you are near ${loc}.`;
  }
  return `Hey ${name}, you have a reminder: ${reminder.title}.`;
}

function computeTextHash(text, voiceId) {
  return crypto.createHash('sha256').update(`${voiceId}::${text}`).digest('hex');
}

async function generateElevenLabsAudio({ text, voiceId, modelId, format = 'mp3_44100_128' }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured');
  const DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'XcXEQzuLXRU9RcfWzEJt';
  const vid = voiceId || DEFAULT_VOICE_ID;
  if (!vid) throw new Error('Voice ID not provided or ELEVENLABS_DEFAULT_VOICE_ID missing');

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}`;
  const payload = {
    text,
    model_id: modelId || 'eleven_multilingual_v2',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0.3,
      use_speaker_boost: true
    },
    // Output format defined by accept header for newer API; some SDKs take "output_format"
  };

  const resp = await axios.post(url, payload, {
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    responseType: 'arraybuffer',
    timeout: 20000
  });

  return {
    buffer: Buffer.from(resp.data),
    contentType: 'audio/mpeg'
  };
}

async function ensureReminderTTS(reminderId, { user, overrideVoiceId } = {}) {
  const reminder = await Reminder.findById(reminderId).populate('user', 'fullname');
  if (!reminder) throw new Error('Reminder not found');
  const text = buildNotificationText(reminder, user || reminder.user);
  const voiceId = overrideVoiceId || reminder.tts?.voiceId || process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  const hash = computeTextHash(text, voiceId);

  // If already generated and hash matches, skip
  if (reminder.tts?.textHash === hash && reminder.tts?.status === 'ready' && reminder.tts?.audio?.data?.length) {
    return reminder;
  }

  // Mark pending
  reminder.tts = reminder.tts || {};
  reminder.tts.voiceId = voiceId;
  reminder.tts.textHash = hash;
  reminder.tts.status = 'pending';
  reminder.tts.generatedAt = null;
  await reminder.save();

  try {
    const { buffer, contentType } = await generateElevenLabsAudio({ text, voiceId });
    reminder.tts.audio = {
      data: buffer,
      contentType,
      size: buffer.length
    };
    reminder.tts.status = 'ready';
    reminder.tts.generatedAt = new Date();
    await reminder.save();
  } catch (e) {
    reminder.tts.status = 'failed';
    await reminder.save();
    throw e;
  }

  return reminder;
}

module.exports = {
  buildNotificationText,
  computeTextHash,
  ensureReminderTTS,
};
