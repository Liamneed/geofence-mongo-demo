require('dotenv').config();

const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const turf = require('@turf/turf');

let fetchFn = global.fetch;
if (!fetchFn) fetchFn = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const Geofence = require('./models/Geofence');
const Settings = require('./models/Settings');
const AutoBusyLog = require('./models/AutoBusyLog');
const VehicleHistoryPoint = require('./models/VehicleHistoryPoint');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geofence_demo';
const MONGO_DB = process.env.MONGO_DB || 'geofence_demo';
const AUTOCAB_BASE_URL = (process.env.AUTOCAB_BASE_URL || 'https://autocab-api.azure-api.net').replace(/\/+$/, '');
const LIVE_ENABLED = String(process.env.AUTOBUSY_LIVE_ENABLED || '').toLowerCase() === 'true';
const TRACKER_API_KEY = String(process.env.TRACKER_API_KEY || '').trim();

const envNum = (name, fallback) => Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback;
const AUTOBUSY_LOCATION_HISTORY_POINTS = envNum('AUTOBUSY_LOCATION_HISTORY_POINTS', 20);
const AUTOBUSY_ROUTE_HISTORY_SECONDS = envNum('AUTOBUSY_ROUTE_HISTORY_SECONDS', 180);
const AUTOBUSY_MAX_EXIT_GAP_SECONDS = envNum('AUTOBUSY_MAX_EXIT_GAP_SECONDS', 120);
const AUTOBUSY_MAX_EXIT_DISTANCE_METERS = envNum('AUTOBUSY_MAX_EXIT_DISTANCE_METERS', 350);
const AUTOBUSY_LINE_TOLERANCE_METERS = envNum('AUTOBUSY_LINE_TOLERANCE_METERS', 50);
const AUTOBUSY_CONFIRM_BUFFER_METERS = envNum('AUTOBUSY_CONFIRM_BUFFER_METERS', 35);
const AUTOBUSY_DEDUPE_WINDOW_MS = envNum('AUTOBUSY_DEDUPE_WINDOW_MINUTES', 5) * 60 * 1000;
const AUTOBUSY_PENDING_LOCK_STALE_MS = envNum('AUTOBUSY_PENDING_LOCK_STALE_SECONDS', 90) * 1000;
const AUTOBUSY_PENDING_MAX_MS = envNum('AUTOBUSY_PENDING_MAX_SECONDS', 180) * 1000;
const AUTOBUSY_CALLSIGN_MIN = envNum('AUTOBUSY_CALLSIGN_MIN', 900);
const AUTOBUSY_CALLSIGN_MAX = envNum('AUTOBUSY_CALLSIGN_MAX', 999);
const AUTOBUSY_ASSUME_CLEAR_WHEN_STATUS_MISSING = String(process.env.AUTOBUSY_ASSUME_CLEAR_WHEN_STATUS_MISSING || 'false').toLowerCase() === 'true';
const VEHICLE_ONLINE_WINDOW_MS = envNum('VEHICLE_ONLINE_WINDOW_MS', 90000);

mongoose.connect(MONGO_URI, { dbName: MONGO_DB })
  .then(() => console.log(`Connected to MongoDB: ${MONGO_DB}`))
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireTrackerKey(req, res, next) {
  if (!TRACKER_API_KEY) return next();
  const supplied = String(req.headers['x-tracker-key'] || req.query.key || '').trim();
  if (supplied !== TRACKER_API_KEY) return res.status(401).json({ ok: false, error: 'Invalid tracker key' });
  return next();
}

const lastMembership = new Map();
const vehicles = new Map();
const pendingAutoPobExits = new Map();
let lastWebhook = { at: null, path: null, headers: null, body: null };
let vehicleDirectory = new Map();
let vehicleDirectoryById = new Map();
let lastVehicleRefresh = 0;

function normaliseCallsign(value) {
  return String(value || '').trim().toUpperCase().replace(/^PH/, '').replace(/^H/, '');
}

function normaliseStatus(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    value = value.Name ?? value.name ?? value.Text ?? value.text ?? value.Status ?? value.status ?? value.value ?? null;
  }
  const s = String(value ?? '').trim();
  return s || null;
}

function isClearStatus(status) {
  return String(status || '').trim().toLowerCase() === 'clear';
}

function isPolygonGeometry(geometry) {
  return !!geometry && ['Polygon', 'MultiPolygon'].includes(geometry.type);
}

function isLineGeometry(geometry) {
  return !!geometry && geometry.type === 'LineString' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2;
}

function metersBetween(a, b) {
  if (!a || !b) return Infinity;
  if (![a.lat, a.lon, b.lat, b.lon].every((v) => Number.isFinite(Number(v)))) return Infinity;
  return turf.distance(turf.point([Number(a.lon), Number(a.lat)]), turf.point([Number(b.lon), Number(b.lat)]), { units: 'kilometers' }) * 1000;
}

function toDateMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : Date.now();
}

