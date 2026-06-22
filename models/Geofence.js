const mongoose = require('mongoose');

const GeofenceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  geometry: { type: Object, required: true },
  properties: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

GeofenceSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Geofence', GeofenceSchema);
