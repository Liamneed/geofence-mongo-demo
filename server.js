// server.js
require('dotenv').config();
const express  = require('express');
const path     = require('path');
const turf     = require('@turf/turf');
const mongoose = require('mongoose');

// Use built-in fetch if available (Node 18+), otherwise lazy-import node-fetch
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));
}

const app  = express();
const PORT = process.env.PORT || 3000;

// Toggle for LIVE mode (real Autocab calls vs DRY-RUN) – used as default
const LIVE_ENABLED =
  String(process.env.AUTOBUSY_LIVE_ENABLED || '').toLowerCase() === 'true';

// Base URL for Autocab APIs (used for vehicle list + messaging/busy)
const AUTOCAB_BASE_URL =
  (process.env.AUTOCAB_BASE_URL || 'https://autocab-api.azure-api.net').replace(/\/+$/, '');

// --- MongoDB connection ---
const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geofence_demo';

mongoose
  .connect(mongoUri, { dbName: process.env.MONGO_DB || 'geofence_demo' })
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

// --- Models ---
const Geofence = require('./models/Geofence');
const Settings = require('./models/Settings');

// --- Settings helpers ---
const DEFAULT_SETTINGS = {
  name: 'global',
  mode: 'off',
  autoBusyMsgEnabled: true,
  timerMsgEnabled: true,
  autoBusyMsgText: 'AutoPob Activated',
  timerMsgText: 'Clear Timer Expired',
  defaultTimerMinutes: 1,
  zoneOverrides: [],
};

async function getOrCreateSettings() {
  let doc = await Settings.findOne({ name: 'global' });
  if (!doc) {
    doc = await Settings.create(DEFAULT_SETTINGS);
  }
  return doc;
}

function serialiseSettings(doc) {
  if (!doc) return DEFAULT_SETTINGS;
  return {
    name: 'global',
    mode: doc.mode || 'off',
    autoBusyMsgEnabled:
      typeof doc.autoBusyMsgEnabled === 'boolean' ? doc.autoBusyMsgEnabled : true,
    timerMsgEnabled:
      typeof doc.timerMsgEnabled === 'boolean' ? doc.timerMsgEnabled : true,
    autoBusyMsgText: doc.autoBusyMsgText || 'AutoPob Activated',
    timerMsgText: doc.timerMsgText || 'Clear Timer Expired',
    defaultTimerMinutes: doc.defaultTimerMinutes || 1,
    zoneOverrides: Array.isArray(doc.zoneOverrides) ? doc.zoneOverrides : [],
  };
}

// --- Middleware ---
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple request log
app.use((req, _res, next) => {
  console.log('REQ', req.method, JSON.stringify(req.url));
  next();
});

// --- In-memory state ---
// vehicleId here is your *callsign* (e.g. "113", "9997")
const lastMembership = new Map(); // callsign -> Set(geofenceIds)
const vehicles       = new Map(); // callsign -> { vehicleId, lat, lon, ts, status, autocabId, Id, registration, plateNumber }
const events         = [];        // [{ type, vehicleId, callsign, status, geofenceId, geofenceName, ts, autocabId, Id, Vehicle, ... }]

// --- Vehicle directory from Autocab (callsign → Autocab id) ---
/**
 * We poll GET /vehicle/v1/vehicles periodically and keep a map:
 *   normalisedCallsign -> { id, callsign, raw }
 */
let vehicleDirectory    = new Map();
let lastVehicleRefresh  = 0;

function normaliseCallsign(cs) {
  return String(cs || '')
    .trim()
    .toUpperCase()
    .replace(/^H/, '')    // strip leading H if you ever use H9997
    .replace(/^PH/, '');  // strip PH if you ever use PH9997
}

