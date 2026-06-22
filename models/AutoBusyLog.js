const mongoose = require('mongoose');

const AutoBusyLogSchema = new mongoose.Schema({
  decisionKey: { type: String, index: true },
  callsign: { type: String, index: true },
  zone: { type: String, index: true },
  geofenceId: { type: String },
  result: { type: String, enum: ['pending', 'activated', 'dry-run', 'ignored', 'error', 'ok'], index: true },
  message: { type: String },
  reason: { type: String },
  statusBefore: { type: String },
  mode: { type: String },
  source: { type: String, default: 'server-auto' },
  lat: { type: Number },
  lon: { type: Number },
  eventTime: { type: String },
  ts: { type: Date, default: Date.now, index: true },
  lockId: { type: String },
  duplicateCount: { type: Number, default: 1 },
  debug: { type: Object, default: {} }
}, { timestamps: true });

AutoBusyLogSchema.index({ decisionKey: 1 }, { unique: true, sparse: true });
AutoBusyLogSchema.index({ callsign: 1, zone: 1, ts: -1 });

module.exports = mongoose.model('AutoBusyLog', AutoBusyLogSchema);
