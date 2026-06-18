// models/AutoBusyLog.js
const mongoose = require('mongoose');

const AutoBusyLogSchema = new mongoose.Schema(
  {
    ts: { type: Date, default: Date.now, index: true },
    decisionKey: { type: String, default: '', index: true },
    timeLabel: { type: String, default: '' },
    callsign: { type: String, index: true },
    zone: { type: String, default: 'Zone', index: true },
    mode: { type: String, default: '' },
    result: { type: String, default: '' },
    message: { type: String, default: '' },
    statusBefore: { type: String, default: '' },
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
    eventTime: { type: String, default: '' },
    source: { type: String, default: 'frontend' },
    lockId: { type: String, default: '' },
  },
  { timestamps: true }
);

AutoBusyLogSchema.index({ callsign: 1, zone: 1, ts: -1, result: 1 });
AutoBusyLogSchema.index({ decisionKey: 1 });

module.exports = mongoose.model('AutoBusyLog', AutoBusyLogSchema);