function getRange(settings = {}) {
  const min = Number.isFinite(Number(settings.autoBusyCallsignMin)) ? Number(settings.autoBusyCallsignMin) : AUTOBUSY_CALLSIGN_MIN;
  const max = Number.isFinite(Number(settings.autoBusyCallsignMax)) ? Number(settings.autoBusyCallsignMax) : AUTOBUSY_CALLSIGN_MAX;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

function isAutoBusyEligibleCallsign(callsign, settings = {}) {
  const cs = normaliseCallsign(callsign);
  if (!/^\d+$/.test(cs)) return false;
  const n = Number(cs);
  const { min, max } = getRange(settings);
  return n >= min && n <= max;
}

const DEFAULT_SETTINGS = {
  name: 'global',
  mode: process.env.AUTOBUSY_MODE || 'off',
  autoBusyMsgEnabled: true,
  autoBusyMsgText: 'AutoPob Activated',
  timerMsgEnabled: true,
  timerMsgText: 'Clear Timer Expired',
  autoBusyExitSide: 'west',
  autoBusyExitLineToleranceMeters: AUTOBUSY_LINE_TOLERANCE_METERS,
  autoBusyConfirmBufferMeters: AUTOBUSY_CONFIRM_BUFFER_METERS,
  autoBusyCallsignMin: AUTOBUSY_CALLSIGN_MIN,
  autoBusyCallsignMax: AUTOBUSY_CALLSIGN_MAX,
  showZoneLayer: true,
  showExitLineLayer: true,
  showDebugCorridorLayer: false,
  defaultTimerMinutes: 1,
  zoneOverrides: []
};

async function getOrCreateSettings() {
  let doc = await Settings.findOne({ name: 'global' });
  if (!doc) doc = await Settings.create(DEFAULT_SETTINGS);
  return doc;
}

function serialiseSettings(doc) {
  const raw = doc && typeof doc.toObject === 'function' ? doc.toObject() : (doc || {});
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    autoBusyExitLineToleranceMeters: Number.isFinite(Number(raw.autoBusyExitLineToleranceMeters)) ? Number(raw.autoBusyExitLineToleranceMeters) : AUTOBUSY_LINE_TOLERANCE_METERS,
    autoBusyConfirmBufferMeters: Number.isFinite(Number(raw.autoBusyConfirmBufferMeters)) ? Number(raw.autoBusyConfirmBufferMeters) : AUTOBUSY_CONFIRM_BUFFER_METERS,
    autoBusyCallsignMin: Number.isFinite(Number(raw.autoBusyCallsignMin)) ? Number(raw.autoBusyCallsignMin) : AUTOBUSY_CALLSIGN_MIN,
    autoBusyCallsignMax: Number.isFinite(Number(raw.autoBusyCallsignMax)) ? Number(raw.autoBusyCallsignMax) : AUTOBUSY_CALLSIGN_MAX,
    liveAllowed: LIVE_ENABLED,
    serverRules: {
      historyPoints: AUTOBUSY_LOCATION_HISTORY_POINTS,
      routeHistorySeconds: AUTOBUSY_ROUTE_HISTORY_SECONDS,
      maxExitGapSeconds: AUTOBUSY_MAX_EXIT_GAP_SECONDS,
      maxExitDistanceMeters: AUTOBUSY_MAX_EXIT_DISTANCE_METERS,
      dedupeWindowMinutes: Math.round(AUTOBUSY_DEDUPE_WINDOW_MS / 60000)
    }
  };
}

function pick(obj, keys) {
  for (const key of keys) {
    const parts = key.split('.');
    let cur = obj;
    let ok = true;
    for (const p of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
      else { ok = false; break; }
    }
    if (ok && cur != null && cur !== '') return cur;
  }
  return undefined;
}

function toNumber(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'object') {
    for (const key of ['TotalDegrees', 'totalDegrees', 'degrees', 'Degrees', 'value', 'Value']) {
      if (value[key] != null && value[key] !== '') return Number(value[key]);
    }
  }
  return Number(value);
}

function parseLatLon(body) {
  const latRaw = pick(body, [
    'lat', 'Lat', 'latitude', 'Latitude', 'position.lat', 'position.latitude',
    'Position.Latitude', 'Location.Latitude.TotalDegrees', 'Location.Latitude.totalDegrees',
    'Location.Latitude', 'location.latitude',
    'VehicleLocation.Latitude', 'vehicleLocation.latitude', 'point.latitude'
  ]);
  const lonRaw = pick(body, [
    'lon', 'lng', 'Lon', 'Lng', 'longitude', 'Longitude', 'position.lon', 'position.lng', 'position.longitude',
    'Position.Longitude', 'Location.Longitude.TotalDegrees', 'Location.Longitude.totalDegrees',
    'Location.Longitude', 'location.longitude',
    'VehicleLocation.Longitude', 'vehicleLocation.longitude', 'point.longitude'
  ]);
  return { lat: toNumber(latRaw), lon: toNumber(lonRaw) };
}

function resolveCallsignFromVehicleId(autocabId) {
  const idNum = Number(autocabId);
  if (Number.isFinite(idNum) && vehicleDirectoryById.has(idNum)) return vehicleDirectoryById.get(idNum);
  if (String(process.env.VEHICLE_AUTOID_AS_CALLSIGN || '').toLowerCase() === 'true') return normaliseCallsign(autocabId);
  return '';
}

