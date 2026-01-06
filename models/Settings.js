// models/Settings.js
const mongoose = require('mongoose');

const ZoneOverrideSchema = new mongoose.Schema(
  {
    key:    { type: String, required: true },  // lowercased zone name
    label:  { type: String, required: true },  // display name
    minutes:{ type: Number, required: true },  // 1–120
  },
  { _id: false }
);

const SettingsSchema = new mongoose.Schema({
  name: { type: String, default: 'global', unique: true },

  mode: {
    type: String,
    enum: ['off', 'dry-run', 'live'],
    default: 'off',
  },

  autoBusyMsgEnabled: { type: Boolean, default: true },
  timerMsgEnabled:    { type: Boolean, default: true },

  autoBusyMsgText: {
    type: String,
    default: 'AutoPob Activated',
  },
  timerMsgText: {
    type: String,
    default: 'Clear Timer Expired',
  },

  defaultTimerMinutes: {
    type: Number,
    default: 1,
  },

  zoneOverrides: [ZoneOverrideSchema],

  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Settings', SettingsSchema);
