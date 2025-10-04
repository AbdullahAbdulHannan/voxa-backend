const Reminder = require('../models/reminderModel');
const User = require('../models/userModel');
const { ensureReminderTTS } = require('../utils/ttsService');
let gemini;
try { gemini = require('../services/geminiService'); } catch {}
const { nearbyBestPlaceByKeyword } = require('../utils/placesService');

function getDayString(date = new Date()) {
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()];
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000; // meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function hasCollisionWithinFiveMin(userId, now = new Date()) {
  const start = new Date(now.getTime() - 5 * 60 * 1000);
  const end = new Date(now.getTime() + 5 * 60 * 1000);
  const coll = await Reminder.find({
    user: userId,
    type: { $in: ['Task', 'Meeting'] },
    startDate: { $gte: start, $lte: end },
    isCompleted: { $ne: true },
  }).select('_id type title startDate').lean();
  return Array.isArray(coll) && coll.length > 0;
}

exports.setPermission = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user;
    const { backgroundGranted } = req.body || {};
    await User.findByIdAndUpdate(userId, {
      $set: { 'locationPermissions.backgroundGranted': !!backgroundGranted, 'locationPermissions.updatedAt': new Date() }
    }, { new: true });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || 'Failed to set permission' });
  }
};

exports.scanAndTrigger = async (req, res) => {
  try {
    const user = req.user;
    const userId = user._id || user.id || user;
    const { lat, lng, radius = 500 } = req.body || {};
    const now = new Date();
    console.log('[location] scanAndTrigger start', { userId: String(userId), lat, lng, radius });

    // Active, not completed Location reminders
    const reminders = await Reminder.find({
      user: userId,
      type: 'Location',
      isCompleted: { $ne: true },
      status: { $ne: 'completed' },
    }).lean();
    console.log('[location] active reminders', reminders.length);

    const dayStr = getDayString(now);
    const out = [];

    for (const r of reminders) {
      // Day condition
      if (r.day && r.day !== dayStr) { out.push({ reminderId: r._id, skipped: true, reason: 'day_mismatch', expectedDay: r.day, today: dayStr }); continue; }
      // Anti-spam throttle (>= 90 minutes)
      if (r.lastTriggeredAt) {
        const deltaMin = (now - new Date(r.lastTriggeredAt)) / 60000;
        if (deltaMin < 90) { out.push({ reminderId: r._id, skipped: true, reason: 'anti_spam_window', minutesSince: deltaMin }); continue; }
      }

      // Find best place nearby by keyword = title
      const keyword = r.title || '';
      if (!keyword) { out.push({ reminderId: r._id, skipped: true, reason: 'no_keyword' }); continue; }
      let place = null;
      try {
        place = await nearbyBestPlaceByKeyword({ lat, lng, radius: Number(radius) || 500, keyword });
      } catch (e) {
        // continue to next reminder if Places fails
        out.push({ reminderId: r._id, skipped: true, reason: 'places_error', message: e?.message });
        continue;
      }
      if (!place) { out.push({ reminderId: r._id, skipped: true, reason: 'no_places_match' }); continue; }
      const dist = (typeof place?.geometry?.location?.lat === 'number' && typeof place?.geometry?.location?.lng === 'number')
        ? Math.round(haversineMeters(lat, lng, place.geometry.location.lat, place.geometry.location.lng))
        : null;

      // Collision avoidance with Task/Meeting notifications in ±5min
      const collision = await hasCollisionWithinFiveMin(userId, now);
      if (collision) {
        out.push({ reminderId: r._id, skipped: true, reason: 'collision', retryAfterMs: 6 * 60 * 1000 });
        continue;
      }

      // Update reminder with trigger info
      const update = {
        lastTriggeredAt: now,
        status: r.status === 'expired' ? 'expired' : 'active',
        triggeredLocation: {
          lat: place.geometry?.location?.lat,
          lng: place.geometry?.location?.lng,
          placeId: place.place_id,
          name: place.name,
          rating: place.rating,
        },
      };

      const updated = await Reminder.findByIdAndUpdate(r._id, { $set: update }, { new: true }).populate('user','fullname');

      // Non-blocking: try Gemini one-liner and TTS in the background
      let textHash = null;
      try {
        // Generate a friendly one-liner if possible; fallback text remains in client
        if (gemini?.generateNotificationLineWithGemini) {
          const line = await gemini.generateNotificationLineWithGemini({ reminder: updated, user: updated.user });
          if (line) {
            updated.aiNotificationLine = line;
            await updated.save();
          }
        }
      } catch {}
      // Try to ensure TTS and do a short poll if immediate textHash is not ready
      try {
        const ensured = await ensureReminderTTS(updated._id, { user: updated.user });
        textHash = ensured?.tts?.textHash || null;
        if (!textHash) {
          const startTs = Date.now();
          while (!textHash && Date.now() - startTs < 2000) {
            const again = await ensureReminderTTS(updated._id, { user: updated.user });
            textHash = again?.tts?.textHash || null;
            if (!textHash) await new Promise(r => setTimeout(r, 250));
          }
        }
      } catch {}

      out.push({
        reminderId: updated._id,
        title: updated.title,
        place: { id: place.place_id, name: place.name, rating: place.rating, distanceMeters: dist },
        ttsTextHash: textHash,
      });
    }

    console.log('[location] scanAndTrigger done', { count: out.length, skipped: out.filter(r => r.skipped).length });
    res.json({ success: true, results: out });
  } catch (e) {
    console.error('[location] scan error', e);
    res.status(500).json({ success: false, message: e.message || 'Scan failed' });
  }
}