function normaliseHackneyLocationPayload(body) {
  const source = Array.isArray(body) ? body : (Array.isArray(body?.vehicles) ? body.vehicles : Array.isArray(body?.Vehicles) ? body.Vehicles : Array.isArray(body?.items) ? body.items : [body]);
  return source.map((item) => {
    const { lat, lon } = parseLatLon(item);
    const autocabId = pick(item, [
      'VehicleAutoID', 'VehicleAutoId', 'vehicleAutoID', 'vehicleAutoId',
      'autocabId', 'AutocabId', 'id', 'Id', 'vehicleId', 'VehicleId', 'Vehicle.Id'
    ]);
    const callsign = normaliseCallsign(pick(item, [
      'callsign', 'callSign', 'Callsign', 'CallSign', 'vehicleCallsign', 'VehicleCallsign',
      'vehicle.callsign', 'Vehicle.callsign', 'Vehicle.Callsign', 'driverCallsign', 'DriverCallsign'
    ])) || resolveCallsignFromVehicleId(autocabId);
    const status = normaliseStatus(pick(item, [
      'status', 'Status', 'vehicleStatus', 'VehicleStatus', 'state', 'State', 'vehicle.state', 'Vehicle.State', 'Vehicle.Status',
      'MeterState', 'meterState', 'BookingStatus', 'bookingStatus'
    ])) || 'Unknown';
    const eventTime = String(pick(item, ['Received', 'received', 'eventTime', 'EventTime', 'timestamp', 'Timestamp', 'time', 'Time', 'receivedAt', 'RecordedAtTime']) || new Date().toISOString());
    const speedRaw = pick(item, ['SpeedDetails.SpeedMph', 'SpeedDetails.SpeedKph', 'speed', 'Speed']);
    const headingRaw = pick(item, ['HeadingDetails.HeadingDegrees', 'heading', 'Heading', 'bearing', 'Bearing']);
    return {
      callsign,
      autocabId,
      lat,
      lon,
      accuracy: Number(pick(item, ['accuracy', 'Accuracy'])) || undefined,
      speed: toNumber(speedRaw) || undefined,
      heading: toNumber(headingRaw) || undefined,
      status,
      eventTime,
      raw: item
    };
  }).filter((x) => x.callsign && Number.isFinite(x.lat) && Number.isFinite(x.lon));
}

async function refreshVehicleDirectory(force = false) {
  const now = Date.now();
  const refreshEveryMs = envNum('VEHICLE_DIRECTORY_REFRESH_MINUTES', 15) * 60 * 1000;
  if (!force && now - lastVehicleRefresh < refreshEveryMs) return;
  const subKey = process.env.AUTOCAB_SUBSCRIPTION_KEY || '';
  if (!subKey) return;
  const url = (process.env.AUTOCAB_VEHICLES_URL || `${AUTOCAB_BASE_URL}/vehicle/v1/vehicles`).replace(/\/+$/, '');
  try {
    const res = await fetchFn(url, {
      headers: { 'Ocp-Apim-Subscription-Key': subKey, 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) {
      console.warn('[Vehicles] Directory refresh failed:', res.status, await res.text().catch(() => ''));
      return;
    }
    const data = await res.json();
    const next = new Map();
    const byId = new Map();
    for (const v of (Array.isArray(data) ? data : [])) {
      if (!v || v.isActive === false) continue;
      const cs = normaliseCallsign(v.callsign || v.Callsign || v.callSign || v.CallSign);
      const id = v.id ?? v.Id;
      if (!cs || id == null) continue;
      next.set(cs, { id, callsign: cs, raw: v });
      byId.set(Number(id), cs);
    }
    vehicleDirectory = next;
    vehicleDirectoryById = byId;
    lastVehicleRefresh = now;
    console.log(`[Vehicles] Directory loaded: ${vehicleDirectory.size}`);
  } catch (err) {
    console.warn('[Vehicles] Directory refresh error:', err.message);
  }
}

function isStationExitLineName(name, zoneName) {
  const n = String(name || '').toLowerCase();
  const z = String(zoneName || '').toLowerCase();
  return n.includes('line') && (n.includes('autobusy') || n.includes('exit') || n.includes('gate') || (z && n.includes(z)));
}

async function findAutoBusyExitLineForZone(zoneName) {
  const zoneLc = String(zoneName || '').toLowerCase();
  const lines = await Geofence.find({ 'geometry.type': 'LineString' }).lean();
  return lines.find((g) => String(g.name || '').toLowerCase().includes(zoneLc) && isStationExitLineName(g.name, zoneLc))
    || lines.find((g) => isStationExitLineName(g.name, zoneLc))
    || null;
}

function movementCrossesOrNearsExitLine({ lineGeofence, history, settings }) {
  if (!lineGeofence || !isLineGeometry(lineGeofence.geometry)) return { ok: false, reason: 'no AutoBusy exit line found', nearestMeters: null };
  const toleranceMeters = Number(settings.autoBusyExitLineToleranceMeters || AUTOBUSY_LINE_TOLERANCE_METERS);
  const exitLine = { type: 'Feature', geometry: lineGeofence.geometry, properties: {} };
  let nearestMeters = Infinity;
  let direct = false;
  let buffered = false;
  let bufferPoly = null;

  try { bufferPoly = turf.buffer(exitLine, toleranceMeters / 1000, { units: 'kilometers' }); } catch (_) {}

  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1];
    const b = history[i];
    if (![a.lat, a.lon, b.lat, b.lon].every((v) => Number.isFinite(Number(v)))) continue;
    const movement = turf.lineString([[Number(a.lon), Number(a.lat)], [Number(b.lon), Number(b.lat)]]);
    if (turf.lineIntersect(movement, exitLine).features.length > 0) direct = true;
    if (bufferPoly && turf.booleanIntersects(movement, bufferPoly)) buffered = true;
    for (const p of [a, b]) {
      const dist = turf.pointToLineDistance(turf.point([Number(p.lon), Number(p.lat)]), exitLine, { units: 'kilometers' }) * 1000;
      if (Number.isFinite(dist)) nearestMeters = Math.min(nearestMeters, dist);
    }
  }

  if (direct) return { ok: true, reason: `crossed AutoBusy line "${lineGeofence.name}"`, nearestMeters: Math.round(nearestMeters) };
  if (buffered) return { ok: true, reason: `passed through AutoBusy line buffer "${lineGeofence.name}" (${toleranceMeters}m)`, nearestMeters: Math.round(nearestMeters) };
  if (nearestMeters <= toleranceMeters) return { ok: true, reason: `passed near AutoBusy line "${lineGeofence.name}" (${Math.round(nearestMeters)}m)`, nearestMeters: Math.round(nearestMeters) };
  return { ok: false, reason: `did not cross or pass near AutoBusy line "${lineGeofence.name}" · nearest ${Math.round(nearestMeters)}m · tolerance ${toleranceMeters}m`, nearestMeters: Number.isFinite(nearestMeters) ? Math.round(nearestMeters) : null };
}