async function refreshVehicleDirectory(force = false) {
  const now = Date.now();
  // Only refresh every 5 minutes unless forced
  if (!force && now - lastVehicleRefresh < 5 * 60 * 1000) return;

  const subKey = process.env.AUTOCAB_SUBSCRIPTION_KEY || '';
  if (!subKey) {
    console.warn('[Vehicles] AUTOCAB_SUBSCRIPTION_KEY not configured; directory refresh skipped');
    return;
  }

  const url = `${AUTOCAB_BASE_URL}/vehicle/v1/vehicles`;
  console.log('[Vehicles] Refreshing vehicle directory from Autocab:', url);

  let res;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers: {
        'Ocp-Apim-Subscription-Key': subKey,
        'Cache-Control': 'no-cache'
      }
    });
  } catch (err) {
    console.error('[Vehicles] Fetch error during vehicle directory refresh:', err.message);
    return;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(
      '[Vehicles] Autocab /vehicle/v1/vehicles error:',
      res.status,
      body.slice(0, 400)
    );
    return;
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error('[Vehicles] Failed to parse JSON from vehicle directory:', err.message);
    return;
  }

  const nextMap = new Map();

  (data || []).forEach(v => {
    if (!v) return;
    if (v.isActive === false) return; // optional filter
    const cs = normaliseCallsign(v.callsign || v.Callsign || v.callSign);
    if (!cs) return;

    nextMap.set(cs, {
      id: v.id,           // Autocab vehicleId
      callsign: cs,
      raw: v
    });
  });

  vehicleDirectory   = nextMap;
  lastVehicleRefresh = now;

  console.log(
    `[Vehicles] Directory updated – ${vehicleDirectory.size} active vehicles loaded`
  );
}

// Initial load of vehicle directory on startup
refreshVehicleDirectory(true).catch(err =>
  console.error('Initial vehicle directory load failed:', err)
);

// Periodic refresh (every 15 minutes)
setInterval(() => {
  refreshVehicleDirectory(false).catch(err =>
    console.error('Periodic vehicle directory refresh failed:', err)
  );
}, 15 * 60 * 1000);

// --- Helpers ---
function pushEvent(ev) {
  events.push(ev);
  if (events.length > 500) events.shift(); // keep recent only
  console.log(
    `[${ev.type}] ${ev.callsign} ${ev.type === 'ENTER' ? 'ENTERED' : 'EXITED'} ` +
    `${ev.geofenceName || ev.geofenceId} at ${ev.ts} (status: ${ev.status || 'n/a'})` +
    (ev.autocabId ? ` [AutocabId ${ev.autocabId}]` : '')
  );
}

// Core geofence evaluation
// meta = { autocabId, Id, registration, plateNumber } (optional)
async function processVehiclePing(vehicleId, lat, lon, ts, status, meta = {}) {
  if (!vehicleId) return;
  if (typeof lat !== 'number' || typeof lon !== 'number') return;

  const timestamp   = ts || new Date().toISOString();
  const cleanStatus = status || 'Unknown';

  // Normalise Autocab numeric Id (vehicleId used by Autocab APIs)
  const autoId =
    (typeof meta.autocabId === 'number' && meta.autocabId) ||
    (typeof meta.Id === 'number' && meta.Id) ||
    null;

  // Track last known position (callsign keyed)
  const vehicleRecord = {
    vehicleId,
    lat,
    lon,
    ts: timestamp,
    status: cleanStatus,
    autocabId: autoId,
    Id: autoId, // expose as Id so frontend can use v.Id without overrides
    registration: meta.registration || null,
    plateNumber:  meta.plateNumber  || null
  };
  vehicles.set(vehicleId, vehicleRecord);

  // Load geofences and compute membership
  const geofences = await Geofence.find().lean();
  const point     = turf.point([lon, lat]);
  const insideNow = [];

  for (const g of geofences) {
    try {
      if (!g.geometry) continue;
      const feature = { type: 'Feature', geometry: g.geometry, properties: {} };
      if (turf.booleanPointInPolygon(point, feature)) {
        insideNow.push(String(g._id));
      }
    } catch (err) {
      console.error('Error checking geofence', g._id, err.message);
    }
  }

  const prevSet = lastMembership.get(vehicleId) || new Set();
  const nowSet  = new Set(insideNow);

  // Shared base for events
  const baseEvent = {
    vehicleId,
    callsign: vehicleId,
    status: cleanStatus,
    autocabId: vehicleRecord.autocabId,
    Id: vehicleRecord.Id,
    // add Vehicle: { Id } so frontend can use ev.Vehicle.Id if it wants
    Vehicle: vehicleRecord.Id != null ? { Id: vehicleRecord.Id } : undefined,
    registration: vehicleRecord.registration,
    plateNumber:  vehicleRecord.plateNumber,
    ts: timestamp
  };

  // ENTER events
  for (const gid of insideNow) {
    if (!prevSet.has(gid)) {
      const gf = geofences.find(x => String(x._id) === gid);
      pushEvent({
        ...baseEvent,
        type:        'ENTER',
        geofenceId:  gid,
        geofenceName: (gf && gf.name) || `Geofence ${gid}`
      });
    }
  }

  // EXIT events
  for (const gid of prevSet) {
    if (!nowSet.has(gid)) {
      const gf = geofences.find(x => String(x._id) === gid);
      pushEvent({
        ...baseEvent,
        type:        'EXIT',
        geofenceId:  gid,
        geofenceName: (gf && gf.name) || `Geofence ${gid}`
      });
    }
  }

  lastMembership.set(vehicleId, nowSet);

  return { inside: insideNow, ts: timestamp };
}

