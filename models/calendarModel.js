const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  googleEventId: {
    type: String,
    required: true
  },
  summary: {
    type: String,
    required: true
  },
  description: {
    type: String
  },
  location: {
    type: String
  },
  start: {
    dateTime: {
      type: Date,
      required: true
    },
    timeZone: String
  },
  end: {
    dateTime: {
      type: Date,
      required: true
    },
    timeZone: String
  },
  status: {
    type: String,
    enum: ['confirmed', 'tentative', 'cancelled'],
    default: 'confirmed'
  },
  htmlLink: {
    type: String
  },
  created: {
    type: Date,
    default: Date.now
  },
  updated: {
    type: Date,
    default: Date.now
  }
});

const calendarSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  accessToken: {
    type: String,
    required: true
  },
  refreshToken: {
    type: String,
    required: true
  },
  tokenExpiry: {
    type: Date,
    required: true
  },
  events: [eventSchema],
  lastSynced: {
    type: Date
  }
}, {
  timestamps: true
});

// Index for faster querying
calendarSchema.index({ user: 1 });
calendarSchema.index({ 'events.googleEventId': 1 });

const Calendar = mongoose.model('Calendar', calendarSchema);

module.exports = Calendar;
