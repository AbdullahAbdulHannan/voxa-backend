const Reminder = require('../models/reminderModel');
const User = require('../models/userModel');
const axios = require('axios');
const { validationResult } = require('express-validator');

// Helper: extract coordinates from mapping URLs with multiple providers; fallback to LocationIQ
async function getCoordinatesFromUrl(url) {
  try {
    if (!url) throw new Error('No URL provided');
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // 1) Google Maps (full link) - look for /@lat,lng
    const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atMatch) {
      const lat = parseFloat(atMatch[1]);
      const lng = parseFloat(atMatch[2]);
      if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
    }

    // 2) Google Maps (short link)
    if (host.includes('maps.app.goo.gl')) {
      try {
        const fetchFn = (...args) => import('node-fetch').then(m => m.default(...args));
        const resp = await fetchFn(url, { method: 'GET', redirect: 'manual' });
        const loc = resp.headers.get('location');
        if (loc) {
          const longUrl = loc;
          const at = longUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
          if (at) {
            const lat = parseFloat(at[1]);
            const lng = parseFloat(at[2]);
            if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
          }
        }
      } catch (e) {
        // continue to other providers/fallbacks
      }
    }

    // 3) Apple Maps - ll=lat,lng
    if (host.includes('maps.apple.com')) {
      const ll = parsed.searchParams.get('ll');
      if (ll) {
        const m = ll.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
        if (m) {
          const lat = parseFloat(m[1]);
          const lng = parseFloat(m[2]);
          if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
        }
      }
    }

    // 4) OpenStreetMap - mlat & mlon
    if (host.includes('openstreetmap.org')) {
      const mlat = parsed.searchParams.get('mlat');
      const mlon = parsed.searchParams.get('mlon');
      if (mlat && mlon) {
        const lat = parseFloat(mlat);
        const lng = parseFloat(mlon);
        if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
      }
    }

    // 5) Fallback to LocationIQ (by query text)
    const LOCATIONIQ_KEY = process.env.LOCATIONIQ_KEY;
    if (!LOCATIONIQ_KEY) {
      throw new Error('LOCATIONIQ_KEY is not set and coordinates could not be parsed from URL');
    }

    // Prefer q param; otherwise derive from path
    let queryText = parsed.searchParams.get('q');
    if (!queryText) {
      // Try to get something meaningful from the pathname (e.g., /place/Some+Place)
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        queryText = decodeURIComponent(pathParts[pathParts.length - 1]).replace(/\+/g, ' ');
      } else {
        throw new Error('Unable to derive query text from URL for LocationIQ');
      }
    }

    const iqResp = await axios.get('https://us1.locationiq.com/v1/search.php', {
      params: { key: LOCATIONIQ_KEY, q: queryText, format: 'json' },
      timeout: 8000,
    });
    const first = Array.isArray(iqResp.data) ? iqResp.data[0] : null;
    if (!first) throw new Error('LocationIQ returned no results');
    const lat = parseFloat(first.lat);
    const lng = parseFloat(first.lon);
    if (isNaN(lat) || isNaN(lng)) throw new Error('LocationIQ returned invalid coordinates');
    return { lat, lng };
  } catch (error) {
    throw new Error(`Coordinate resolution failed: ${error.message}`);
  }
}

