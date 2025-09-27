    // Fire-and-forget TTS generation
    try {
      if (populatedReminder.startDate) {
        await ensureReminderTTS(populatedReminder._id, { user });
      }
     } catch (e) {
       console.warn('[tts] generation failed on create', e?.message);
     }
 
     res.status(201).json({
       success: true,
       data: populatedReminder
     });
    // Background AI processing (non-blocking)
    setImmediate(() => {
      try {
        const { processBackgroundAI } = require('../services/aiScheduler');
        processBackgroundAI(populatedReminder._id, { user }).catch(err => console.warn('[ai] background failed', err?.message));
      } catch (err) {
        console.warn('[ai] scheduler not available', err?.message);
      }
    });
   } catch (error) {
{{ ... }}
  res.status(200).json({
    success: true,
    data: updatedReminder,
  });
  // Background AI processing after update (non-blocking)
  setImmediate(() => {
    try {
      const { processBackgroundAI } = require('../services/aiScheduler');
      processBackgroundAI(updatedReminder._id, { user: updatedReminder.user }).catch(err => console.warn('[ai] background update failed', err?.message));
    } catch (err) {
      console.warn('[ai] scheduler not available', err?.message);
    }
  });
 });
