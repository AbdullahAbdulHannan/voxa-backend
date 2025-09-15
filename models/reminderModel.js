const mongoose = require('mongoose');

const reminderSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['Task', 'Meeting', 'Location'],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  description: String,
  icon: {
    type: String,
    default: 'star'
  },
  startDate: {
    type: Date,
    required: function() {
      return this.type !== 'Location';
    }
  },
  endDate: {
    type: Date,
    required: function() {
      return this.type !== 'Location';
    },
    validate: {
      validator: function(endDate) {
        if (this.type === 'Location') return true;
        return endDate > this.startDate;
      },
      message: 'End date must be after start date'
    }
  },
  // Location specific fields
  location: {
    name: String,
    link: String,
    coordinates: {
      lat: Number,
      lng: Number
    }
  },
  isCompleted: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  // TTS fields for dynamic voice notifications
  tts: {
    voiceId: { type: String },
    textHash: { type: String },
    audio: {
      data: Buffer,
      contentType: String,
      size: Number
    },
    status: {
      type: String,
      enum: ['pending', 'ready', 'failed'],
      default: 'pending'
    },
    generatedAt: { type: Date },
    lastTextVersion: { type: Number, default: 0 }
  }
}, { timestamps: true });

// Add index for better query performance
reminderSchema.index({ user: 1, startDate: 1 });

module.exports = mongoose.model('Reminder', reminderSchema);
