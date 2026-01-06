// models/Geofence.js
const mongoose = require('mongoose');

const GeofenceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    geometry: {
      type: { type: String, enum: ['Polygon', 'MultiPolygon'], required: true },
      coordinates: { type: Array, required: true }
    }
  },
  {
    timestamps: true
  }
);

// 2dsphere index for spatial queries if needed
GeofenceSchema.index({ geometry: '2dsphere' });

module.exports = mongoose.model('Geofence', GeofenceSchema);
