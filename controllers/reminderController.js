const Reminder = require('../models/reminderModel');
const User = require('../models/userModel');
const axios = require('axios');
const { validationResult } = require('express-validator');

// Helper function to extract coordinates from Google Maps URL
async function getCoordinatesFromUrl(url) {
  try {
    // Extract place ID from URL
    const placeIdMatch = url.match(/[?&]q=([^&]+)/) || url.match(/place\/([^/]+)/);
    if (!placeIdMatch) return null;

    const placeId = placeIdMatch[1];
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json`,
      {
        params: {
          place_id: placeId,
          key: process.env.GOOGLE_MAPS_API_KEY
        }
      }
    );

    if (response.data.results && response.data.results[0]) {
      const { lat, lng } = response.data.results[0].geometry.location;
      return { lat, lng };
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
      
      // If there's a Google Maps link, try to extract coordinates
      if (location.link && location.link.includes('maps.google.com')) {
        try {
          const address = encodeURIComponent(location.name);
          const response = await axios.get(
            `https://maps.googleapis.com/maps/api/geocode/json?address=${address}&key=${process.env.GOOGLE_MAPS_API_KEY}`
          );
          
          if (response.data.results?.[0]?.geometry?.location) {
            reminderData.location.coordinates = [
              response.data.results[0].geometry.location.lng,
              response.data.results[0].geometry.location.lat
            ];
          }
        } catch (error) {
          console.error('Error getting coordinates:', error);
          // Don't fail the request if we can't get coordinates
        }
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