function isPointInsideBufferedGeofence(gf, point, bufferMeters) {
  try {
    const feature = { type: 'Feature', geometry: gf.geometry, properties: {} };
    const buffered = turf.buffer(feature, Number(bufferMeters || 0) / 1000, { units: 'kilometers' });
    return turf.booleanPointInPolygon(turf.point([Number(point.lon), Number(point.lat)]), buffered, { ignoreBoundary: false });
  } catch (err) {
    return true;
  }
}

function autoPobPendingKey(callsign, geofenceId) {
  return `${normaliseCallsign(callsign)}|${String(geofenceId)}`;
}

function recentHistoryFromMemoryAndDb(callsign, currentPoint) {
  const rec = vehicles.get(callsign);
  const hist = Array.isArray(rec?.history) ? rec.history.slice() : [];
  const currentMs = toDateMs(currentPoint.eventTime);
  return hist
    .filter((p) => Math.abs(currentMs - toDateMs(p.eventTime)) <= AUTOBUSY_ROUTE_HISTORY_SECONDS * 1000)
    .sort((a, b) => toDateMs(a.eventTime) - toDateMs(b.eventTime));
}

async function saveHistoryPoint(point) {
  await VehicleHistoryPoint.create({
    callsign: point.callsign,
    lat: point.lat,
    lon: point.lon,
    accuracy: point.accuracy,
    speed: point.speed,
    heading: point.heading,
    status: point.status,
    eventTime: point.eventTime,
    eventDate: new Date(toDateMs(point.eventTime)),
    source: 'HackneyLocation webhook',
    raw: point.raw
  }).catch((err) => console.warn('[History] Save failed:', err.message));

  const existing = vehicles.get(point.callsign) || {};
  const nextHist = [...(existing.history || []), point]
    .sort((a, b) => toDateMs(a.eventTime) - toDateMs(b.eventTime))
    .slice(-AUTOBUSY_LOCATION_HISTORY_POINTS);
  vehicles.set(point.callsign, { ...existing, ...point, seenAt: Date.now(), history: nextHist });
}