// --- Geofence CRUD ---

app.post('/api/geofences', async (req, res) => {
  try {
    const { name, geojson } = req.body;
    if (!geojson || !geojson.type) {
      return res.status(400).json({ error: 'Valid geojson Feature is required' });
    }

    const geom = geojson.geometry || geojson;
    if (!geom || !geom.type || !geom.coordinates) {
      return res.status(400).json({ error: 'Invalid geometry' });
    }

    const gf = new Geofence({
      name: name || 'Geofence',
      geometry: geom
    });

    await gf.save();
    console.log(`🟡 Geofence saved: ${gf._id} (${gf.name})`);
    res.json({ ok: true, id: gf._id, name: gf.name });
  } catch (err) {
    console.error('Error saving geofence:', err);
    res.status(500).json({ error: 'Failed to save geofence' });
  }
});

app.get('/api/geofences', async (_req, res) => {
  try {
    const geofences = await Geofence.find().lean();
    res.json(geofences);
  } catch (err) {
    console.error('Error listing geofences:', err);
    res.status(500).json({ error: 'Failed to list geofences' });
  }
});

app.put('/api/geofences/:id', async (req, res) => {
  try {
    const { name, geojson } = req.body;
    const update = {};

    if (typeof name === 'string' && name.trim()) {
      update.name = name.trim();
    }

    if (geojson) {
      const geom = geojson.geometry || geojson;
      if (!geom || !geom.type || !geom.coordinates) {
        return res.status(400).json({ error: 'Invalid geometry' });
      }
      update.geometry = geom;
    }

    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const gf = await Geofence.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!gf) return res.status(404).json({ error: 'Not found' });

    console.log(`✏️ Geofence updated: ${gf._id} (${gf.name})`);
    res.json({ ok: true, geofence: gf });
  } catch (err) {
    console.error('Error updating geofence:', err);
    res.status(500).json({ error: 'Failed to update geofence' });
  }
});

