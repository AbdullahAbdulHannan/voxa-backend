const Reminder = require('../models/reminderModel');
const User = require('../models/userModel');
const axios = require('axios');
const { validationResult } = require('express-validator');

// Helper: attempt to extract coordinates from a Google Maps (or similar) URL
async function getCoordinatesFromUrl(url) {
  try {
    if (!url) return null;

    let workingUrl = url;

    // If it's a short link (maps.app.goo.gl, goo.gl/maps, g.co/maps), try to resolve to the long redirect URL first
    if (/maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/maps/.test(url)) {
      try {
        const resp = await axios.get(url, { maxRedirects: 5, timeout: 5000, validateStatus: () => true });
        const finalUrl = resp?.request?.res?.responseUrl || resp?.request?.responseURL || resp?.config?.url;
        if (finalUrl && typeof finalUrl === 'string') {
          workingUrl = finalUrl;
        }
      } catch (e) {
        // ignore, we'll try to parse the original url
      }
    }

    // Common pattern in Google Maps share links: .../@lat,lng,zoom...
    const atMatch = workingUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atMatch) {
      const lat = parseFloat(atMatch[1]);
      const lng = parseFloat(atMatch[2]);
      if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
    }

    // q=lat,lng or query param with coordinates
    const qParam = workingUrl.match(/[?&]q=([^&]+)/);
    if (qParam) {
      const decoded = decodeURIComponent(qParam[1]);
      const coordMatch = decoded.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
      if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lng = parseFloat(coordMatch[2]);
        if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
      }
    }

    // Other common params: ll=lat,lng or sll=lat,lng or destination=lat,lng
    const otherParams = workingUrl.match(/[?&](ll|sll|destination)=([^&]+)/);
    if (otherParams) {
      const decoded = decodeURIComponent(otherParams[2]);
      const coordMatch = decoded.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
      if (coordMatch) {
        const lat = parseFloat(coordMatch[1]);
        const lng = parseFloat(coordMatch[2]);
        if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
      }
    }

    // If we cannot parse directly, fall back to geocoding the name or address portion (if present)
    // Try extracting the place text from the URL path (e.g., /place/<name>/)
    const placePath = workingUrl.match(/\/place\/([^/]+)/);
    if (placePath && process.env.GOOGLE_MAPS_API_KEY) {
      const placeText = decodeURIComponent(placePath[1]).replace(/\+/g, ' ');
      const response = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json`, {
        params: { address: placeText, key: process.env.GOOGLE_MAPS_API_KEY }
      });
      if (response.data.results?.[0]?.geometry?.location) {
        const { lat, lng } = response.data.results[0].geometry.location;
        return { lat, lng };
      }
    }

    // As a last non-API attempt, try to detect any lat,lng pair anywhere in the URL/text
    const genericMatch = workingUrl.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
    if (genericMatch) {
      const lat = parseFloat(genericMatch[1]);
      const lng = parseFloat(genericMatch[2]);
      if (!isNaN(lat) && !isNaN(lng) && lat <= 90 && lat >= -90 && lng <= 180 && lng >= -180) {
        return { lat, lng };
      }
    }

    return null;
  } catch (error) {
    console.error('Error getting coordinates:', error);
    return null;
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
      
      // Try to extract coordinates from provided link first; if not available, geocode by name
      try {
        let coords = null;
        if (location.link) {
          coords = await getCoordinatesFromUrl(location.link);
        }
        if (!coords && process.env.GOOGLE_MAPS_API_KEY) {
          const response = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json`, {
            params: { address: location.name, key: process.env.GOOGLE_MAPS_API_KEY }
          });
          if (response.data.results?.[0]?.geometry?.location) {
            const { lat, lng } = response.data.results[0].geometry.location;
            coords = { lat, lng };
          }
        }
        if (coords) {
          // Store as object { lat, lng } to match the schema
          reminderData.location.coordinates = { lat: coords.lat, lng: coords.lng };
        }
      } catch (error) {
        console.error('Error getting coordinates:', error);
        // Don't fail the request if we can't get coordinates
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
    const updates = req.body;
    
    // Prevent changing user ID
    if (updates.user) {
      delete updates.user;
    }

    // If updating dates, validate them
    if (updates.startDate && updates.endDate) {
      if (new Date(updates.endDate) <= new Date(updates.startDate)) {
        return res.status(400).json({ message: 'End date must be after start date' });
      }
    }

    const reminder = await Reminder.findOneAndUpdate(
      { _id: id, user: req.user._id },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!reminder) {
      return res.status(404).json({ message: 'Reminder not found' });
    }

    res.json(reminder);
  } catch (error) {
    console.error('Error updating reminder:', error);
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