// @desc    Create a new reminder
// @route   POST /api/reminders
// @access  Private
exports.createReminder = async (req, res) => {
  console.log('Received create reminder request:', {
    body: req.body,
    user: req.user,
    headers: req.headers
  });

  // Validate request body
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.log('Validation errors:', errors.array());
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(err => ({
        param: err.param,
        msg: err.msg,
        value: err.value
      }))
    });
  }

  try {
    const { type, title, description, icon, startDate, endDate, location } = req.body;
    const userId = req.user.id;

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prepare reminder data
    const reminderData = {
      user: userId,
      type,
      title: title || (type === 'Task' ? 'New Task' : type === 'Meeting' ? 'New Meeting' : 'New Location'),
      description: description || '',
      icon: icon || 'bell', // Default icon
    };

    // Handle date fields based on reminder type
    if (type !== 'Location') {
      if (!startDate) {
        return res.status(400).json({
          success: false,
          message: 'Start date is required for this reminder type'
        });
      }
      
      reminderData.startDate = startDate;
      reminderData.endDate = endDate || new Date(new Date(startDate).getTime() + 60 * 60 * 1000); // Default 1 hour duration
      
      if (new Date(reminderData.endDate) <= new Date(reminderData.startDate)) {
        return res.status(400).json({
          success: false,
          message: 'End date must be after start date'
        });
      }
    } else {
      // Handle location reminders
      if (!location?.name) {
        return res.status(400).json({
          success: false,
          message: 'Location name is required for location reminders'
        });
      }
      
      reminderData.location = {
        name: location.name,
        link: location.link || ''
      };
      
      // Resolve coordinates (client-provided OR via URL/provider OR LocationIQ fallback). Must succeed.
      try {
        let coords = null;
        if (location.coordinates && typeof location.coordinates.lat === 'number' && typeof location.coordinates.lng === 'number') {
          coords = { lat: location.coordinates.lat, lng: location.coordinates.lng };
        } else if (location.link) {
          coords = await getCoordinatesFromUrl(location.link);
        } else {
          // As a last resort, try LocationIQ using the name
          const LOCATIONIQ_KEY = process.env.LOCATIONIQ_KEY;
          if (!LOCATIONIQ_KEY) {
            throw new Error('LOCATIONIQ_KEY is not set and no link provided to infer coordinates');
          }
          const iqResp = await axios.get('https://us1.locationiq.com/v1/search.php', {
            params: { key: LOCATIONIQ_KEY, q: location.name, format: 'json' },
            timeout: 8000,
          });
          const first = Array.isArray(iqResp.data) ? iqResp.data[0] : null;
          if (first) {
            const lat = parseFloat(first.lat);
            const lng = parseFloat(first.lon);
            if (!isNaN(lat) && !isNaN(lng)) coords = { lat, lng };
          }
        }

        if (!coords) {
          return res.status(400).json({
            success: false,
            message: 'Failed to resolve coordinates for the provided location link/name. Ensure the link contains coordinates or configure LOCATIONIQ_KEY.'
          });
        }

        reminderData.location.coordinates = { lat: coords.lat, lng: coords.lng };
      } catch (error) {
        console.error('Error resolving coordinates:', error);
        return res.status(400).json({ success: false, message: error.message || 'Failed to resolve coordinates' });
      }
    }

    // Create and save the reminder
    const reminder = await Reminder.create(reminderData);

    // Add reminder to user's reminders array
    user.reminders.push(reminder._id);
    await user.save({ validateBeforeSave: false });

    // Populate user data in the response
    const populatedReminder = await Reminder.findById(reminder._id).populate('user', 'fullname email');

    res.status(201).json({
      success: true,
      data: populatedReminder
    });
  } catch (error) {
    console.error('Error creating reminder:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code,
      body: req.body,
      user: req.user
    });
    
    res.status(500).json({ 
      success: false, 
      message: 'Server error while creating reminder',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
    });
  }
};

// @desc    Get all reminders for a user with filtering and pagination
// @route   GET /api/reminders
// @access  Private
exports.getReminders = async (req, res) => {
  try {
    const { type, completed, startDate, endDate, page = 1, limit = 10 } = req.query;
    const query = { user: req.user.id };
    
    // Build query based on filters
    if (type) query.type = type;
    if (completed !== undefined) query.completed = completed === 'true';
    
    // Date range filtering
    if (startDate || endDate) {
      query.startDate = {};
      if (startDate) query.startDate.$gte = new Date(startDate);
      if (endDate) query.startDate.$lte = new Date(endDate);
    }
    
    // Get paginated results
    const reminders = await Reminder.find(query)
      .sort({ startDate: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .populate('user', 'fullname email');
    
    // Get total count for pagination
    const count = await Reminder.countDocuments(query);
    
    res.status(200).json({
      success: true,
      data: reminders,
      pagination: {
        total: count,
        totalPages: Math.ceil(count / limit),
        currentPage: parseInt(page),
        pageSize: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Error getting reminders:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update a reminder
exports.updateReminder = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};

    // Prevent changing user ID
    if (updates.user) delete updates.user;

    // Load existing reminder to validate merged dates
    const existing = await Reminder.findOne({ _id: id, user: req.user._id });
    if (!existing) {
      return res.status(404).json({ message: 'Reminder not found' });
    }

    // Merge dates for validation (only for non-Location)
    const nextType = updates.type || existing.type;
    if (nextType !== 'Location') {
      const mergedStart = updates.startDate ? new Date(updates.startDate) : existing.startDate;
      const mergedEnd = updates.endDate ? new Date(updates.endDate) : existing.endDate;

      if (!mergedStart || !mergedEnd) {
        return res.status(400).json({ message: 'Both start and end dates are required for this reminder type' });
      }
      if (new Date(mergedEnd).getTime() <= new Date(mergedStart).getTime()) {
        return res.status(400).json({ message: 'End date must be after start date' });
      }
    }

    const updated = await Reminder.findOneAndUpdate(
      { _id: id, user: req.user._id },
      { $set: updates },
      { new: true, runValidators: true }
    );

    res.json(updated);
  } catch (error) {
    console.error('Error updating reminder:', error);
    // Surface validation error messages clearly
    if (error?.name === 'ValidationError') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error' });
  }
};

// Delete a reminder
exports.deleteReminder = async (req, res) => {
  try {
    const { id } = req.params;
    
    const reminder = await Reminder.findOneAndDelete({
      _id: id,
      user: req.user._id
    });

    if (!reminder) {
      return res.status(404).json({ message: 'Reminder not found' });
    }

    res.json({ message: 'Reminder deleted successfully' });
  } catch (error) {
    console.error('Error deleting reminder:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
