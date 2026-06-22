const mongoose = require('mongoose');

const SettingsSchema = new mongoose.Schema({
  name: { type: String, default: 'global', unique: true },
  mode: { type: String, enum: ['off', 'dry-run', 'live'], default: process.env.AUTOBUSY_MODE || 'off' },
  autoBusyMsgEnabled: { type: Boolean, default: true },
  autoBusyMsgText: { type: String, default: 'AutoPob Activated' },
  timerMsgEnabled: { type: Boolean, default: true },
  timerMsgText: { type: String, default: 'Clear Timer Expired' },

  autoBusyExitSide: { type: String, default: 'west' },
  autoBusyExitLineToleranceMeters: { type: Number, default: Number(process.env.AUTOBUSY_LINE_TOLERANCE_METERS || 50) },
  autoBusyConfirmBufferMeters: { type: Number, default: Number(process.env.AUTOBUSY_CONFIRM_BUFFER_METERS || 35) },
  autoBusyCallsignMin: { type: Number, default: Number(process.env.AUTOBUSY_CALLSIGN_MIN || 900) },
  autoBusyCallsignMax: { type: Number, default: Number(process.env.AUTOBUSY_CALLSIGN_MAX || 999) },

  showZoneLayer: { type: Boolean, default: true },
  showExitLineLayer: { type: Boolean, default: true },
  showDebugCorridorLayer: { type: Boolean, default: false },
  defaultTimerMinutes: { type: Number, default: 1 },
  zoneOverrides: { type: Array, default: [] },
  updatedAt: { type: Date, default: Date.now }
});

SettingsSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Settings', SettingsSchema);
