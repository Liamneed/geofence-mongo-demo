const mongoose = require('mongoose');

const VehicleHistoryPointSchema = new mongoose.Schema({
  callsign: { type: String, required: true, index: true },
  lat: { type: Number, required: true },
  lon: { type: Number, required: true },
  accuracy: { type: Number },
  speed: { type: Number },
  heading: { type: Number },
  status: { type: String },
  eventTime: { type: String },
  eventDate: { type: Date, index: true },
  source: { type: String, default: 'HackneyLocation webhook' },
  raw: { type: Object },
  createdAt: { type: Date, default: Date.now, index: true }
});

VehicleHistoryPointSchema.index({ callsign: 1, eventDate: -1 });

module.exports = mongoose.model('VehicleHistoryPoint', VehicleHistoryPointSchema);