async function loadRecentHistory(callsign, eventTime) {
  const cutoff = new Date(toDateMs(eventTime) - AUTOBUSY_ROUTE_HISTORY_SECONDS * 1000);
  const rows = await VehicleHistoryPoint.find({ callsign, eventDate: { $gte: cutoff } }).sort({ eventDate: 1 }).limit(100).lean();
  const mem = recentHistoryFromMemoryAndDb(callsign, { eventTime });
  const merged = [...rows.map((r) => ({ callsign: r.callsign, lat: r.lat, lon: r.lon, status: r.status, eventTime: r.eventTime, source: r.source })), ...mem]
    .filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)))
    .sort((a, b) => toDateMs(a.eventTime) - toDateMs(b.eventTime));
  const out = [];
  const seen = new Set();
  for (const p of merged) {
    const key = `${p.eventTime}|${p.lat}|${p.lon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.slice(-AUTOBUSY_LOCATION_HISTORY_POINTS);
}

function buildDecisionKey({ callsign, zone, eventTime }) {
  return `AUTOBUSY-EXIT|${normaliseCallsign(callsign)}|${zone}|${eventTime}`;
}

async function writeAutoBusyLog(data, unique = false) {
  const doc = {
    callsign: normaliseCallsign(data.callsign),
    zone: data.zone,
    geofenceId: data.geofenceId,
    result: data.result,
    message: data.message,
    reason: data.reason,
    statusBefore: data.statusBefore,
    mode: data.mode,
    source: data.source || 'server-auto',
    lat: data.lat,
    lon: data.lon,
    eventTime: data.eventTime,
    ts: data.ts || new Date(),
    decisionKey: data.decisionKey,
    debug: data.debug || {}
  };
  if (unique && doc.decisionKey) {
    try {
      return await AutoBusyLog.findOneAndUpdate(
        { decisionKey: doc.decisionKey },
        { $setOnInsert: doc, $inc: { duplicateCount: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
    } catch (err) {
      console.warn('[AutoBusyLog] Unique write failed:', err.message);
    }
  }
  return AutoBusyLog.create(doc).catch((err) => console.warn('[AutoBusyLog] Write failed:', err.message));
}

async function findRecentActivation(callsign, zone) {
  if (AUTOBUSY_DEDUPE_WINDOW_MS <= 0) return null;
  return AutoBusyLog.findOne({
    callsign: normaliseCallsign(callsign),
    zone,
    result: { $in: ['activated', 'ok'] },
    ts: { $gte: new Date(Date.now() - AUTOBUSY_DEDUPE_WINDOW_MS) }
  }).sort({ ts: -1 }).lean();
}

async function acquireDecisionLock(logBase) {
  const decisionKey = logBase.decisionKey;
  if (!decisionKey) return { acquired: true };
  const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const doc = await AutoBusyLog.findOneAndUpdate(
    { decisionKey },
    { $setOnInsert: { ...logBase, result: 'pending', message: 'Auto POB pending · server lock acquired', lockId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  if (doc && doc.lockId === lockId) return { acquired: true, lockId, doc };
  if (doc && doc.result === 'pending') {
    const age = Date.now() - new Date(doc.updatedAt || doc.ts || 0).getTime();
    if (age > AUTOBUSY_PENDING_LOCK_STALE_MS) {
      const refreshed = await AutoBusyLog.findOneAndUpdate(
        { decisionKey, result: 'pending' },
        { $set: { ...logBase, result: 'pending', message: 'Auto POB pending · stale lock refreshed', lockId } },
        { new: true }
      ).lean();
      if (refreshed?.lockId === lockId) return { acquired: true, lockId, doc: refreshed };
    }
  }
  return { acquired: false, doc, reason: `duplicate blocked · existing result ${doc?.result || 'unknown'}` };
}

async function updateLockedDecision(decisionKey, patch) {
  if (!decisionKey) return null;
  return AutoBusyLog.findOneAndUpdate({ decisionKey }, { $set: patch }, { new: true }).lean();
}

async function resolveAutocabIdForCallsign(callsign, rawEvent = {}) {
  const direct = rawEvent.autocabId ?? rawEvent.AutocabId ?? rawEvent.id ?? rawEvent.Id ?? rawEvent.vehicleId ?? rawEvent.VehicleId;
  if (direct != null) return direct;
  const cs = normaliseCallsign(callsign);
  if (vehicleDirectory.has(cs)) return vehicleDirectory.get(cs).id;
  await refreshVehicleDirectory(false);
  if (vehicleDirectory.has(cs)) return vehicleDirectory.get(cs).id;
  return null;
}

async function sendAutocabVehicleMessage({ callsign, text, mode, rawEvent }) {
  const requestedMode = String(mode || '').toLowerCase();
  const live = requestedMode === 'live' && LIVE_ENABLED === true;
  if (!live) return { ok: true, sent: false, dryRun: true };
  const subKey = process.env.AUTOCAB_SUBSCRIPTION_KEY || '';
  if (!subKey) return { ok: false, sent: false, error: 'AUTOCAB_SUBSCRIPTION_KEY not configured' };
  const autocabId = await resolveAutocabIdForCallsign(callsign, rawEvent);
  if (!autocabId) return { ok: false, sent: false, error: `No Autocab vehicleId found for callsign ${callsign}` };
  const url = (process.env.AUTOCAB_MESSAGE_URL || `${AUTOCAB_BASE_URL}/vehicle/v1/vehicles/message`).replace(/\/+$/, '');
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Ocp-Apim-Subscription-Key': subKey
    },
    body: JSON.stringify({ text, vehicles: [Number(autocabId)], companies: [], capabilities: [], zones: [] })
  });
  const body = await res.text().catch(() => '');
  return { ok: res.ok, sent: res.ok, status: res.status, body, autocabId };
}

async function processAutoBusyExit({ point, gf, previousPoint, currentInside, previousInside, settings }) {
  const callsign = normaliseCallsign(point.callsign);
  const zone = gf.name || `Geofence ${gf._id}`;
  const decisionKey = buildDecisionKey({ callsign, zone, eventTime: point.eventTime });
  const baseLog = {
    decisionKey,
    callsign,
    zone,
    geofenceId: String(gf._id),
    statusBefore: point.status,
    mode: settings.mode,
    source: 'server-auto',
    lat: point.lat,
    lon: point.lon,
    eventTime: point.eventTime,
    ts: new Date()
  };

  if (!isAutoBusyEligibleCallsign(callsign, settings)) return;

  if (!isClearStatus(point.status)) {
    await writeAutoBusyLog({
      ...baseLog,
      result: 'ignored',
      message: `Ignored: vehicle was ${point.status} on EXIT`,
      reason: 'vehicle status was not Clear',
      debug: { previousInside, currentInside }
    }, true);
    return;
  }

  const history = await loadRecentHistory(callsign, point.eventTime);
  const insideHistory = history.filter((p) => {
    try {
      return turf.booleanPointInPolygon(turf.point([Number(p.lon), Number(p.lat)]), { type: 'Feature', geometry: gf.geometry, properties: {} }, { ignoreBoundary: false });
    } catch (_) {
      return false;
    }
  });

  const lastInside = insideHistory[insideHistory.length - 1] || (previousInside ? previousPoint : null);
  const gapSeconds = lastInside ? Math.round((toDateMs(point.eventTime) - toDateMs(lastInside.eventTime)) / 1000) : null;
  const jumpMeters = lastInside ? Math.round(metersBetween(lastInside, point)) : null;

  if (!lastInside || gapSeconds == null || gapSeconds > AUTOBUSY_MAX_EXIT_GAP_SECONDS) {
    await writeAutoBusyLog({
      ...baseLog,
      result: 'ignored',
      message: 'Ignored: stale Station exit — last inside point too old',
      reason: 'stale EXIT rejected',
      debug: { gapSeconds, maxExitGapSeconds: AUTOBUSY_MAX_EXIT_GAP_SECONDS, pointsChecked: history.length, lastInside }
    }, true);
    return;
  }

  if (jumpMeters != null && jumpMeters > AUTOBUSY_MAX_EXIT_DISTANCE_METERS) {
    await writeAutoBusyLog({
      ...baseLog,
      result: 'ignored',
      message: 'Ignored: stale/large jump exit — no fresh route through Station',
      reason: 'large distance jump rejected',
      debug: { jumpMeters, maxExitDistanceMeters: AUTOBUSY_MAX_EXIT_DISTANCE_METERS, gapSeconds, pointsChecked: history.length, lastInside }
    }, true);
    return;
  }

  const exitLine = await findAutoBusyExitLineForZone(zone);
  if (exitLine) {
    const lineCheck = movementCrossesOrNearsExitLine({ lineGeofence: exitLine, history, settings });
    if (!lineCheck.ok) {
      await writeAutoBusyLog({
        ...baseLog,
        result: 'ignored',
        message: `server ignored EXIT: ${lineCheck.reason}`,
        reason: lineCheck.reason,
        debug: { gapSeconds, jumpMeters, pointsChecked: history.length, nearestLineMeters: lineCheck.nearestMeters }
      }, true);
      return;
    }
    baseLog.debug = { gapSeconds, jumpMeters, pointsChecked: history.length, nearestLineMeters: lineCheck.nearestMeters, lineReason: lineCheck.reason };
  } else {
    baseLog.debug = { gapSeconds, jumpMeters, pointsChecked: history.length, lineReason: 'no exit line found; accepted by zone EXIT only' };
  }

  const recent = await findRecentActivation(callsign, zone);
  if (recent) {
    await writeAutoBusyLog({
      ...baseLog,
      result: 'ignored',
      message: 'Duplicate Auto POB blocked by server cooldown',
      reason: 'recent activation cooldown',
      debug: { recentDecisionKey: recent.decisionKey, recentAt: recent.ts, ...baseLog.debug }
    }, true);
    return;
  }

  const lock = await acquireDecisionLock(baseLog);
  if (!lock.acquired) return;

  if (String(settings.mode).toLowerCase() === 'off') {
    await updateLockedDecision(decisionKey, {
      result: 'ignored',
      message: 'Auto POB ignored · AutoBusy mode is off',
      reason: 'mode off',
      debug: baseLog.debug
    });
    return;
  }

  if (String(settings.mode).toLowerCase() === 'dry-run') {
    await updateLockedDecision(decisionKey, {
      result: 'dry-run',
      message: 'Auto POB dry-run · would send vehicle message',
      reason: 'dry-run mode',
      debug: baseLog.debug
    });
    return;
  }

  const send = await sendAutocabVehicleMessage({
    callsign,
    text: settings.autoBusyMsgText || 'AutoPob Activated',
    mode: settings.mode,
    rawEvent: point.raw
  });

  if (send.ok) {
    await updateLockedDecision(decisionKey, {
      result: 'activated',
      message: send.sent ? 'Auto POB activated · vehicle message sent' : 'Auto POB activated · dry-run/live disabled',
      reason: send.sent ? 'vehicle message sent' : 'live sending disabled',
      debug: { ...baseLog.debug, send }
    });
  } else {
    await updateLockedDecision(decisionKey, {
      result: 'error',
      message: `Auto POB failed · ${send.error || send.status || 'send error'}`,
      reason: send.error || 'Autocab send failed',
      debug: { ...baseLog.debug, send }
    });
  }
}

async function queueOrConfirmPendingExits({ point, geofences, nowSet, settings }) {
  const callsign = normaliseCallsign(point.callsign);
  const prefix = `${callsign}|`;
  const nowMs = Date.now();
  for (const [key, pending] of Array.from(pendingAutoPobExits.entries())) {
    if (!key.startsWith(prefix)) continue;
    if (!pending || nowMs - Number(pending.queuedAt || 0) > AUTOBUSY_PENDING_MAX_MS) {
      pendingAutoPobExits.delete(key);
      continue;
    }
    const gf = geofences.find((x) => String(x._id) === String(pending.geofenceId));
    if (!gf) {
      pendingAutoPobExits.delete(key);
      continue;
    }
    if (nowSet.has(String(gf._id))) {
      pendingAutoPobExits.delete(key);
      continue;
    }
    if (String(point.eventTime) === String(pending.eventTime)) continue;
    const stillInsideBufferedZone = isPointInsideBufferedGeofence(gf, point, settings.autoBusyConfirmBufferMeters || AUTOBUSY_CONFIRM_BUFFER_METERS);
    if (stillInsideBufferedZone) continue;
    pendingAutoPobExits.delete(key);
    await processAutoBusyExit({
      point: { ...point, eventTime: pending.eventTime, lat: pending.lat, lon: pending.lon, status: pending.status, raw: pending.raw },
      gf,
      previousPoint: pending.previousPoint,
      currentInside: false,
      previousInside: true,
      settings
    });
  }
}

async function runGeofenceChecksForPoint(point) {
  const settings = serialiseSettings(await getOrCreateSettings());
  const geofences = await Geofence.find({}).lean();
  const zoneGeofences = geofences.filter((g) => isPolygonGeometry(g.geometry));
  const nowSet = new Set();
  const pt = turf.point([Number(point.lon), Number(point.lat)]);

  for (const gf of zoneGeofences) {
    const feature = { type: 'Feature', geometry: gf.geometry, properties: {} };
    let inside = false;
    try { inside = turf.booleanPointInPolygon(pt, feature, { ignoreBoundary: false }); } catch (_) {}
    if (inside) nowSet.add(String(gf._id));
  }

  const prevSet = lastMembership.get(point.callsign) || new Set();
  const prevRec = vehicles.get(point.callsign) || {};
  const previousPoint = Array.isArray(prevRec.history) && prevRec.history.length >= 2 ? prevRec.history[prevRec.history.length - 2] : null;

  await queueOrConfirmPendingExits({ point, geofences: zoneGeofences, nowSet, settings });

  for (const gf of zoneGeofences) {
    const gid = String(gf._id);
    const wasInside = prevSet.has(gid);
    const isInside = nowSet.has(gid);
    if (wasInside && !isInside) {
      const key = autoPobPendingKey(point.callsign, gid);
      pendingAutoPobExits.set(key, {
        eventTime: point.eventTime,
        lat: point.lat,
        lon: point.lon,
        status: point.status,
        raw: point.raw,
        previousPoint,
        geofenceId: gid,
        queuedAt: Date.now()
      });
      await writeAutoBusyLog({
        callsign: point.callsign,
        zone: gf.name,
        geofenceId: gid,
        result: 'pending',
        message: 'Auto POB pending · waiting for next webhook confirmation',
        reason: 'EXIT detected from HackneyLocation webhook',
        statusBefore: point.status,
        mode: settings.mode,
        source: 'server-auto',
        lat: point.lat,
        lon: point.lon,
        eventTime: point.eventTime,
        decisionKey: buildDecisionKey({ callsign: point.callsign, zone: gf.name, eventTime: point.eventTime }),
        debug: { confirmBufferMeters: settings.autoBusyConfirmBufferMeters }
      }, true);
    }
  }

  lastMembership.set(point.callsign, nowSet);
}

async function handleLocationPoints(points) {
  const processed = [];
  for (const point of points) {
    point.callsign = normaliseCallsign(point.callsign);
    await saveHistoryPoint(point);
    await runGeofenceChecksForPoint(point);
    processed.push(point.callsign);
  }
  return processed;
}

app.post(['/HackneyLocation', '/hackneylocation', '/api/HackneyLocation', '/api/hackney-location'], requireTrackerKey, async (req, res) => {
  lastWebhook = { at: new Date().toISOString(), path: req.path, headers: req.headers, body: req.body };
  try {
    await refreshVehicleDirectory(false);
    const points = normaliseHackneyLocationPayload(req.body);
    if (!points.length) {
      return res.status(202).json({
        ok: true,
        received: Array.isArray(req.body) ? req.body.length : 1,
        processed: [],
        warning: 'Webhook received but no valid points after normalisation. Check callsign mapping from VehicleAutoID.'
      });
    }
    const processed = await handleLocationPoints(points);
    res.json({ ok: true, received: points.length, processed });
  } catch (err) {
    console.error('[HackneyLocation] failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/track', requireTrackerKey, async (req, res) => {
  const points = normaliseHackneyLocationPayload(req.body);
  if (!points.length) return res.status(400).json({ ok: false, error: 'No valid track point' });
  try {
    const processed = await handleLocationPoints(points);
    res.json({ ok: true, processed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/geofences', async (_req, res) => {
  res.json(await Geofence.find({}).sort({ name: 1 }).lean());
});

app.post('/api/geofences', requireTrackerKey, async (req, res) => {
  const { name, geometry, properties } = req.body;
  if (!name || !geometry) return res.status(400).json({ ok: false, error: 'name and geometry required' });
  const doc = await Geofence.create({ name, geometry, properties: properties || {} });
  res.json({ ok: true, geofence: doc });
});

app.put('/api/geofences/:id', requireTrackerKey, async (req, res) => {
  const doc = await Geofence.findByIdAndUpdate(req.params.id, { ...req.body, updatedAt: new Date() }, { new: true });
  if (!doc) return res.status(404).json({ ok: false, error: 'geofence not found' });
  res.json({ ok: true, geofence: doc });
});

app.delete('/api/geofences/:id', requireTrackerKey, async (req, res) => {
  await Geofence.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

app.get('/api/settings', async (_req, res) => {
  res.json(serialiseSettings(await getOrCreateSettings()));
});

app.post('/api/settings', requireTrackerKey, async (req, res) => {
  const allowed = [
    'mode','autoBusyMsgEnabled','autoBusyMsgText','timerMsgEnabled','timerMsgText',
    'autoBusyExitSide','autoBusyExitLineToleranceMeters','autoBusyConfirmBufferMeters',
    'autoBusyCallsignMin','autoBusyCallsignMax','showZoneLayer','showExitLineLayer','showDebugCorridorLayer','defaultTimerMinutes','zoneOverrides'
  ];
  const patch = {};
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(req.body, k)) patch[k] = req.body[k];
  const doc = await Settings.findOneAndUpdate({ name: 'global' }, { $set: patch }, { new: true, upsert: true, setDefaultsOnInsert: true });
  res.json(serialiseSettings(doc));
});

app.get('/api/autobusy/logs', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 250);
  const logs = await AutoBusyLog.find({}).sort({ ts: -1 }).limit(limit).lean();
  res.json(logs);
});

app.get('/api/vehicles', async (_req, res) => {
  const now = Date.now();
  const rows = Array.from(vehicles.values()).map((v) => ({
    callsign: v.callsign,
    lat: v.lat,
    lon: v.lon,
    status: v.status,
    eventTime: v.eventTime,
    seenAt: v.seenAt,
    online: now - Number(v.seenAt || 0) <= VEHICLE_ONLINE_WINDOW_MS,
    historyCount: Array.isArray(v.history) ? v.history.length : 0
  })).sort((a, b) => Number(a.callsign) - Number(b.callsign));
  res.json(rows);
});

app.get('/api/vehicle/:callsign/history', async (req, res) => {
  const callsign = normaliseCallsign(req.params.callsign);
  const limit = Math.min(Number(req.query.limit || 50), 250);
  const rows = await VehicleHistoryPoint.find({ callsign }).sort({ eventDate: -1 }).limit(limit).lean();
  res.json(rows);
});

app.get('/api/status', async (_req, res) => {
  res.json({
    ok: true,
    service: 'geofence-mongo-demo-webhook-stale-exit-fix',
    liveAllowed: LIVE_ENABLED,
    mongoReadyState: mongoose.connection.readyState,
    lastWebhook,
    vehiclesInMemory: vehicles.size,
    vehicleKeysInMemory: Array.from(vehicles.keys()).slice(0, 25),
    settings: serialiseSettings(await getOrCreateSettings()),
    envRules: {
      AUTOBUSY_LOCATION_HISTORY_POINTS,
      AUTOBUSY_ROUTE_HISTORY_SECONDS,
      AUTOBUSY_MAX_EXIT_GAP_SECONDS,
      AUTOBUSY_MAX_EXIT_DISTANCE_METERS,
      AUTOBUSY_LINE_TOLERANCE_METERS,
      AUTOBUSY_CONFIRM_BUFFER_METERS,
      AUTOBUSY_DEDUPE_WINDOW_MINUTES: Math.round(AUTOBUSY_DEDUPE_WINDOW_MS / 60000),
      AUTOBUSY_CALLSIGN_MIN,
      AUTOBUSY_CALLSIGN_MAX
    }
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

refreshVehicleDirectory(true).catch((err) => console.warn('Initial vehicle directory refresh failed:', err.message));
setInterval(() => refreshVehicleDirectory(false).catch(() => {}), envNum('VEHICLE_DIRECTORY_REFRESH_MINUTES', 15) * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Geofence server running on port ${PORT}`);
  console.log('AutoBusy source: /HackneyLocation webhook only. Dashboard is view/settings only.');
});