app.delete('/api/geofences/:id', async (req, res) => {
  try {
    const gf = await Geofence.findByIdAndDelete(req.params.id);
    if (!gf) return res.status(404).json({ error: 'Not found' });

    console.log(`🗑 Geofence deleted: ${gf._id} (${gf.name})`);

    // Also remove any zoneOverrides that referenced this zone
    try {
      const doc = await getOrCreateSettings();
      const before = doc.zoneOverrides.length;
      doc.zoneOverrides = (doc.zoneOverrides || []).filter(ov =>
        ov.label !== gf.name && ov.key !== gf.name.toLowerCase()
      );
      if (doc.zoneOverrides.length !== before) {
        doc.updatedAt = new Date();
        await doc.save();
        console.log(
          `🧹 Removed ${before - doc.zoneOverrides.length} override(s) for deleted zone "${gf.name}"`
        );
      }
    } catch (e) {
      console.warn('Failed to clean zoneOverrides for deleted geofence:', e.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting geofence:', err);
    res.status(500).json({ error: 'Failed to delete geofence' });
  }
});

// --- Settings API ---

app.get('/api/settings', async (_req, res) => {
  try {
    const doc = await getOrCreateSettings();
    res.json(serialiseSettings(doc));
  } catch (err) {
    console.error('Error loading settings:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const {
      mode,
      autoBusyMsgEnabled,
      timerMsgEnabled,
      autoBusyMsgText,
      timerMsgText,
      defaultTimerMinutes,
      zoneOverrides,
    } = req.body || {};

    const doc = await getOrCreateSettings();

    if (typeof mode === 'string') {
      const m = mode.toLowerCase();
      if (['off', 'dry-run', 'live'].includes(m)) {
        doc.mode = m;
      }
    }

    if (typeof autoBusyMsgEnabled === 'boolean') {
      doc.autoBusyMsgEnabled = autoBusyMsgEnabled;
    }
    if (typeof timerMsgEnabled === 'boolean') {
      doc.timerMsgEnabled = timerMsgEnabled;
    }

    if (typeof autoBusyMsgText === 'string') {
      doc.autoBusyMsgText = autoBusyMsgText.trim() || 'AutoPob Activated';
    }
    if (typeof timerMsgText === 'string') {
      doc.timerMsgText = timerMsgText.trim() || 'Clear Timer Expired';
    }

    if (Number.isFinite(defaultTimerMinutes)) {
      let v = Number(defaultTimerMinutes);
      if (v <= 0) v = 1;
      if (v > 120) v = 120;
      doc.defaultTimerMinutes = v;
    }

    if (Array.isArray(zoneOverrides)) {
      const cleaned = [];
      zoneOverrides.forEach((ov) => {
        if (!ov) return;
        let { key, label, minutes } = ov;
        if (!label && key) label = key;
        if (!label) return;
        const m = parseInt(minutes, 10);
        if (!Number.isFinite(m) || m <= 0 || m > 120) return;
        const k = (key || label).toString().toLowerCase();
        cleaned.push({ key: k, label: label.toString(), minutes: m });
      });
      doc.zoneOverrides = cleaned;
    }

    doc.updatedAt = new Date();
    await doc.save();

    res.json(serialiseSettings(doc));
  } catch (err) {
    console.error('Error saving settings:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// --- Manual tracking (for testing) ---
app.post('/api/track', async (req, res) => {
  try {
    const { vehicleId, lat, lon, ts, status } = req.body;
    if (!vehicleId || typeof lat !== 'number' || typeof lon !== 'number') {
      return res.status(400).json({ error: 'vehicleId, lat, lon are required' });
    }

    const result = await processVehiclePing(
      String(vehicleId),
      lat,
      lon,
      ts,
      status || 'Manual',
      {} // no Autocab meta in manual tests
    );

    res.json({ ok: true, inside: result?.inside || [], ts: result?.ts });
  } catch (err) {
    console.error('Error in /api/track:', err);
    res.status(500).json({ error: 'Tracking failed' });
  }
});

function normaliseWebhookBody(raw) {
  // Express normally gives us an object/array.
  // But some webhooks arrive as a JSON string and express.json can leave it as a JS string.
  let body = raw;

  // If it's a Buffer, convert to string
  if (Buffer.isBuffer(body)) {
    body = body.toString('utf8');
  }

  // If it's a string, try to JSON.parse it (once or twice)
  if (typeof body === 'string') {
    const trimmed = body.trim();

    // First parse attempt
    try {
      body = JSON.parse(trimmed);
    } catch {
      // Not JSON — leave as string
      return { body: trimmed, parsed: false };
    }

    // If it parsed into another string (double-encoded), parse again
    if (typeof body === 'string') {
      const t2 = body.trim();
      try {
        body = JSON.parse(t2);
      } catch {
        return { body: t2, parsed: false };
      }
    }

    return { body, parsed: true };
  }

  return { body, parsed: true };
}

// --- HackneyLocation / VehiclePosition handler (unified) ---
async function handleHackneyLocation(req, res) {
  try {
    const norm = normaliseWebhookBody(req.body);
    const body = norm.body;

    console.log('HackneyLocation payload on path', req.path);
    console.log('Webhook content-type:', req.headers['content-type']);
    console.log(
      'Webhook parsed:',
      norm.parsed,
      'type:',
      Array.isArray(body) ? 'array' : typeof body
    );

    // If it's still a string at this point, log a short preview and exit quickly
    if (typeof body === 'string') {
      console.log('ℹ️ Webhook body is non-location string:', body.slice(0, 200));
      return res.json({ ok: true, ignored: true, reason: 'string-body' });
    }

    // Extract VehicleTrack-like objects from any known shape
    function extractTracks(payload) {
      if (!payload) return null;

      // Shape A: { EventType, VehicleTracks: [...] }
      if (Array.isArray(payload.VehicleTracks)) return payload.VehicleTracks;

      // Shape B: top-level array
      if (Array.isArray(payload)) {
        const out = [];

        for (const item of payload) {
          if (!item) continue;

          // B1: array of envelopes: [{ EventType, VehicleTracks:[...] }, ...]
          if (Array.isArray(item.VehicleTracks)) {
            out.push(...item.VehicleTracks);
            continue;
          }

          // B2: array of raw tracks: [{ Vehicle, CurrentLocation }, ...]
          if (typeof item === 'object' && (item.Vehicle || item.CurrentLocation || item.Location || item.location)) {
            out.push(item);
            continue;
          }
        }

        return out.length ? out : null;
      }

      // Shape C: single object with Vehicle/CurrentLocation/Location
      if (
        typeof payload === 'object' &&
        (payload.Vehicle || payload.CurrentLocation || payload.Location || payload.location)
      ) {
        return [payload];
      }

      return null;
    }

    const tracks = extractTracks(body);

    if (!tracks || !tracks.length) {
      const keys =
        (body && typeof body === 'object' && !Array.isArray(body))
          ? Object.keys(body)
          : [];
      console.log('ℹ️ Ignoring location webhook payload (no usable VehicleTracks/array/object)', {
        path: req.path,
        keys,
        EventType: body && (body.EventType || body.eventType) ? (body.EventType || body.eventType) : null
      });
      return res.json({ ok: true, ignored: true, reason: 'no-tracks' });
    }

    console.log(`Processing ${tracks.length} track items`);
    if (tracks[0] && typeof tracks[0] === 'object') {
      console.log('Sample track keys:', Object.keys(tracks[0]));
    }

    const ops = tracks.map((t) => {
      if (!t || typeof t !== 'object') return null;

      // Some payloads are nested, some are flatter
      const v = t.Vehicle || t.vehicle || {};
      const loc =
        t.CurrentLocation ||
        t.currentLocation ||
        t.Location ||
        t.location ||
        {};

      // Callsign string used as primary vehicleId in our UI
      const callsign = String(
        t.vehicleId || t.VehicleId || t.callSign || t.Callsign ||
        v.Callsign || v.callsign || v.callSign ||
        v.Registration || v.registration ||
        v.PlateNumber || v.plateNumber ||
        ''
      ).trim();

      const lat = parseFloat(
        loc.Latitude ?? loc.latitude ?? t.Latitude ?? t.latitude ?? t.lat
      );
      const lon = parseFloat(
        loc.Longitude ?? loc.longitude ?? t.Longitude ?? t.longitude ?? t.lon ?? t.lng
      );

      const ts =
        t.Timestamp ||
        t.timestamp ||
        (body && body.Timestamp) ||
        (body && body.timestamp) ||
        new Date().toISOString();

      const status =
        t.VehicleStatus ||
        t.vehicleStatus ||
        (body && body.VehicleStatus) ||
        (body && body.vehicleStatus) ||
        'Unknown';

      // Try multiple places for Autocab vehicle Id (numeric)
      const autocabId =
        (typeof v.Id === 'number' && v.Id) ||
        (typeof v.VehicleId === 'number' && v.VehicleId) ||
        (typeof t.VehicleId === 'number' && t.VehicleId) ||
        (typeof t.AutocabId === 'number' && t.AutocabId) ||
        null;

      if (!callsign || Number.isNaN(lat) || Number.isNaN(lon)) {
        return null;
      }

      const meta = {
        autocabId,
        Id: autocabId,
        registration: v.Registration || v.registration || null,
        plateNumber: v.PlateNumber || v.plateNumber || null
      };

      return processVehiclePing(callsign, lat, lon, ts, status, meta);
    });

    await Promise.all(ops.filter(Boolean));
    return res.json({ ok: true, processed: tracks.length });
  } catch (err) {
    console.error('Error in HackneyLocation handler:', err);
    return res.status(500).json({ error: 'HackneyLocation failed' });
  }
}

// Match any path containing these (handles stray spaces etc.)
app.post(/(HackneyLocation|VehiclePosition|VehicleTracksChanged)/i, handleHackneyLocation);

// Acknowledge other Autocab event hooks we don't process (prevents retries/noise)
app.post(/(BookingComplete|BookingCreated|Dispatched|shift)/i, (req, res) => {
  res.json({ ok: true });
});

// --- Events for frontend (ENTER / EXIT feed) ---
app.get('/api/events', (req, res) => {
  let latest = events.slice(-200).reverse(); // newest first

  const { prefix, callsigns } = req.query;

  if (prefix) {
    latest = latest.filter(ev =>
      ev.callsign && String(ev.callsign).startsWith(String(prefix))
    );
  }

  if (callsigns) {
    const set = new Set(
      String(callsigns)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    );
    if (set.size) {
      latest = latest.filter(ev => ev.callsign && set.has(String(ev.callsign)));
    }
  }

  res.json(latest);
});

// --- Vehicles (current positions) ---
app.get('/api/vehicles', (req, res) => {
  const { prefix, ids } = req.query;
  let list = Array.from(vehicles.values());

  if (prefix) {
    list = list.filter(v =>
      v.vehicleId && String(v.vehicleId).startsWith(String(prefix))
    );
  }

  if (ids) {
    const set = new Set(
      String(ids)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    );
    if (set.size) {
      list = list.filter(v => v.vehicleId && set.has(String(v.vehicleId)));
    }
  }

  res.json(list);
});

/**
 * --- AutoBusy endpoint ---
 * Called from the frontend when AutoBusy mode is DRY-RUN or LIVE.
 * Expects JSON:
 * {
 *   callsign: "9997",
 *   status: "Busy",
 *   reason: "geofence-exit",
 *   zone: "Station",
 *   eventTime: "...",
 *   rawEvent: { ...event object from /api/events... },
 *   mode: "off" | "dry-run" | "live"
 * }
 */
app.post('/api/set-busy', async (req, res) => {
  try {
    const {
      callsign,
      status,
      reason,
      zone,
      eventTime,
      rawEvent,
      mode
    } = req.body || {};

    if (!callsign) {
      return res.status(400).json({ error: 'callsign is required' });
    }

    const payload = {
      callsign,
      status:    status || 'Busy',
      reason:    reason || 'geofence-exit',
      zone:      zone || null,
      eventTime: eventTime || new Date().toISOString(),
      rawEvent:  rawEvent || null
    };

    const baseUrlRaw = process.env.AUTOCAB_VEHICLES_URL || `${AUTOCAB_BASE_URL}/vehicle/v1/vehicles`;
    const baseUrl    = baseUrlRaw.replace(/\/+$/, '');
    const subKey     = process.env.AUTOCAB_SUBSCRIPTION_KEY || '';

    // Decide LIVE vs DRY-RUN
    const requestedMode = (mode || '').toLowerCase();
    let live;
    if (requestedMode === 'live') {
      live = true;
    } else if (requestedMode === 'dry-run' || requestedMode === 'off') {
      live = false;
    } else {
      live = LIVE_ENABLED;
    }

    // Try to resolve Autocab vehicleId from multiple sources
    const vehicleRecord = vehicles.get(String(callsign));
    let autocabId =
      (rawEvent && (
        rawEvent.autocabId ??
        rawEvent.AutocabId ??
        rawEvent.Id ??
        (rawEvent.Vehicle && rawEvent.Vehicle.Id)
      )) ||
      (vehicleRecord && (vehicleRecord.autocabId ?? vehicleRecord.Id)) ||
      null;

    // Fallback to directory if still missing
    if (!autocabId) {
      await refreshVehicleDirectory(false);
      const entry = vehicleDirectory.get(normaliseCallsign(callsign));
      if (entry && typeof entry.id === 'number') {
        autocabId = entry.id;
      }
    }

    console.log('🔁 /api/set-busy received', {
      ...payload,
      requestedMode,
      live,
      resolvedAutocabId: autocabId
    });

    // If not live, or missing config/id => DRY-RUN
    if (!live || !baseUrl || !subKey || !autocabId) {
      console.log('ℹ️ AutoBusy DRY-RUN (no live call will be made)', {
        live,
        hasBaseUrl: !!baseUrl,
        hasSubKey: !!subKey,
        autocabId
      });
      return res.json({
        ok: true,
        mode: 'dry-run',
        live,
        payload,
        meta: {
          LIVE_ENABLED,
          hasBaseUrl: !!baseUrl,
          hasSubKey: !!subKey,
          autocabId
        }
      });
    }

    const targetUrl = `${baseUrl}/${autocabId}/mobile`;
    console.log(`➡️ AutoBusy LIVE → ${targetUrl} (callsign ${callsign})`);

    const body = JSON.stringify({ vehicleId: autocabId });

    const resp = await fetchFn(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': subKey
      },
      body
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.error('❌ Busy API error', resp.status, text);
      return res.status(502).json({
        error:  'Busy API failed',
        status: resp.status,
        body:   text,
        mode:   'live',
        live:   true
      });
    }

    console.log('✅ Busy API success:', text.slice(0, 500));
    return res.json({
      ok: true,
      forwarded: true,
      status: resp.status,
      body: text,
      mode: 'live',
      live: true
    });
  } catch (err) {
    console.error('💥 Error in /api/set-busy:', err.message, err.stack);
    return res.status(500).json({
      error: 'set-busy failed',
      message: err.message
    });
  }
});

/**
 * Unified vehicle messaging endpoint.
 * Frontend sends only callsign + text:
 * {
 *   callsign: "9997",
 *   text: "AutoPob Activated",
 *   triggerType: "AUTOBUSY" | "TIMER",
 *   zone: "Train Station",
 *   rawEvent?: { ...EXIT event object... }
 * }
 *
 * Server resolves callsign → autocabId using:
 *   1) vehicleDirectory (GET /vehicle/v1/vehicles)
 *   2) rawEvent.autocabId / Vehicle.Id
 *   3) in-memory vehicles map
 */
app.post('/api/send-message', async (req, res) => {
  try {
    const {
      callsign,
      text,
      triggerType,
      zone,
      autocabId: overrideId,
      rawEvent
    } = req.body || {};

    if (!callsign || !text) {
      return res.status(400).json({ error: 'callsign and text are required' });
    }

    const csNorm = normaliseCallsign(callsign);

    // Ensure directory is reasonably fresh, then try to get id
    await refreshVehicleDirectory(false);
    let directoryEntry = vehicleDirectory.get(csNorm);

    const vehicleRecord = vehicles.get(String(callsign));

    // Resolve autocabId using:
    // 1) explicit override
    // 2) directory (polled from Autocab)
    // 3) rawEvent from EXIT
    // 4) in-memory vehicles map
    let autocabId =
      (overrideId && typeof overrideId === 'number' && overrideId) ||
      (directoryEntry && typeof directoryEntry.id === 'number' && directoryEntry.id) ||
      (rawEvent && (
        rawEvent.autocabId ??
        rawEvent.AutocabId ??
        rawEvent.Id ??
        (rawEvent.Vehicle && rawEvent.Vehicle.Id)
      )) ||
      (vehicleRecord && (vehicleRecord.autocabId ?? vehicleRecord.Id)) ||
      null;

    console.log('🔔 /api/send-message resolve', {
      callsign,
      csNorm,
      triggerType,
      zone,
      overrideId,
      directoryEntryId: directoryEntry && directoryEntry.id,
      rawEventHasVehicle: !!(rawEvent && rawEvent.Vehicle),
      resolvedAutocabId: autocabId
    });

    if (!autocabId) {
      console.warn(`⚠️ /api/send-message: no autocabId found for callsign ${callsign}`);
      return res.status(400).json({
        error: `No Autocab vehicleId found for callsign ${callsign}`
      });
    }

    const msgUrlRaw =
      process.env.AUTOCAB_MESSAGE_URL ||
      `${AUTOCAB_BASE_URL}/vehicle/v1/vehicles/message`;
    const msgUrl = msgUrlRaw.replace(/\/+$/, '');

    const subKey = process.env.AUTOCAB_SUBSCRIPTION_KEY || '';
    if (!subKey) {
      console.error('❌ /api/send-message: AUTOCAB_SUBSCRIPTION_KEY not set');
      return res.status(500).json({ error: 'Autocab subscription key not configured' });
    }

    const payload = {
      text,
      vehicles: [autocabId],
      companies: [],
      capabilities: [],
      zones: []
    };

    console.log('➡️ /api/send-message LIVE →', {
      callsign,
      autocabId,
      triggerType,
      zone,
      msgUrl
    });

    const resp = await fetchFn(msgUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Ocp-Apim-Subscription-Key': subKey
      },
      body: JSON.stringify(payload)
    });

    const bodyText = await resp.text();

    if (!resp.ok) {
      console.error('❌ Message API error', resp.status, bodyText);
      return res.status(502).json({
        ok: false,
        status: resp.status,
        body: bodyText,
        callsign,
        autocabId
      });
    }

    console.log('✅ Message sent OK →', { callsign, autocabId, triggerType, zone });

    return res.json({
      ok: true,
      callsign,
      autocabId,
      status: resp.status,
      body: bodyText
    });
  } catch (err) {
    console.error('💥 Error in /api/send-message:', err.message, err.stack);
    return res.status(500).json({
      error: 'send-message failed',
      message: err.message
    });
  }
});

// --- Debug: mock vehicle ---
app.post('/api/debug/mockVehicle', async (_req, res) => {
  try {
    const vehicleId = 'TX-DEMO-1';
    const lat       = 50.3755;
    const lon       = -4.1427;
    const ts        = new Date().toISOString();

    const result = await processVehiclePing(vehicleId, lat, lon, ts, 'Clear');
    console.log('🐟 Mock vehicle injected', {
      vehicleId,
      lat,
      lon,
      inside: result?.inside || []
    });
    res.json({ ok: true, inside: result?.inside || [] });
  } catch (err) {
    console.error('Mock vehicle failed', err);
    res.status(500).json({ error: 'mock failed' });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`🚀 Geofence server running at http://localhost:${PORT}`);
  console.log('LIVE_ENABLED:', LIVE_ENABLED);
});
