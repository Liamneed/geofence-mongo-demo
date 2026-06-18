// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const turf = require('@turf/turf');
const mongoose = require('mongoose');

let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));
}

const app = express();
const PORT = process.env.PORT || 3000;

const LIVE_ENABLED =
  String(process.env.AUTOBUSY_LIVE_ENABLED || '').toLowerCase() === 'true';

const AUTOCAB_BASE_URL = (
  process.env.AUTOCAB_BASE_URL || 'https://autocab-api.azure-api.net'
).replace(/\/+$/, '');

const mongoUri =
  process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/geofence_demo';

mongoose
  .connect(mongoUri, { dbName: process.env.MONGO_DB || 'geofence_demo' })
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

const Geofence = require('./models/Geofence');
const Settings = require('./models/Settings');
const AutoBusyLog = require('./models/AutoBusyLog');

const DEFAULT_SETTINGS = {
  name: 'global',
  mode: 'off',
  autoBusyMsgEnabled: true,
  timerMsgEnabled: true,
  autoBusyMsgText: 'AutoPob Activated',
  timerMsgText: 'Clear Timer Expired',
  autoBusyExitSide: 'west',
  autoBusyExitWidthPercent: 8,
  autoBusyExitLengthPercent: 100,
  autoBusyExitPositionPercent: 50,
  autoBusyExitDepthPositionPercent: 0,
  autoBusyExitLineToleranceMeters: 15,
  autoBusyConfirmBufferMeters: 8,
  autoBusyCallsignMin: 900,
  autoBusyCallsignMax: 999,
  showZoneLayer: true,
  showExitLineLayer: true,
  showDebugCorridorLayer: false,
  defaultTimerMinutes: 1,
  zoneOverrides: [],
};

async function getOrCreateSettings() {
  let doc = await Settings.findOne({ name: 'global' });
  if (!doc) doc = await Settings.create(DEFAULT_SETTINGS);
  return doc;
}

function serialiseSettings(doc) {
  if (!doc) return DEFAULT_SETTINGS;
  return {
    name: 'global',
    mode: doc.mode || 'off',
    autoBusyMsgEnabled:
      typeof doc.autoBusyMsgEnabled === 'boolean'
        ? doc.autoBusyMsgEnabled
        : true,
    timerMsgEnabled:
      typeof doc.timerMsgEnabled === 'boolean' ? doc.timerMsgEnabled : true,
    autoBusyMsgText: doc.autoBusyMsgText || 'AutoPob Activated',
    timerMsgText: doc.timerMsgText || 'Clear Timer Expired',
    autoBusyExitSide: ['west', 'east', 'north', 'south', 'any'].includes(doc.autoBusyExitSide) ? doc.autoBusyExitSide : 'west',
    autoBusyExitWidthPercent: Number.isFinite(Number(doc.autoBusyExitWidthPercent)) ? Number(doc.autoBusyExitWidthPercent) : 8,
    autoBusyExitLengthPercent: Number.isFinite(Number(doc.autoBusyExitLengthPercent)) ? Number(doc.autoBusyExitLengthPercent) : 100,
    autoBusyExitPositionPercent: Number.isFinite(Number(doc.autoBusyExitPositionPercent)) ? Number(doc.autoBusyExitPositionPercent) : 50,
    autoBusyExitDepthPositionPercent: Number.isFinite(Number(doc.autoBusyExitDepthPositionPercent)) ? Number(doc.autoBusyExitDepthPositionPercent) : 0,
    autoBusyExitLineToleranceMeters: Number.isFinite(Number(doc.autoBusyExitLineToleranceMeters)) ? Number(doc.autoBusyExitLineToleranceMeters) : 15,
    autoBusyConfirmBufferMeters: Number.isFinite(Number(doc.autoBusyConfirmBufferMeters)) ? Number(doc.autoBusyConfirmBufferMeters) : 8,
    autoBusyCallsignMin: Number.isFinite(Number(doc.autoBusyCallsignMin)) ? Number(doc.autoBusyCallsignMin) : 900,
    autoBusyCallsignMax: Number.isFinite(Number(doc.autoBusyCallsignMax)) ? Number(doc.autoBusyCallsignMax) : 999,
    showZoneLayer: typeof doc.showZoneLayer === 'boolean' ? doc.showZoneLayer : true,
    showExitLineLayer: typeof doc.showExitLineLayer === 'boolean' ? doc.showExitLineLayer : true,
    showDebugCorridorLayer: typeof doc.showDebugCorridorLayer === 'boolean' ? doc.showDebugCorridorLayer : false,
    defaultTimerMinutes: doc.defaultTimerMinutes || 1,
    zoneOverrides: Array.isArray(doc.zoneOverrides) ? doc.zoneOverrides : [],
    liveAllowed: LIVE_ENABLED,
  };
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, _res, next) => {
  console.log('REQ', req.method, JSON.stringify(req.url));
  next();
});

const lastMembership = new Map();
const vehicles = new Map();
const events = [];
const lastStatusByCallsign = new Map();
const lastUnknownLogAt = new Map();

// Auto POB safety guard:
// Do not send Auto POB on the first EXIT boundary crossing.
// Queue it, then confirm on the next location ping that the vehicle is still outside
// the zone and outside a small buffer. This prevents GPS jitter around the rank
// from placing vehicles POB while they are still effectively inside the zone.
const pendingAutoPobExits = new Map();
const AUTOBUSY_CONFIRM_BUFFER_METERS = Number.isFinite(Number(process.env.AUTOBUSY_CONFIRM_BUFFER_METERS))
  ? Number(process.env.AUTOBUSY_CONFIRM_BUFFER_METERS)
  : 8;
const AUTOBUSY_PENDING_MAX_MS = Number.isFinite(Number(process.env.AUTOBUSY_PENDING_MAX_SECONDS))
  ? Number(process.env.AUTOBUSY_PENDING_MAX_SECONDS) * 1000
  : 5 * 60 * 1000;

// If a server request crashes or Render restarts after creating a pending lock,
// do not leave the callsign blocked indefinitely. A later identical decision can
// take over a stale pending lock after this period.
const AUTOBUSY_PENDING_LOCK_STALE_MS = Number.isFinite(Number(process.env.AUTOBUSY_PENDING_LOCK_STALE_SECONDS))
  ? Number(process.env.AUTOBUSY_PENDING_LOCK_STALE_SECONDS) * 1000
  : 90 * 1000;

// Durable duplicate protection for Auto POB.
// decisionKey blocks the exact same EXIT event, but a server restart/browser-closed run
// can produce a new EXIT timestamp. This cooldown blocks repeat Auto POB sends for
// the same callsign + zone across different event timestamps.
const AUTOBUSY_DEDUPE_WINDOW_MS = Number.isFinite(Number(process.env.AUTOBUSY_DEDUPE_WINDOW_MINUTES))
  ? Number(process.env.AUTOBUSY_DEDUPE_WINDOW_MINUTES) * 60 * 1000
  : 5 * 60 * 1000;


// Hard server-side AutoBusy callsign guard.
// The dashboard 900-series toggle is only a display filter; this guard is what
// prevents Auto POB from affecting normal private-hire cars such as 199 or 405.
const AUTOBUSY_CALLSIGN_MIN = Number.isFinite(Number(process.env.AUTOBUSY_CALLSIGN_MIN))
  ? Number(process.env.AUTOBUSY_CALLSIGN_MIN)
  : 900;
const AUTOBUSY_CALLSIGN_MAX = Number.isFinite(Number(process.env.AUTOBUSY_CALLSIGN_MAX))
  ? Number(process.env.AUTOBUSY_CALLSIGN_MAX)
  : 999;

let lastWebhook = {
  at: null,
  path: null,
  headers: null,
  body: null,
};

let vehicleDirectory = new Map();
let vehicleDirectoryById = new Map();
let lastVehicleRefresh = 0;

function normaliseCallsign(cs) {
  return String(cs || '')
    .trim()
    .toUpperCase()
    .replace(/^PH/, '')
    .replace(/^H/, '');
}

function getAutoBusyCallsignRange(settings = null) {
  const min = Number.isFinite(Number(settings && settings.autoBusyCallsignMin))
    ? Number(settings.autoBusyCallsignMin)
    : AUTOBUSY_CALLSIGN_MIN;
  const max = Number.isFinite(Number(settings && settings.autoBusyCallsignMax))
    ? Number(settings.autoBusyCallsignMax)
    : AUTOBUSY_CALLSIGN_MAX;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

function isAutoBusyEligibleCallsign(cs, settings = null) {
  const normalised = normaliseCallsign(cs);
  if (!/^\d+$/.test(normalised)) return false;
  const num = Number(normalised);
  const { min, max } = getAutoBusyCallsignRange(settings);
  return num >= min && num <= max;
}

function normaliseStatus(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    value =
      value.Name ??
      value.name ??
      value.Text ??
      value.text ??
      value.Status ??
      value.status ??
      null;
  }
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function extractStatusLikePrevious(track, body) {
  const s =
    normaliseStatus(track?.VehicleStatus) ??
    normaliseStatus(track?.vehicleStatus) ??
    normaliseStatus(track?.Status) ??
    normaliseStatus(track?.status) ??
    normaliseStatus(track?.Vehicle?.VehicleStatus) ??
    normaliseStatus(track?.Vehicle?.Status) ??
    normaliseStatus(track?.VehicleState) ??
    normaliseStatus(track?.vehicleState) ??
    normaliseStatus(track?.State) ??
    normaliseStatus(track?.state) ??
    normaliseStatus(body?.VehicleStatus) ??
    normaliseStatus(body?.vehicleStatus) ??
    normaliseStatus(body?.Status) ??
    normaliseStatus(body?.status) ??
    normaliseStatus(body?.State) ??
    normaliseStatus(body?.state) ??
    null;

  return s || 'Unknown';
}

function isUnknownStatus(s) {
  if (s == null) return true;
  const v = String(s).trim().toLowerCase();
  return !v || v === 'unknown' || v === 'n/a' || v === 'na';
}

const WORKING_STATUS_CODES = new Set([
  'Clear',
  'BusyMeterOff',
  'BusyMeterOffAccount',
  'BusyMeterOnFromMeterOffCash',
  'BusyMeterOnFromMeterOffAccount',
  'BusyMeterOnFromClear',
  'JobOffered',
]);

const WORKING_STATUS_LABELS = new Set([
  'CLEAR',
  'DISPATCH',
  'DISPATCH ACC',
  'BUSY',
  'BUSY CASH',
  'BUSY ACC',
  'RANK',
  'OFFER',
]);

const VEHICLE_ONLINE_WINDOW_MS = Number(
  process.env.VEHICLE_ONLINE_WINDOW_MS || 90000
);

function isVehicleOnline(ts, seenAt) {
  const now = Date.now();
  const tsMs = Date.parse(ts || '');
  const seenMs = Number(seenAt || 0);

  const tsFresh = Number.isFinite(tsMs)
    ? now - tsMs <= VEHICLE_ONLINE_WINDOW_MS && now - tsMs >= -5 * 60 * 1000
    : false;

  const seenFresh =
    seenMs > 0
      ? now - seenMs <= VEHICLE_ONLINE_WINDOW_MS && now - seenMs >= 0
      : false;

  return tsFresh || seenFresh;
}

function resolveKnownCallsignByAutocabId(autocabId) {
  if (!autocabId) return '';
  const direct = vehicleDirectoryById.get(autocabId);
  if (direct) return direct;
  for (const rec of vehicles.values()) {
    if (rec && Number(rec.autocabId) === Number(autocabId)) {
      return normaliseCallsign(rec.callsign || rec.rawCallsign || '');
    }
  }
  return '';
}

function getWorkingStatusMeta(status, rec = {}) {
  const code = normaliseStatus(status) || 'Unknown';
  const codeLc = code.toLowerCase();

  let label = 'UNKNOWN';
  let className = 'status-text--unknown';
  let working = false;

  switch (code) {
    case 'Clear':
      label = 'CLEAR';
      className = 'status-text--clear';
      working = true;
      break;
    case 'BusyMeterOff':
      label = 'BUSY METER OFF';
      className = 'status-text--dispatched';
      working = true;
      break;
    case 'BusyMeterOffAccount':
      label = 'BUSY METER OFF ACC';
      className = 'status-text--dispatched-acc';
      working = true;
      break;
    case 'BusyMeterOnFromMeterOffCash':
      label = 'BUSY METER ON';
      className = 'status-text--pickedup-cash';
      working = true;
      break;
    case 'BusyMeterOnFromMeterOffAccount':
      label = 'BUSY METER ON ACC';
      className = 'status-text--pickedup-acc';
      working = true;
      break;
    case 'BusyMeterOnFromClear':
      label = 'STREET PICK UP';
      className = 'status-text--rank';
      working = true;
      break;
    case 'JobOffered':
      label = 'OFFER';
      className = 'status-text--offering';
      working = true;
      break;
    default:
      if (codeLc === 'rank') {
        label = 'RANK';
        className = 'status-text--rank';
        working = true;
      } else if (
        codeLc === 'notworking' ||
        codeLc === 'not working' ||
        codeLc.includes('off shift') ||
        codeLc.includes('offline') ||
        (codeLc.includes('not') && codeLc.includes('work'))
      ) {
        label = 'NOT WORKING';
        className = 'status-text--notworking';
        working = false;
      }
      break;
  }

  if (!working) {
    if (WORKING_STATUS_CODES.has(code)) working = true;
    if (WORKING_STATUS_LABELS.has(label)) working = true;
    if (rec.online) working = true;
  }

  if (working && className === 'status-text--unknown') {
    className = 'status-text--busy';
  }

  return { code, label, className, working };
}

async function refreshVehicleDirectory(force = false) {
  const now = Date.now();
  if (!force && now - lastVehicleRefresh < 5 * 60 * 1000) return;

  const subKey = process.env.AUTOCAB_SUBSCRIPTION_KEY || '';
  if (!subKey) {
    console.warn(
      '[Vehicles] AUTOCAB_SUBSCRIPTION_KEY not configured; directory refresh skipped'
    );
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
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    console.error(
      '[Vehicles] Fetch error during vehicle directory refresh:',
      err.message
    );
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
    console.error(
      '[Vehicles] Failed to parse JSON from vehicle directory:',
      err.message
    );
    return;
  }

  const nextMap = new Map();
  const nextById = new Map();

  (data || []).forEach((v) => {
    if (!v) return;
    if (v.isActive === false) return;

    const cs = normaliseCallsign(v.callsign || v.Callsign || v.callSign);
    if (!cs) return;

    const id = v.id;
    if (typeof id !== 'number') return;

    const status = normaliseStatus(
      v.status ||
        v.vehicleStatus ||
        v.VehicleStatus ||
        v.state ||
        v.State ||
        v.currentStatus ||
        v.CurrentStatus ||
        null
    );

    nextMap.set(cs, { id, callsign: cs, status, raw: v });
    nextById.set(id, cs);

    if (status) {
      lastStatusByCallsign.set(cs, status);
      const vr = vehicles.get(cs);
      if (vr) {
        vr.status = status;
        vehicles.set(cs, vr);
      }
    }
  });

  vehicleDirectory = nextMap;
  vehicleDirectoryById = nextById;
  lastVehicleRefresh = now;

  console.log(
    `[Vehicles] Directory updated – ${vehicleDirectory.size} active vehicles loaded`
  );
}

refreshVehicleDirectory(true).catch((err) =>
  console.error('Initial vehicle directory load failed:', err)
);

setInterval(() => {
  refreshVehicleDirectory(false).catch((err) =>
    console.error('Periodic vehicle directory refresh failed:', err)
  );
}, 15 * 60 * 1000);



function isPolygonGeometry(geometry) {
  return !!geometry && ['Polygon', 'MultiPolygon'].includes(geometry.type);
}

function isLineGeometry(geometry) {
  return !!geometry && geometry.type === 'LineString' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2;
}

function isStationExitLineName(name, zoneName) {
  const n = String(name || '').toLowerCase();
  const z = String(zoneName || '').toLowerCase();
  return n.includes('line') && (n.includes('autobusy') || n.includes('exit') || n.includes('gate') || (z && n.includes(z)));
}

async function findAutoBusyExitLineForZone(zoneName) {
  const zoneLc = String(zoneName || '').toLowerCase();
  if (!zoneLc) return null;
  try {
    const lines = await Geofence.find({ 'geometry.type': 'LineString' }).lean();
    return lines.find((g) => {
      const name = String(g.name || '').toLowerCase();
      return name.includes(zoneLc) && isStationExitLineName(name, zoneLc);
    }) || lines.find((g) => isStationExitLineName(g.name, zoneLc)) || null;
  } catch (err) {
    console.error('Failed to load AutoBusy exit line:', err.message);
    return null;
  }
}

function movementCrossesExitLine({ lineGeofence, prevLat, prevLon, lat, lon, settings }) {
  if (!lineGeofence || !isLineGeometry(lineGeofence.geometry)) return { ok: false, reason: 'no AutoBusy exit line found' };
  if (![prevLat, prevLon, lat, lon].every((v) => Number.isFinite(Number(v)))) {
    return { ok: false, reason: 'missing previous/current position for AutoBusy line check' };
  }

  try {
    const movement = turf.lineString([[Number(prevLon), Number(prevLat)], [Number(lon), Number(lat)]]);
    const exitLine = { type: 'Feature', geometry: lineGeofence.geometry, properties: {} };
    const toleranceMeters = Number.isFinite(Number(settings && settings.autoBusyExitLineToleranceMeters))
      ? Number(settings.autoBusyExitLineToleranceMeters)
      : (Number.isFinite(Number(process.env.AUTOBUSY_EXIT_LINE_TOLERANCE_METERS))
        ? Number(process.env.AUTOBUSY_EXIT_LINE_TOLERANCE_METERS)
        : 15);

    // 1) Ideal case: the previous->current GPS path directly intersects the drawn line.
    const directIntersections = turf.lineIntersect(movement, exitLine).features.length;
    if (directIntersections > 0) {
      return { ok: true, reason: `server confirmed EXIT across AutoBusy line "${lineGeofence.name || 'exit line'}"` };
    }

    // 2) Real GPS pings often jump from inside to outside without landing exactly on the line.
    // Buffer the drawn line and accept movement that passes through the buffered gate.
    let bufferedLine = null;
    try {
      bufferedLine = turf.buffer(exitLine, toleranceMeters / 1000, { units: 'kilometers' });
    } catch (_) {
      bufferedLine = null;
    }
    if (bufferedLine && turf.booleanIntersects(movement, bufferedLine)) {
      return { ok: true, reason: `server confirmed EXIT through AutoBusy line buffer "${lineGeofence.name || 'exit line'}" (${toleranceMeters}m)` };
    }

    // 3) Fallback: accept if the final EXIT point is close to the drawn line.
    const currentPoint = turf.point([Number(lon), Number(lat)]);
    const distanceKm = turf.pointToLineDistance(currentPoint, exitLine, { units: 'kilometers' });
    if (Number.isFinite(distanceKm) && distanceKm * 1000 <= toleranceMeters) {
      return { ok: true, reason: `server confirmed EXIT near AutoBusy line "${lineGeofence.name || 'exit line'}" (${Math.round(distanceKm * 1000)}m)` };
    }

    return { ok: false, reason: `server ignored EXIT: did not cross AutoBusy line "${lineGeofence.name || 'exit line'}" · tolerance ${toleranceMeters}m` };
  } catch (err) {
    console.error('AutoBusy line crossing check failed:', err.message);
    return { ok: false, reason: 'server ignored EXIT: AutoBusy line check failed' };
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function getPositionedSegment(min, max, lengthPercent, positionPercent) {
  const length = clampNumber(lengthPercent, 10, 100, 100) / 100;
  const position = clampNumber(positionPercent, 0, 100, 50) / 100;
  const span = max - min;
  const segment = span * length;
  let centre = min + span * position;
  let start = centre - segment / 2;
  let end = centre + segment / 2;
  if (start < min) {
    end += min - start;
    start = min;
  }
  if (end > max) {
    start -= end - max;
    end = max;
  }
  return [Math.max(min, start), Math.min(max, end)];
}

function buildDepthRange(edge, side, widthSize, depthPositionPercent) {
  const offset = (clampNumber(depthPositionPercent, -100, 100, 0) / 100) * widthSize;
  if (side === 'west' || side === 'south') {
    const start = edge + offset;
    return [start, start + widthSize];
  }
  const end = edge - offset;
  return [end - widthSize, end];
}

function buildExitStripFromBbox(bbox, settings) {
  const side = settings.autoBusyExitSide || 'west';
  if (side === 'any') return null;

  const [west, south, east, north] = bbox;
  const widthPct = clampNumber(settings.autoBusyExitWidthPercent, 2, 40, 8) / 100;
  const lonWidth = Math.max(0.000015, (east - west) * widthPct);
  const latWidth = Math.max(0.000015, (north - south) * widthPct);
  const lengthPct = clampNumber(settings.autoBusyExitLengthPercent, 10, 100, 100);
  const posPct = clampNumber(settings.autoBusyExitPositionPercent, 0, 100, 50);
  const depthPct = clampNumber(settings.autoBusyExitDepthPositionPercent, -100, 100, 0);

  let coords;
  if (side === 'west' || side === 'east') {
    const [segSouth, segNorth] = getPositionedSegment(south, north, lengthPct, posPct);
    const [x1, x2] = side === 'west'
      ? buildDepthRange(west, side, lonWidth, depthPct)
      : buildDepthRange(east, side, lonWidth, depthPct);
    coords = [[x1, segSouth], [x1, segNorth], [x2, segNorth], [x2, segSouth], [x1, segSouth]];
  } else if (side === 'north' || side === 'south') {
    const [segWest, segEast] = getPositionedSegment(west, east, lengthPct, posPct);
    const [y1, y2] = side === 'south'
      ? buildDepthRange(south, side, latWidth, depthPct)
      : buildDepthRange(north, side, latWidth, depthPct);
    coords = [[segWest, y1], [segWest, y2], [segEast, y2], [segEast, y1], [segWest, y1]];
  } else {
    return null;
  }

  return turf.polygon([coords]);
}

function isClearStatus(status) {
  return String(status || '').trim().toLowerCase() === 'clear';
}

function movementMatchesExitStrip({ gf, settings, prevLat, prevLon, lat, lon }) {
  const side = settings.autoBusyExitSide || 'west';
  if (side === 'any') return { ok: true, reason: 'any side allowed' };
  if (!Number.isFinite(prevLat) || !Number.isFinite(prevLon)) {
    return { ok: false, reason: 'missing previous position' };
  }

  const zoneName = String((gf && gf.name) || '').toLowerCase();
  const nLat = Number(lat);
  const nLon = Number(lon);

  // Station calibration from real successful Auto POB logs.
  // These are the genuine left/west Station exit coordinates used by live cars.
  // Keep this as a narrow corridor so west-side mode works without Any Side false positives.
  if (zoneName.includes('station') && side === 'west') {
    const inStationWestCorridor =
      // Calibrated from real Station Auto POB exits, including genuine
      // west/left exits around 50.37626,-4.14331 and 50.37629,-4.14354.
      // This deliberately excludes large GPS jumps such as 50.40740,-4.17896.
      nLat >= 50.37610 && nLat <= 50.37710 &&
      nLon >= -4.14505 && nLon <= -4.14320;
    if (inStationWestCorridor) {
      return { ok: true, reason: 'server confirmed Station west exit corridor' };
    }
  }

  const feature = { type: 'Feature', geometry: gf.geometry, properties: {} };
  const bbox = turf.bbox(feature);
  const strip = buildExitStripFromBbox(bbox, settings);
  if (!strip) return { ok: false, reason: 'exit strip unavailable' };

  const prevPoint = turf.point([prevLon, prevLat]);
  const exitPoint = turf.point([lon, lat]);
  const movementLine = turf.lineString([[prevLon, prevLat], [lon, lat]]);
  const prevInStrip = turf.booleanPointInPolygon(prevPoint, strip, { ignoreBoundary: false });
  const exitInStrip = turf.booleanPointInPolygon(exitPoint, strip, { ignoreBoundary: false });
  const crossedStrip = turf.lineIntersect(movementLine, strip).features.length > 0;

  const [west, south, east, north] = bbox;
  const directionalOutside =
    side === 'west' ? lon <= west :
    side === 'east' ? lon >= east :
    side === 'south' ? lat <= south :
    side === 'north' ? lat >= north :
    false;

  const ok = directionalOutside && (prevInStrip || exitInStrip || crossedStrip);
  return {
    ok,
    reason: ok
      ? `server confirmed EXIT through ${side} side`
      : `server ignored EXIT: not through ${side} side`,
  };
}

async function resolveAutocabIdForCallsign(callsign, rawEvent = null) {
  const cs = normaliseCallsign(callsign);
  const vehicleRecord = vehicles.get(cs);
  let autocabId =
    (rawEvent && (rawEvent.autocabId ?? rawEvent.AutocabId ?? rawEvent.Id ?? (rawEvent.Vehicle && rawEvent.Vehicle.Id))) ||
    (vehicleRecord && (vehicleRecord.autocabId ?? vehicleRecord.Id)) ||
    null;

  if (!autocabId) {
    await refreshVehicleDirectory(false);
    const entry = vehicleDirectory.get(cs);
    if (entry && typeof entry.id === 'number') autocabId = entry.id;
  }
  return autocabId || null;
}

async function sendAutocabVehicleMessage({ callsign, text, triggerType, zone, rawEvent, decisionKey, mode }) {
  const requestedMode = String(mode || '').toLowerCase();
  const live = requestedMode === 'live' && LIVE_ENABLED === true;
  if (!live) return { ok: true, sent: false, dryRun: true };

  const autocabId = await resolveAutocabIdForCallsign(callsign, rawEvent);
  if (!autocabId) return { ok: false, sent: false, error: `No Autocab vehicleId found for callsign ${callsign}` };

  const msgUrl = (process.env.AUTOCAB_MESSAGE_URL || `${AUTOCAB_BASE_URL}/vehicle/v1/vehicles/message`).replace(/\/+$/, '');
  const subKey = process.env.AUTOCAB_SUBSCRIPTION_KEY || '';
  if (!subKey) return { ok: false, sent: false, error: 'Autocab subscription key not configured' };

  const resp = await fetchFn(msgUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Ocp-Apim-Subscription-Key': subKey,
    },
    body: JSON.stringify({ text, vehicles: [autocabId], companies: [], capabilities: [], zones: [] }),
  });
  const bodyText = await resp.text();
  return { ok: resp.ok, sent: resp.ok, status: resp.status, body: bodyText, autocabId };
}


function autoPobPendingKey(callsign, geofenceId) {
  return `${normaliseCallsign(callsign)}|${String(geofenceId || '')}`;
}

function isPointInsideBufferedGeofence(gf, lat, lon, bufferMeters = AUTOBUSY_CONFIRM_BUFFER_METERS) {
  if (!gf || !gf.geometry || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return true;
  if (!Number.isFinite(Number(bufferMeters)) || Number(bufferMeters) <= 0) return false;
  try {
    const feature = { type: 'Feature', geometry: gf.geometry, properties: {} };
    const buffered = turf.buffer(feature, Number(bufferMeters) / 1000, { units: 'kilometers' });
    return turf.booleanPointInPolygon(turf.point([Number(lon), Number(lat)]), buffered, { ignoreBoundary: false });
  } catch (err) {
    console.error('Buffered geofence check failed:', err.message);
    // Fail safe: do not Auto POB if the safety check cannot run.
    return true;
  }
}

function autoBusyRecentCutoffDate() {
  return new Date(Date.now() - AUTOBUSY_DEDUPE_WINDOW_MS);
}

function autoBusyFinalResults() {
  return ['pending', 'activated', 'ok'];
}

function autoBusyCooldownResults() {
  // Pending is deliberately excluded here. Exact duplicate pending locks are
  // handled by acquireAutoBusyDecisionLock(). The callsign+zone cooldown should
  // only be based on a completed Auto POB so a stuck pending row cannot block a
  // genuine later job.
  return ['activated', 'ok'];
}

async function findRecentAutoBusyForCallsignZone(callsign, zone, excludeDecisionKey = '') {
  const cs = normaliseCallsign(callsign);
  if (!cs || !zone || AUTOBUSY_DEDUPE_WINDOW_MS <= 0) return null;
  const query = {
    callsign: cs,
    zone,
    ts: { $gte: autoBusyRecentCutoffDate() },
    result: { $in: autoBusyCooldownResults() },
  };
  if (excludeDecisionKey) query.decisionKey = { $ne: excludeDecisionKey };
  return AutoBusyLog.findOne(query).sort({ ts: -1 }).lean();
}

async function acquireAutoBusyDecisionLock({ decisionKey, logBase }) {
  if (!decisionKey) return { acquired: true, doc: null };
  const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const doc = await AutoBusyLog.findOneAndUpdate(
    { decisionKey },
    {
      $setOnInsert: {
        ...logBase,
        result: 'pending',
        message: 'Auto POB pending · server lock acquired',
        lockId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  if (doc && doc.lockId === lockId) return { acquired: true, doc, lockId };

  const result = String(doc && doc.result || '').toLowerCase();

  if (result === 'pending') {
    const pendingAgeMs = Date.now() - new Date(doc.updatedAt || doc.ts || 0).getTime();
    if (Number.isFinite(pendingAgeMs) && pendingAgeMs > AUTOBUSY_PENDING_LOCK_STALE_MS) {
      const refreshed = await AutoBusyLog.findOneAndUpdate(
        { decisionKey, result: 'pending', updatedAt: doc.updatedAt },
        {
          $set: {
            ...logBase,
            result: 'pending',
            message: 'Auto POB pending · stale lock refreshed',
            lockId,
          },
        },
        { new: true }
      ).lean();

      if (refreshed && refreshed.lockId === lockId) {
        return { acquired: true, doc: refreshed, lockId, refreshedStaleLock: true };
      }
    }

    return { acquired: false, doc, reason: 'Duplicate Auto POB blocked by server · decision already pending' };
  }

  if (autoBusyFinalResults().includes(result) || result === 'dry-run' || result === 'ignored') {
    return { acquired: false, doc, reason: `Duplicate Auto POB blocked by server · existing result ${doc.result}` };
  }

  return { acquired: false, doc, reason: `Duplicate Auto POB blocked by server · existing result ${doc && doc.result || 'unknown'}` };
}

async function queueServerAutoPobExit({ event, gf }) {
  if (!event || !gf) return;
  const callsign = normaliseCallsign(event.callsign);
  if (!callsign) return;
  const settings = serialiseSettings(await getOrCreateSettings());
  if (!isAutoBusyEligibleCallsign(callsign, settings)) return;
  const key = autoPobPendingKey(callsign, event.geofenceId || gf._id);
  pendingAutoPobExits.set(key, {
    event,
    geofenceId: String(event.geofenceId || gf._id),
    queuedAt: Date.now(),
  });
}

async function confirmPendingServerAutoPobExits({ callsign, geofences, nowSet, baseEvent }) {
  const cs = normaliseCallsign(callsign);
  if (!cs) return;
  const prefix = `${cs}|`;
  const nowMs = Date.now();

  for (const [key, pending] of Array.from(pendingAutoPobExits.entries())) {
    if (!key.startsWith(prefix)) continue;

    if (!pending || nowMs - Number(pending.queuedAt || 0) > AUTOBUSY_PENDING_MAX_MS) {
      pendingAutoPobExits.delete(key);
      continue;
    }

    // Do not confirm on the same ping that created the EXIT.
    // We need a later location update to prove the car has continued away from the zone.
    if (String(baseEvent.ts || '') === String(pending.event && pending.event.ts || '')) {
      continue;
    }

    const gid = String(pending.geofenceId || '');
    const gf = geofences.find((x) => String(x._id) === gid);
    if (!gf) {
      pendingAutoPobExits.delete(key);
      continue;
    }

    // If the vehicle came back inside, treat the previous EXIT as GPS bounce / rank movement.
    if (nowSet.has(gid)) {
      pendingAutoPobExits.delete(key);
      continue;
    }

    // Require the next ping to be outside a small buffered copy of the zone.
    // This is the key protection against cars being made POB while still effectively inside Station.
    const settings = serialiseSettings(await getOrCreateSettings());
    const confirmBufferMeters = Number.isFinite(Number(settings.autoBusyConfirmBufferMeters))
      ? Number(settings.autoBusyConfirmBufferMeters)
      : AUTOBUSY_CONFIRM_BUFFER_METERS;
    const stillInsideBufferedZone = isPointInsideBufferedGeofence(
      gf,
      baseEvent.lat,
      baseEvent.lon,
      confirmBufferMeters
    );
    if (stillInsideBufferedZone) {
      // Keep it pending briefly; a genuine exit should move outside the buffer on a following ping.
      continue;
    }

    pendingAutoPobExits.delete(key);

    const confirmedExitEvent = {
      ...baseEvent,
      type: 'EXIT',
      geofenceId: gid,
      geofenceName: pending.event.geofenceName || (gf && gf.name) || `Geofence ${gid}`,
      // Auto POB decision must be based on the original boundary EXIT point.
      // The later ping only confirms that the car stayed outside the zone.
      lat: pending.event.lat,
      lon: pending.event.lon,
      prevLat: pending.event.prevLat,
      prevLon: pending.event.prevLon,
      ts: pending.event.ts,
      confirmedLat: baseEvent.lat,
      confirmedLon: baseEvent.lon,
      confirmedTs: baseEvent.ts,
    };

    await runServerAutoPobForExit({ event: confirmedExitEvent, gf, currentInsideSet: nowSet });
  }
}

async function runServerAutoPobForExit({ event, gf, currentInsideSet }) {
  let errorDecisionKey = '';
  let errorBaseLog = null;
  try {
    const settings = serialiseSettings(await getOrCreateSettings());
    const mode = String(settings.mode || 'off').toLowerCase();
    const callsign = normaliseCallsign(event.callsign);
    const zone = event.geofenceName || 'Zone';
    const zoneLc = String(zone).toLowerCase();
    const decisionKey = ['AUTOBUSY-EXIT', callsign, zone, event.ts || ''].join('|');

    if (mode === 'off') return;
    if (!zoneLc.includes('station')) return;
    if (!callsign) return;
    if (!isAutoBusyEligibleCallsign(callsign, settings)) return;
    if (currentInsideSet && currentInsideSet.has(String(gf._id))) return;

    const baseLog = {
      decisionKey,
      ts: new Date(),
      callsign,
      zone,
      mode,
      statusBefore: event.status || '',
      lat: Number.isFinite(Number(event.lat)) ? Number(event.lat) : null,
      lon: Number.isFinite(Number(event.lon)) ? Number(event.lon) : null,
      eventTime: event.ts || '',
      source: 'server-auto',
    };
    errorDecisionKey = decisionKey;
    errorBaseLog = baseLog;

    const recentAutoBusy = await findRecentAutoBusyForCallsignZone(callsign, zone, decisionKey);
    if (recentAutoBusy) {
      await AutoBusyLog.findOneAndUpdate(
        { decisionKey },
        {
          $set: {
            ...baseLog,
            result: 'ignored',
            message: `Duplicate Auto POB blocked · ${callsign} already had ${recentAutoBusy.result} in ${zone} within ${Math.round(AUTOBUSY_DEDUPE_WINDOW_MS / 60000)} minutes`,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return;
    }

    const lock = await acquireAutoBusyDecisionLock({ decisionKey, logBase: baseLog });
    if (!lock.acquired) return;

    if (!isClearStatus(event.status)) {
      await AutoBusyLog.findOneAndUpdate(
        { decisionKey },
        { $set: { ...baseLog, result: 'ignored', message: `Ignored: vehicle was ${event.status || 'not Clear'} on EXIT` } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return;
    }

    const exitLine = await findAutoBusyExitLineForZone(zone);
    const sideCheck = exitLine
      ? movementCrossesExitLine({
          lineGeofence: exitLine,
          prevLat: Number(event.prevLat),
          prevLon: Number(event.prevLon),
          lat: Number(event.lat),
          lon: Number(event.lon),
          settings,
        })
      : movementMatchesExitStrip({
          gf,
          settings,
          prevLat: Number(event.prevLat),
          prevLon: Number(event.prevLon),
          lat: Number(event.lat),
          lon: Number(event.lon),
        });
    if (!sideCheck.ok) {
      await AutoBusyLog.findOneAndUpdate(
        { decisionKey },
        { $set: { ...baseLog, result: 'ignored', message: sideCheck.reason } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return;
    }

    const requestedLive = mode === 'live' && LIVE_ENABLED === true;
    const autocabId = await resolveAutocabIdForCallsign(callsign, event);
    const subKey = process.env.AUTOCAB_SUBSCRIPTION_KEY || '';
    const baseUrl = (process.env.AUTOCAB_VEHICLES_URL || `${AUTOCAB_BASE_URL}/vehicle/v1/vehicles`).replace(/\/+$/, '');

    if (!requestedLive || !autocabId || !subKey || !baseUrl) {
      const blocked = mode === 'live' && LIVE_ENABLED !== true;
      await AutoBusyLog.findOneAndUpdate(
        { decisionKey },
        { $set: { ...baseLog, result: blocked ? 'error' : 'dry-run', message: blocked ? 'Live requested but blocked by server safety lock' : `Dry run: would Auto POB · ${sideCheck.reason}` } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return;
    }

    const busyResp = await fetchFn(`${baseUrl}/${autocabId}/mobile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': subKey },
      body: JSON.stringify({ vehicleId: autocabId }),
    });
    const busyText = await busyResp.text();
    if (!busyResp.ok) {
      await AutoBusyLog.findOneAndUpdate(
        { decisionKey },
        { $set: { ...baseLog, result: 'error', message: `Auto POB failed · Busy API HTTP ${busyResp.status}: ${busyText.slice(0, 250)}` } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return;
    }

    await AutoBusyLog.findOneAndUpdate(
      { decisionKey },
      { $set: { ...baseLog, result: 'activated', message: settings.autoBusyMsgEnabled ? 'Auto POB activated · vehicle message pending' : 'Auto POB activated · message disabled' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (settings.autoBusyMsgEnabled) {
      const msg = await sendAutocabVehicleMessage({
        callsign,
        text: settings.autoBusyMsgText || 'AutoPob Activated',
        triggerType: 'AUTOBUSY',
        zone,
        rawEvent: event,
        decisionKey,
        mode,
      });
      await AutoBusyLog.findOneAndUpdate(
        { decisionKey },
        { $set: { result: 'activated', message: msg.ok ? 'Auto POB activated · vehicle message sent' : `Auto POB activated · message failed${msg.status ? ' HTTP ' + msg.status : ''}${msg.error ? ': ' + msg.error : ''}` } },
        { new: true }
      );
    }
  } catch (err) {
    console.error('💥 Server Auto POB failed:', err.message, err.stack);
    if (errorDecisionKey && errorBaseLog) {
      try {
        await AutoBusyLog.findOneAndUpdate(
          { decisionKey: errorDecisionKey },
          {
            $set: {
              ...errorBaseLog,
              result: 'error',
              message: `Auto POB failed after pending lock · ${err.message || 'unknown error'}`.slice(0, 300),
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      } catch (logErr) {
        console.error('Failed to mark Auto POB pending lock as error:', logErr.message);
      }
    }
  }
}

function pushEvent(ev) {
  events.push(ev);
  if (events.length > 500) events.shift();
  console.log(
    `[${ev.type}] ${ev.callsign} ${
      ev.type === 'ENTER' ? 'ENTERED' : 'EXITED'
    } ${ev.geofenceName || ev.geofenceId} at ${ev.ts} (status: ${
      ev.status || 'n/a'
    })` + (ev.autocabId ? ` [AutocabId ${ev.autocabId}]` : '')
  );
}

async function processVehiclePing(vehicleId, lat, lon, ts, status, meta = {}) {
  const autoId =
    (typeof meta.autocabId === 'number' && meta.autocabId) ||
    (typeof meta.Id === 'number' && meta.Id) ||
    null;

  const resolvedCallsign =
    normaliseCallsign(meta.callsign || meta.rawCallsign || '') ||
    resolveKnownCallsignByAutocabId(autoId) ||
    normaliseCallsign(vehicleId);

  const canonical = resolvedCallsign;
  if (!canonical) return;
  if (typeof lat !== 'number' || typeof lon !== 'number') return;

  const timestamp = ts || new Date().toISOString();

  const incoming = normaliseStatus(status) || 'Unknown';
  const cached = normaliseStatus(lastStatusByCallsign.get(canonical));
  const dirEntry = vehicleDirectory.get(canonical);
  const dirStatus = normaliseStatus(dirEntry ? dirEntry.status : null);

  const cleanStatus = !isUnknownStatus(incoming)
    ? incoming
    : cached || dirStatus || 'Unknown';

  if (cleanStatus && !isUnknownStatus(cleanStatus)) {
    lastStatusByCallsign.set(canonical, cleanStatus);
  } else {
    const now = Date.now();
    const last = lastUnknownLogAt.get(canonical) || 0;
    if (now - last > 15000) {
      lastUnknownLogAt.set(canonical, now);
      console.log('⚠️ Status still Unknown after fallback', {
        callsign: canonical,
        incoming,
        cached,
        dirStatus,
        hasDirEntry: !!dirEntry,
        autocabId:
          (typeof meta.autocabId === 'number' && meta.autocabId) ||
          (typeof meta.Id === 'number' && meta.Id) ||
          null,
      });
    }
  }

  const previousVehicleRecord = vehicles.get(canonical) || null;
  const prevLat = previousVehicleRecord && Number.isFinite(Number(previousVehicleRecord.lat))
    ? Number(previousVehicleRecord.lat)
    : null;
  const prevLon = previousVehicleRecord && Number.isFinite(Number(previousVehicleRecord.lon))
    ? Number(previousVehicleRecord.lon)
    : null;

  const vehicleRecord = {
    vehicleId: canonical,
    callsign: canonical,
    rawCallsign:
      normaliseCallsign(meta.callsign || meta.rawCallsign || '') || canonical,
    lat,
    lon,
    ts: timestamp,
    seenAt: Date.now(),
    status: cleanStatus,
    autocabId: autoId,
    Id: autoId,
    registration: meta.registration || null,
    plateNumber: meta.plateNumber || null,
  };

  vehicles.set(canonical, vehicleRecord);

  const geofences = await Geofence.find().lean();
  const point = turf.point([lon, lat]);
  const insideNow = [];

  for (const g of geofences) {
    try {
      if (!isPolygonGeometry(g.geometry)) continue;
      const feature = { type: 'Feature', geometry: g.geometry, properties: {} };
      if (turf.booleanPointInPolygon(point, feature)) {
        insideNow.push(String(g._id));
      }
    } catch (err) {
      console.error('Error checking geofence', g._id, err.message);
    }
  }

  const prevSet = lastMembership.get(canonical) || new Set();
  const nowSet = new Set(insideNow);

  const baseEvent = {
    vehicleId: canonical,
    callsign: canonical,
    rawCallsign: vehicleRecord.rawCallsign || canonical,
    status: cleanStatus,
    autocabId: vehicleRecord.autocabId,
    Id: vehicleRecord.Id,
    Vehicle: vehicleRecord.Id != null ? { Id: vehicleRecord.Id } : undefined,
    registration: vehicleRecord.registration,
    plateNumber: vehicleRecord.plateNumber,
    lat,
    lon,
    prevLat,
    prevLon,
    ts: timestamp,
  };

  for (const gid of insideNow) {
    if (!prevSet.has(gid)) {
      const gf = geofences.find((x) => String(x._id) === gid);
      pushEvent({
        ...baseEvent,
        type: 'ENTER',
        geofenceId: gid,
        geofenceName: (gf && gf.name) || `Geofence ${gid}`,
      });
    }
  }

  for (const gid of prevSet) {
    if (!nowSet.has(gid)) {
      const gf = geofences.find((x) => String(x._id) === gid);
      const exitEvent = {
        ...baseEvent,
        type: 'EXIT',
        geofenceId: gid,
        geofenceName: (gf && gf.name) || `Geofence ${gid}`,
      };
      pushEvent(exitEvent);
      // Queue Auto POB for server-side confirmation on the next location ping.
      // This keeps Auto POB independent of the browser, but prevents GPS boundary bounce
      // from placing vehicles POB while they are still effectively inside the zone.
      await queueServerAutoPobExit({ event: exitEvent, gf });
    }
  }

  await confirmPendingServerAutoPobExits({
    callsign: canonical,
    geofences,
    nowSet,
    baseEvent,
  });

  lastMembership.set(canonical, nowSet);

  return { inside: insideNow, ts: timestamp };
}

app.post('/api/geofences', async (req, res) => {
  try {
    const { name, geojson } = req.body;
    if (!geojson || !geojson.type) {
      return res
        .status(400)
        .json({ error: 'Valid geojson Feature is required' });
    }

    const geom = geojson.geometry || geojson;
    if (!geom || !geom.type || !geom.coordinates) {
      return res.status(400).json({ error: 'Invalid geometry' });
    }

    const gf = new Geofence({ name: name || 'Geofence', geometry: geom });
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

    if (typeof name === 'string' && name.trim()) update.name = name.trim();

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

    const gf = await Geofence.findByIdAndUpdate(req.params.id, update, {
      new: true,
    });
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

    try {
      const doc = await getOrCreateSettings();
      const before = doc.zoneOverrides.length;
      doc.zoneOverrides = (doc.zoneOverrides || []).filter(
        (ov) => ov.label !== gf.name && ov.key !== gf.name.toLowerCase()
      );
      if (doc.zoneOverrides.length !== before) {
        doc.updatedAt = new Date();
        await doc.save();
        console.log(
          `🧹 Removed ${
            before - doc.zoneOverrides.length
          } override(s) for deleted zone "${gf.name}"`
        );
      }
    } catch (e) {
      console.warn(
        'Failed to clean zoneOverrides for deleted geofence:',
        e.message
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting geofence:', err);
    res.status(500).json({ error: 'Failed to delete geofence' });
  }
});

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
      autoBusyExitSide,
      autoBusyExitWidthPercent,
      autoBusyExitLengthPercent,
      autoBusyExitPositionPercent,
      autoBusyExitDepthPositionPercent,
      autoBusyExitLineToleranceMeters,
      autoBusyConfirmBufferMeters,
      autoBusyCallsignMin,
      autoBusyCallsignMax,
      showZoneLayer,
      showExitLineLayer,
      showDebugCorridorLayer,
      defaultTimerMinutes,
      zoneOverrides,
    } = req.body || {};

    const doc = await getOrCreateSettings();

    if (typeof mode === 'string') {
      const m = mode.toLowerCase();
      if (['off', 'dry-run', 'live'].includes(m)) doc.mode = m;
    }

    if (typeof autoBusyMsgEnabled === 'boolean')
      doc.autoBusyMsgEnabled = autoBusyMsgEnabled;
    if (typeof timerMsgEnabled === 'boolean')
      doc.timerMsgEnabled = timerMsgEnabled;

    if (typeof autoBusyMsgText === 'string')
      doc.autoBusyMsgText = autoBusyMsgText.trim() || 'AutoPob Activated';
    if (typeof timerMsgText === 'string')
      doc.timerMsgText = timerMsgText.trim() || 'Clear Timer Expired';

    if (typeof autoBusyExitSide === 'string') {
      const side = autoBusyExitSide.trim().toLowerCase();
      if (['west', 'east', 'north', 'south', 'any'].includes(side)) {
        doc.autoBusyExitSide = side;
      }
    }

    if (Number.isFinite(Number(autoBusyExitWidthPercent))) {
      let width = Number(autoBusyExitWidthPercent);
      if (width < 2) width = 2;
      if (width > 40) width = 40;
      doc.autoBusyExitWidthPercent = width;
    }

    if (Number.isFinite(Number(autoBusyExitLengthPercent))) {
      let length = Number(autoBusyExitLengthPercent);
      if (length < 10) length = 10;
      if (length > 100) length = 100;
      doc.autoBusyExitLengthPercent = length;
    }

    if (Number.isFinite(Number(autoBusyExitPositionPercent))) {
      let position = Number(autoBusyExitPositionPercent);
      if (position < 0) position = 0;
      if (position > 100) position = 100;
      doc.autoBusyExitPositionPercent = position;
    }

    if (Number.isFinite(Number(autoBusyExitDepthPositionPercent))) {
      let depthPosition = Number(autoBusyExitDepthPositionPercent);
      if (depthPosition < -100) depthPosition = -100;
      if (depthPosition > 100) depthPosition = 100;
      doc.autoBusyExitDepthPositionPercent = depthPosition;
    }

    if (Number.isFinite(Number(autoBusyExitLineToleranceMeters))) {
      let tolerance = Number(autoBusyExitLineToleranceMeters);
      if (tolerance < 1) tolerance = 1;
      if (tolerance > 50) tolerance = 50;
      doc.autoBusyExitLineToleranceMeters = tolerance;
    }

    if (Number.isFinite(Number(autoBusyConfirmBufferMeters))) {
      let buffer = Number(autoBusyConfirmBufferMeters);
      if (buffer < 0) buffer = 0;
      if (buffer > 50) buffer = 50;
      doc.autoBusyConfirmBufferMeters = buffer;
    }

    if (Number.isFinite(Number(autoBusyCallsignMin))) {
      let min = Number(autoBusyCallsignMin);
      if (min < 0) min = 0;
      if (min > 9999) min = 9999;
      doc.autoBusyCallsignMin = min;
    }

    if (Number.isFinite(Number(autoBusyCallsignMax))) {
      let max = Number(autoBusyCallsignMax);
      if (max < 0) max = 0;
      if (max > 9999) max = 9999;
      doc.autoBusyCallsignMax = max;
    }

    if (typeof showZoneLayer === 'boolean') doc.showZoneLayer = showZoneLayer;
    if (typeof showExitLineLayer === 'boolean') doc.showExitLineLayer = showExitLineLayer;
    if (typeof showDebugCorridorLayer === 'boolean') doc.showDebugCorridorLayer = showDebugCorridorLayer;

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


function buildAutoBusyLogQueryFromReq(req) {
  const query = {};

  const result = String(req.query.result || '').trim().toLowerCase();
  if (result && result !== 'all') {
    if (result === 'activated' || result === 'ok') {
      query.result = { $in: ['activated', 'ok'] };
    } else {
      query.result = result;
    }
  }

  const mode = String(req.query.mode || '').trim().toLowerCase();
  if (mode && mode !== 'all') query.mode = mode;

  const callsign = String(req.query.callsign || '').trim();
  if (callsign && callsign !== 'all') {
    query.callsign = new RegExp(callsign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const datePreset = String(req.query.datePreset || '').trim().toLowerCase();
  const fromRaw = String(req.query.from || '').trim();
  const toRaw = String(req.query.to || '').trim();
  const now = new Date();
  let fromDate = null;
  let toDate = null;

  if (datePreset === 'today') {
    fromDate = new Date(now);
    fromDate.setHours(0, 0, 0, 0);
  } else if (datePreset === '24h') {
    fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  } else if (datePreset === '7d') {
    fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  } else if (datePreset === '30d') {
    fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  }

  if (fromRaw) {
    const d = new Date(fromRaw);
    if (!Number.isNaN(d.getTime())) fromDate = d;
  }
  if (toRaw) {
    const d = new Date(toRaw);
    if (!Number.isNaN(d.getTime())) toDate = d;
  }

  if (fromDate || toDate) {
    query.ts = {};
    if (fromDate) query.ts.$gte = fromDate;
    if (toDate) query.ts.$lte = toDate;
  }

  const q = String(req.query.q || '').trim();
  if (q) {
    const safeRegex = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safeRegex, 'i');
    query.$or = [
      { callsign: rx },
      { zone: rx },
      { result: rx },
      { mode: rx },
      { message: rx },
      { statusBefore: rx },
      { eventTime: rx },
      { timeLabel: rx },
      { source: rx },
      { decisionKey: rx },
    ];
  }

  return query;
}

function autoBusyDedupePipeline(matchQuery, limit = 500) {
  return [
    { $match: matchQuery },
    { $sort: { ts: -1, createdAt: -1 } },
    {
      $addFields: {
        _dedupeKey: {
          $cond: [
            { $and: [{ $ne: ['$decisionKey', null] }, { $ne: ['$decisionKey', ''] }] },
            '$decisionKey',
            {
              $concat: [
                { $ifNull: ['$callsign', ''] }, '|',
                { $ifNull: ['$zone', ''] }, '|',
                { $ifNull: ['$eventTime', ''] }, '|',
                { $ifNull: ['$result', ''] }, '|',
                { $ifNull: ['$statusBefore', ''] }
              ]
            }
          ]
        }
      }
    },
    { $group: { _id: '$_dedupeKey', row: { $first: '$$ROOT' }, duplicateCount: { $sum: 1 } } },
    { $replaceRoot: { newRoot: { $mergeObjects: ['$row', { duplicateCount: '$duplicateCount' }] } } },
    { $sort: { ts: -1, createdAt: -1 } },
    { $limit: limit }
  ];
}

app.get('/api/autobusy-logs', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '500', 10), 1), 5000);
    const query = buildAutoBusyLogQueryFromReq(req);
    const logs = await AutoBusyLog.aggregate(autoBusyDedupePipeline(query, limit));
    res.json(logs);
  } catch (err) {
    console.error('Error loading AutoBusy logs:', err);
    res.status(500).json({ error: 'Failed to load AutoBusy logs' });
  }
});

app.get('/api/autobusy-logs/summary', async (req, res) => {
  try {
    const query = buildAutoBusyLogQueryFromReq(req);
    const callsignQuery = { ...query };
    delete callsignQuery.callsign;

    const [summary, recentCalls] = await Promise.all([
      AutoBusyLog.aggregate([
        ...autoBusyDedupePipeline(query, 100000),
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            activated: { $sum: { $cond: [{ $in: ['$result', ['activated', 'ok']] }, 1, 0] } },
            dryRun: { $sum: { $cond: [{ $eq: ['$result', 'dry-run'] }, 1, 0] } },
            ignored: { $sum: { $cond: [{ $eq: ['$result', 'ignored'] }, 1, 0] } },
            errors: { $sum: { $cond: [{ $eq: ['$result', 'error'] }, 1, 0] } },
            live: { $sum: { $cond: [{ $eq: ['$mode', 'live'] }, 1, 0] } },
            firstTs: { $min: '$ts' },
            lastTs: { $max: '$ts' },
            rawDuplicateRowsHidden: { $sum: { $subtract: ['$duplicateCount', 1] } },
          },
        },
      ]),
      AutoBusyLog.aggregate([
        ...autoBusyDedupePipeline(callsignQuery, 100000),
        { $match: { callsign: { $exists: true, $ne: '' } } },
        { $group: { _id: '$callsign', count: { $sum: 1 }, lastTs: { $max: '$ts' } } },
        { $sort: { lastTs: -1 } },
        { $limit: 250 },
      ]),
    ]);

    res.json({
      ...(summary[0] || {
        total: 0,
        activated: 0,
        dryRun: 0,
        ignored: 0,
        errors: 0,
        live: 0,
        rawDuplicateRowsHidden: 0,
        firstTs: null,
        lastTs: null,
      }),
      callsigns: recentCalls.map(row => ({ callsign: row._id, count: row.count, lastTs: row.lastTs })),
    });
  } catch (err) {
    console.error('Error loading AutoBusy log summary:', err);
    res.status(500).json({ error: 'Failed to load AutoBusy log summary' });
  }
});

app.post('/api/autobusy-logs/normalise', async (req, res) => {
  try {
    const confirmed = String(req.query.confirm || '').toLowerCase() === 'yes';
    if (!confirmed) {
      return res.status(400).json({ error: 'Missing confirm=yes' });
    }

    const okResult = await AutoBusyLog.updateMany(
      { result: 'ok' },
      { $set: { result: 'activated' } }
    );

    // Remove duplicate rows where older browser versions saved repeated ignored entries
    // without a decisionKey. This keeps the newest row per callsign/zone/event/result/status.
    const duplicateGroups = await AutoBusyLog.aggregate([
      {
        $group: {
          _id: {
            callsign: '$callsign',
            zone: '$zone',
            eventTime: '$eventTime',
            result: '$result',
            statusBefore: '$statusBefore',
          },
          ids: { $push: '$_id' },
          newest: { $max: '$ts' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]);

    let duplicateDeleted = 0;
    for (const group of duplicateGroups) {
      const ids = group.ids || [];
      if (ids.length <= 1) continue;
      const rows = await AutoBusyLog.find({ _id: { $in: ids } }).sort({ ts: -1 }).select('_id').lean();
      const keep = rows[0] && String(rows[0]._id);
      const removeIds = rows.map(r => r._id).filter(id => String(id) !== keep);
      if (removeIds.length) {
        const del = await AutoBusyLog.deleteMany({ _id: { $in: removeIds } });
        duplicateDeleted += del.deletedCount || 0;
      }
    }

    res.json({
      ok: true,
      normalisedOkToActivated: okResult.modifiedCount || 0,
      duplicateDeleted,
    });
  } catch (err) {
    console.error('Error normalising AutoBusy logs:', err);
    res.status(500).json({ error: 'Failed to normalise AutoBusy logs' });
  }
});

app.delete('/api/autobusy-logs', async (req, res) => {
  try {
    const query = buildAutoBusyLogQueryFromReq(req);
    const confirmed = String(req.query.confirm || '').toLowerCase() === 'yes';
    if (!confirmed) {
      return res.status(400).json({ error: 'Missing confirm=yes' });
    }
    const result = await AutoBusyLog.deleteMany(query);
    res.json({ ok: true, deletedCount: result.deletedCount || 0 });
  } catch (err) {
    console.error('Error deleting AutoBusy logs:', err);
    res.status(500).json({ error: 'Failed to delete AutoBusy logs' });
  }
});

app.post('/api/autobusy-logs', async (req, res) => {
  try {
    const body = req.body || {};
    const payload = {
      ts: body.ts ? new Date(body.ts) : new Date(),
      timeLabel: body.timeLabel || '',
      callsign: body.callsign || '',
      zone: body.zone || 'Zone',
      mode: body.mode || '',
      result: String(body.result || '').toLowerCase() === 'ok' ? 'activated' : (body.result || ''),
      message: body.message || '',
      statusBefore: body.statusBefore || '',
      lat: Number.isFinite(Number(body.lat)) ? Number(body.lat) : null,
      lon: Number.isFinite(Number(body.lon)) ? Number(body.lon) : null,
      eventTime: body.eventTime || '',
      source: body.source || 'frontend',
      decisionKey: body.decisionKey || '',
    };

    let doc;
    if (payload.decisionKey) {
      doc = await AutoBusyLog.findOneAndUpdate(
        { decisionKey: payload.decisionKey },
        { $set: payload },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } else {
      doc = await AutoBusyLog.create(payload);
    }

    res.json({ ok: true, id: doc._id });
  } catch (err) {
    console.error('Error saving AutoBusy log:', err);
    res.status(500).json({ error: 'Failed to save AutoBusy log' });
  }
});


app.post('/api/track', async (req, res) => {
  try {
    const { vehicleId, lat, lon, ts, status } = req.body;
    if (!vehicleId || typeof lat !== 'number' || typeof lon !== 'number') {
      return res
        .status(400)
        .json({ error: 'vehicleId, lat, lon are required' });
    }

    const result = await processVehiclePing(
      String(vehicleId),
      lat,
      lon,
      ts,
      status || 'Manual',
      { rawCallsign: vehicleId }
    );
    res.json({ ok: true, inside: result?.inside || [], ts: result?.ts });
  } catch (err) {
    console.error('Error in /api/track:', err);
    res.status(500).json({ error: 'Tracking failed' });
  }
});

function normaliseWebhookBody(raw) {
  let body = raw;

  if (Buffer.isBuffer(body)) body = body.toString('utf8');

  if (typeof body === 'string') {
    const trimmed = body.trim();
    try {
      body = JSON.parse(trimmed);
    } catch {
      return { body: trimmed, parsed: false };
    }

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

async function handleHackneyLocation(req, res) {
  try {
    const norm = normaliseWebhookBody(req.body);
    const body = norm.body;

    lastWebhook = {
      at: new Date().toISOString(),
      path: req.path,
      headers: {
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
      },
      body,
    };

    console.log('--- WEBHOOK HIT ---', req.path);
    console.log('Webhook content-type:', req.headers['content-type']);
    console.log(
      'Webhook parsed:',
      norm.parsed,
      'type:',
      Array.isArray(body) ? 'array' : typeof body
    );

    const bodyType = Array.isArray(body) ? 'array' : typeof body;
    const topKeys =
      body && !Array.isArray(body) && typeof body === 'object'
        ? Object.keys(body)
        : [];
    console.log(
      'Webhook bodyType:',
      bodyType,
      'top-level keys:',
      topKeys.slice(0, 50)
    );

    try {
      console.log('Webhook body preview:', JSON.stringify(body).slice(0, 1500));
    } catch (e) {
      console.log('Webhook body preview: <unstringifiable>', e.message);
    }

    if (typeof body === 'string') {
      console.log(
        'ℹ️ Webhook body is non-location string:',
        body.slice(0, 200)
      );
      return res.json({ ok: true, ignored: true, reason: 'string-body' });
    }

    let tracks = null;

    if (body && Array.isArray(body.VehicleTracks)) tracks = body.VehicleTracks;
    else if (body && Array.isArray(body.VehicleTracksArray)) tracks = body.VehicleTracksArray;
    else if (body && Array.isArray(body.VehicleTracksChanged)) tracks = body.VehicleTracksChanged;
    else if (body && Array.isArray(body.Tracks)) tracks = body.Tracks;
    else if (Array.isArray(body)) tracks = body;
    else if (body && typeof body === 'object') tracks = [body];

    if (!tracks || !tracks.length) {
      const keys = body && typeof body === 'object' ? Object.keys(body) : [];
      console.log('ℹ️ Ignoring location webhook payload (no tracks)', {
        path: req.path,
        keys,
      });
      return res.json({ ok: true, ignored: true, reason: 'no-tracks' });
    }

    console.log(`Processing ${tracks.length} track items`);

    const first = tracks[0];
    if (first && typeof first === 'object') {
      console.log('TRACK[0] keys:', Object.keys(first).slice(0, 50));
      try {
        console.log('TRACK[0] preview:', JSON.stringify(first).slice(0, 1500));
      } catch (e) {
        console.log('TRACK[0] preview: <unstringifiable>', e.message);
      }

      if (first.Vehicle && typeof first.Vehicle === 'object') {
        console.log(
          'TRACK[0].Vehicle keys:',
          Object.keys(first.Vehicle).slice(0, 50)
        );
      }
    }

    await refreshVehicleDirectory(false);

    const ops = tracks.map((t, idx) => {
      if (!t || typeof t !== 'object') return null;

      const autocabId =
        (typeof t.VehicleAutoID === 'number' && t.VehicleAutoID) ||
        (typeof t.VehicleId === 'number' && t.VehicleId) ||
        (typeof t.VehicleID === 'number' && t.VehicleID) ||
        (typeof t.AutocabId === 'number' && t.AutocabId) ||
        (typeof t.Id === 'number' && t.Id) ||
        (t.Vehicle && typeof t.Vehicle.Id === 'number' && t.Vehicle.Id) ||
        null;

      const pos = t.Position || t.Location || t.CurrentLocation || {};
      const lat = parseFloat(
        pos.Latitude ??
          pos.latitude ??
          pos.Lat ??
          pos.lat ??
          pos.Y ??
          t.Latitude ??
          t.latitude ??
          t.lat
      );
      const lon = parseFloat(
        pos.Longitude ??
          pos.longitude ??
          pos.Lng ??
          pos.lng ??
          pos.Lon ??
          pos.lon ??
          pos.X ??
          t.Longitude ??
          t.longitude ??
          t.lon ??
          t.lng
      );

      let rawCallsign = String(
        t.Callsign ||
          t.callSign ||
          t.callsign ||
          (t.Vehicle && (t.Vehicle.Callsign || t.Vehicle.callsign || t.Vehicle.callSign)) ||
          (t.Driver && (t.Driver.Callsign || t.Driver.callsign || t.Driver.callSign)) ||
          ''
      ).trim();

      if (!rawCallsign && autocabId) {
        rawCallsign = resolveKnownCallsignByAutocabId(autocabId) || '';
      }

      const callsign = normaliseCallsign(
        rawCallsign || (autocabId ? String(autocabId) : '')
      );

      const ts =
        t.Received ||
        t.Timestamp ||
        t.timestamp ||
        (body && (body.Received || body.Timestamp || body.timestamp)) ||
        new Date().toISOString();

      const status = extractStatusLikePrevious(t, body);

      if (idx < 3) {
        console.log('Resolved track', {
          path: req.path,
          idx,
          autocabId,
          rawCallsign,
          callsign,
          lat: Number.isNaN(lat) ? null : lat,
          lon: Number.isNaN(lon) ? null : lon,
          status,
          ts,
          statusFields: {
            t_VehicleStatus: t.VehicleStatus,
            t_Status: t.Status,
            t_State: t.State,
            body_VehicleStatus: body && body.VehicleStatus,
            body_Status: body && body.Status,
            body_State: body && body.State,
          },
        });
      }

      if (isUnknownStatus(status)) {
        const tKeys = Object.keys(t).slice(0, 40);
        console.log('⚠️ Status unresolved at source (Unknown)', {
          callsign,
          rawCallsign,
          autocabId,
          trackKeys: tKeys,
        });
      }

      if (!callsign || Number.isNaN(lat) || Number.isNaN(lon)) return null;

      if (autocabId && callsign) {
        vehicleDirectoryById.set(autocabId, callsign);
        const existing = vehicleDirectory.get(callsign) || {};
        vehicleDirectory.set(callsign, {
          ...existing,
          id: autocabId,
          callsign,
          status: !isUnknownStatus(status) ? status : existing.status || null,
          raw: existing.raw || t,
        });
      }

      const meta = {
        autocabId,
        Id: autocabId,
        registration:
          (t.Vehicle && (t.Vehicle.Registration || t.Vehicle.registration)) ||
          t.Registration ||
          null,
        plateNumber:
          (t.Vehicle && (t.Vehicle.PlateNumber || t.Vehicle.plateNumber)) ||
          t.PlateNumber ||
          null,
        rawCallsign: rawCallsign || callsign,
        callsign,
      };

      return processVehiclePing(callsign, lat, lon, ts, status, meta);
    });

    const results = await Promise.all(ops.filter(Boolean));
    return res.json({
      ok: true,
      processed: results.length,
      received: tracks.length,
    });
  } catch (err) {
    console.error('Error in HackneyLocation handler:', err);
    return res.status(500).json({ error: 'HackneyLocation failed' });
  }
}

app.post(/(HackneyLocation|VehiclePosition|VehicleTracksChanged)/i, handleHackneyLocation);

app.post(/(BookingComplete|BookingCreated|Dispatched)/i, (_req, res) =>
  res.json({ ok: true })
);

app.post(/shift/i, async (req, res) => {
  try {
    const norm = normaliseWebhookBody(req.body);
    const body = norm.body;

    if (typeof body === 'string') {
      return res.json({ ok: true, ignored: true });
    }

    const items = Array.isArray(body) ? body : [body];

    await refreshVehicleDirectory(false);

    let updated = 0;

    for (const it of items) {
      if (!it || typeof it !== 'object') continue;

      const autocabId =
        (typeof it.VehicleAutoID === 'number' && it.VehicleAutoID) ||
        (typeof it.VehicleId === 'number' && it.VehicleId) ||
        (typeof it.VehicleID === 'number' && it.VehicleID) ||
        (typeof it.AutocabId === 'number' && it.AutocabId) ||
        (typeof it.Id === 'number' && it.Id) ||
        (it.Vehicle && typeof it.Vehicle.Id === 'number' && it.Vehicle.Id) ||
        null;

      const status = normaliseStatus(
        it.VehicleStatus ||
          it.vehicleStatus ||
          it.Status ||
          it.status ||
          it.ShiftStatus ||
          it.shiftStatus ||
          it.State ||
          it.state ||
          (it.Vehicle && (it.Vehicle.VehicleStatus || it.Vehicle.Status)) ||
          null
      );

      if (!status) continue;

      let rawCallsign = String(
        it.Callsign ||
          it.callSign ||
          it.callsign ||
          (it.Vehicle && (it.Vehicle.Callsign || it.Vehicle.callsign || it.Vehicle.callSign)) ||
          ''
      ).trim();

      if (!rawCallsign && autocabId) {
        rawCallsign = resolveKnownCallsignByAutocabId(autocabId) || '';
      }

      const callsign = normaliseCallsign(
        rawCallsign || (autocabId ? String(autocabId) : '')
      );
      if (!callsign) continue;

      lastStatusByCallsign.set(callsign, status);
      if (autocabId) {
        vehicleDirectoryById.set(autocabId, callsign);
        const existing = vehicleDirectory.get(callsign) || {};
        vehicleDirectory.set(callsign, {
          ...existing,
          id: autocabId,
          callsign,
          status: status || existing.status || null,
          raw: existing.raw || it,
        });
      }

      updated++;

      const vr = vehicles.get(callsign);
      if (vr) {
        vr.status = status;
        vr.seenAt = Date.now();
        vr.autocabId = vr.autocabId || autocabId || null;
        vr.Id = vr.Id || autocabId || null;
        vr.callsign = callsign;
        vr.rawCallsign = normaliseCallsign(vr.rawCallsign || rawCallsign || callsign);
        vehicles.set(callsign, vr);
      }

      console.log('🟦 /shift status update', {
        rawCallsign,
        callsign,
        autocabId,
        status,
      });
    }

    return res.json({ ok: true, updated });
  } catch (err) {
    console.error('Error in /shift handler:', err);
    return res.status(500).json({ error: 'shift handler failed' });
  }
});

app.get('/api/events', (req, res) => {
  let latest = events.slice(-200).reverse();

  const { prefix, callsigns } = req.query;

  if (prefix) {
    const p = normaliseCallsign(prefix);
    latest = latest.filter(
      (ev) => ev.callsign && String(ev.callsign).startsWith(p)
    );
  }

  if (callsigns) {
    const set = new Set(
      String(callsigns)
        .split(',')
        .map((s) => normaliseCallsign(s))
        .filter(Boolean)
    );
    if (set.size) {
      latest = latest.filter((ev) => ev.callsign && set.has(String(ev.callsign)));
    }
  }

  res.json(latest);
});

app.get('/api/vehicles', (req, res) => {
  const { prefix, ids } = req.query;
  let list = Array.from(vehicles.values());

  if (prefix) {
    const p = normaliseCallsign(prefix);
    list = list.filter((v) => v.vehicleId && String(v.vehicleId).startsWith(p));
  }

  if (ids) {
    const set = new Set(
      String(ids)
        .split(',')
        .map((s) => normaliseCallsign(s))
        .filter(Boolean)
    );
    if (set.size) {
      list = list.filter((v) => v.vehicleId && set.has(String(v.vehicleId)));
    }
  }

  list = list.map((v) => {
    const resolvedCallsign =
      normaliseCallsign(
        v.callsign ||
          resolveKnownCallsignByAutocabId(v.autocabId) ||
          v.rawCallsign ||
          v.vehicleId
      ) || normaliseCallsign(v.vehicleId);

    const online = isVehicleOnline(v.ts, v.seenAt);
    const status =
      !isUnknownStatus(v.status)
        ? v.status
        : lastStatusByCallsign.get(resolvedCallsign) ||
          (vehicleDirectory.get(resolvedCallsign) || {}).status ||
          v.status;

    const meta = getWorkingStatusMeta(status, { online });

    return {
      ...v,
      vehicleId: resolvedCallsign,
      callsign: resolvedCallsign,
      rawCallsign: normaliseCallsign(
        v.rawCallsign ||
          resolvedCallsign ||
          resolveKnownCallsignByAutocabId(v.autocabId) ||
          v.vehicleId
      ),
      status,
      online,
      statusLabel: meta.label,
      statusClass: meta.className,
      working: meta.working,
    };
  });

  res.json(list);
});

app.post('/api/set-busy', async (req, res) => {
  try {
    const { callsign, status, reason, zone, eventTime, rawEvent, mode, decisionKey } =
      req.body || {};
    if (!callsign) return res.status(400).json({ error: 'callsign is required' });

    const cs = normaliseCallsign(callsign);
    const key = decisionKey || ['AUTOBUSY-EXIT', cs, zone || '', eventTime || ''].join('|');

    // Server-side idempotency lock. This is the real safety guard.
    // It prevents repeated Auto POB sends from browser refreshes, duplicate tabs,
    // replayed events, or multiple clients viewing the dashboard.
    if (key) {
      const existing = await AutoBusyLog.findOne({ decisionKey: key }).lean();
      if (existing && ['pending', 'activated', 'dry-run', 'ignored'].includes(String(existing.result || '').toLowerCase())) {
        return res.json({
          ok: true,
          duplicate: true,
          forwarded: false,
          result: existing.result,
          message: `Duplicate Auto POB blocked by server · existing result ${existing.result}`,
          decisionKey: key,
        });
      }
    }

    const payload = {
      callsign: cs,
      status: status || 'Busy',
      reason: reason || 'geofence-exit',
      zone: zone || null,
      eventTime: eventTime || new Date().toISOString(),
      rawEvent: rawEvent || null,
    };

    const baseUrlRaw =
      process.env.AUTOCAB_VEHICLES_URL || `${AUTOCAB_BASE_URL}/vehicle/v1/vehicles`;
    const baseUrl = baseUrlRaw.replace(/\/+$/, '');
    const subKey = process.env.AUTOCAB_SUBSCRIPTION_KEY || '';

    const requestedMode = (mode || '').toLowerCase();
    // Hard safety rule:
    // The browser/app must explicitly request live AND Render must allow live.
    // AUTOBUSY_LIVE_ENABLED=true is only a permission, not an instruction to run live.
    const live = requestedMode === 'live' && LIVE_ENABLED === true;

    const vehicleRecord = vehicles.get(cs);
    let autocabId =
      (rawEvent &&
        (rawEvent.autocabId ??
          rawEvent.AutocabId ??
          rawEvent.Id ??
          (rawEvent.Vehicle && rawEvent.Vehicle.Id))) ||
      (vehicleRecord && (vehicleRecord.autocabId ?? vehicleRecord.Id)) ||
      null;

    if (!autocabId) {
      await refreshVehicleDirectory(false);
      const entry = vehicleDirectory.get(cs);
      if (entry && typeof entry.id === 'number') autocabId = entry.id;
    }

    console.log('🔁 /api/set-busy received', {
      ...payload,
      requestedMode,
      live,
      decisionKey: key,
      resolvedAutocabId: autocabId,
    });

    const logBase = {
      decisionKey: key,
      ts: new Date(),
      callsign: cs,
      zone: zone || 'Zone',
      mode: requestedMode || '',
      statusBefore: rawEvent && (rawEvent.status || rawEvent.VehicleStatus || rawEvent.vehicleStatus || rawEvent.state) || '',
      lat: rawEvent && Number.isFinite(Number(rawEvent.lat)) ? Number(rawEvent.lat) : null,
      lon: rawEvent && Number.isFinite(Number(rawEvent.lon)) ? Number(rawEvent.lon) : null,
      eventTime: eventTime || '',
      source: 'server',
    };

    const recentAutoBusy = await findRecentAutoBusyForCallsignZone(cs, zone || 'Zone', key);
    if (recentAutoBusy) {
      await AutoBusyLog.findOneAndUpdate(
        { decisionKey: key },
        {
          $set: {
            ...logBase,
            result: 'ignored',
            message: `Duplicate Auto POB blocked · ${cs} already had ${recentAutoBusy.result} in ${zone || 'Zone'} within ${Math.round(AUTOBUSY_DEDUPE_WINDOW_MS / 60000)} minutes`,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return res.json({
        ok: true,
        duplicate: true,
        forwarded: false,
        result: 'ignored',
        message: `Duplicate Auto POB blocked by cooldown · existing result ${recentAutoBusy.result}`,
        decisionKey: key,
      });
    }

    const lock = await acquireAutoBusyDecisionLock({ decisionKey: key, logBase });
    if (!lock.acquired) {
      return res.json({
        ok: true,
        duplicate: true,
        forwarded: false,
        result: lock.doc && lock.doc.result || 'pending',
        message: lock.reason || 'Duplicate Auto POB blocked by server',
        decisionKey: key,
      });
    }

    if (!live || !baseUrl || !subKey || !autocabId) {
      const blockedByServerLock = requestedMode === 'live' && LIVE_ENABLED !== true;
      const result = blockedByServerLock ? 'error' : 'dry-run';
      const message = blockedByServerLock
        ? 'Live requested but blocked by server safety lock'
        : 'Dry run: server did not send Auto POB';

      if (key) {
        await AutoBusyLog.findOneAndUpdate(
          { decisionKey: key },
          { $set: { ...logBase, result, message } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }

      console.log('ℹ️ AutoBusy NOT LIVE (no live call will be made)', {
        requestedMode,
        live,
        blockedByServerLock,
        hasBaseUrl: !!baseUrl,
        hasSubKey: !!subKey,
        autocabId,
      });
      return res.json({
        ok: true,
        mode: blockedByServerLock ? 'live-blocked' : 'dry-run',
        live: false,
        forwarded: false,
        result,
        message,
        decisionKey: key,
        payload,
        meta: { LIVE_ENABLED, requestedMode, blockedByServerLock, hasBaseUrl: !!baseUrl, hasSubKey: !!subKey, autocabId },
      });
    }

    const targetUrl = `${baseUrl}/${autocabId}/mobile`;
    console.log(`➡️ AutoBusy LIVE → ${targetUrl} (callsign ${cs})`);

    const resp = await fetchFn(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': subKey,
      },
      body: JSON.stringify({ vehicleId: autocabId }),
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.error('❌ Busy API error', resp.status, text);
      if (key) {
        await AutoBusyLog.findOneAndUpdate(
          { decisionKey: key },
          { $set: { ...logBase, result: 'error', message: `Auto POB failed · Busy API HTTP ${resp.status}` } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }
      return res.status(502).json({
        error: 'Busy API failed',
        status: resp.status,
        body: text,
        mode: 'live',
        live: true,
        decisionKey: key,
      });
    }

    if (key) {
      await AutoBusyLog.findOneAndUpdate(
        { decisionKey: key },
        { $set: { ...logBase, result: 'activated', message: 'Auto POB activated · vehicle message pending' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    console.log('✅ Busy API success:', text.slice(0, 500));
    return res.json({
      ok: true,
      forwarded: true,
      status: resp.status,
      body: text,
      mode: 'live',
      live: true,
      result: 'activated',
      message: 'Auto POB activated',
      decisionKey: key,
    });
  } catch (err) {
    console.error('💥 Error in /api/set-busy:', err.message, err.stack);
    return res.status(500).json({ error: 'set-busy failed', message: err.message });
  }
});

app.post('/api/send-message', async (req, res) => {
  try {
    const { callsign, text, triggerType, zone, autocabId: overrideId, rawEvent, decisionKey } =
      req.body || {};
    if (!callsign || !text)
      return res.status(400).json({ error: 'callsign and text are required' });

    const csNorm = normaliseCallsign(callsign);
    const requestedMode = String((req.body && req.body.mode) || '').toLowerCase();
    const live = requestedMode === 'live' && LIVE_ENABLED === true;
    const key = decisionKey || '';

    // If this is an AutoBusy message and the same decision has already been finalised
    // with a sent/disabled/failed message note, do not send another message.
    if (key && triggerType === 'AUTOBUSY') {
      const existing = await AutoBusyLog.findOne({ decisionKey: key }).lean();
      const msg = String(existing && existing.message || '').toLowerCase();
      if (msg.includes('vehicle message sent') || msg.includes('message disabled') || msg.includes('message failed')) {
        return res.json({
          ok: true,
          duplicate: true,
          live: false,
          sent: false,
          message: 'Duplicate AutoBusy message blocked by server',
          decisionKey: key,
        });
      }
    }

    if (!live) {
      const blockedByServerLock = requestedMode === 'live' && LIVE_ENABLED !== true;
      console.log('ℹ️ Message NOT SENT (dry-run/server lock)', { callsign, triggerType, zone, requestedMode, LIVE_ENABLED, blockedByServerLock });
      return res.json({
        ok: true,
        mode: blockedByServerLock ? 'live-blocked' : 'dry-run',
        live: false,
        sent: false,
        meta: { LIVE_ENABLED, requestedMode, blockedByServerLock }
      });
    }

    await refreshVehicleDirectory(false);
    const directoryEntry = vehicleDirectory.get(csNorm);
    const vehicleRecord = vehicles.get(csNorm);

    let autocabId =
      (overrideId && typeof overrideId === 'number' && overrideId) ||
      (directoryEntry && typeof directoryEntry.id === 'number' && directoryEntry.id) ||
      (rawEvent &&
        (rawEvent.autocabId ??
          rawEvent.AutocabId ??
          rawEvent.Id ??
          (rawEvent.Vehicle && rawEvent.Vehicle.Id))) ||
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
      resolvedAutocabId: autocabId,
      decisionKey: key,
    });

    if (!autocabId) {
      if (key && triggerType === 'AUTOBUSY') {
        await AutoBusyLog.findOneAndUpdate(
          { decisionKey: key },
          { $set: { message: 'Auto POB activated · message failed: no Autocab vehicleId found' } },
          { new: true }
        );
      }
      return res
        .status(400)
        .json({ error: `No Autocab vehicleId found for callsign ${callsign}` });
    }

    const msgUrlRaw =
      process.env.AUTOCAB_MESSAGE_URL || `${AUTOCAB_BASE_URL}/vehicle/v1/vehicles/message`;
    const msgUrl = msgUrlRaw.replace(/\/+$/, '');

    const subKey = process.env.AUTOCAB_SUBSCRIPTION_KEY || '';
    if (!subKey)
      return res.status(500).json({ error: 'Autocab subscription key not configured' });

    const payload = { text, vehicles: [autocabId], companies: [], capabilities: [], zones: [] };

    console.log('➡️ /api/send-message LIVE →', { callsign: csNorm, autocabId, triggerType, zone, msgUrl });

    const resp = await fetchFn(msgUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Ocp-Apim-Subscription-Key': subKey,
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await resp.text();
    if (!resp.ok) {
      console.error('❌ Message API error', resp.status, bodyText);
      if (key && triggerType === 'AUTOBUSY') {
        await AutoBusyLog.findOneAndUpdate(
          { decisionKey: key },
          { $set: { message: `Auto POB activated · message failed HTTP ${resp.status}` } },
          { new: true }
        );
      }
      return res.status(502).json({
        ok: false,
        status: resp.status,
        body: bodyText,
        callsign: csNorm,
        autocabId,
      });
    }

    if (key && triggerType === 'AUTOBUSY') {
      await AutoBusyLog.findOneAndUpdate(
        { decisionKey: key },
        { $set: { result: 'activated', message: 'Auto POB activated · vehicle message sent' } },
        { new: true }
      );
    }

    console.log('✅ Message sent OK →', { callsign: csNorm, autocabId, triggerType, zone });
    return res.json({ ok: true, callsign: csNorm, autocabId, status: resp.status, body: bodyText, decisionKey: key });
  } catch (err) {
    console.error('💥 Error in /api/send-message:', err.message, err.stack);
    return res.status(500).json({ error: 'send-message failed', message: err.message });
  }
});

app.post('/api/debug/mockVehicle', async (_req, res) => {
  try {
    const vehicleId = 'TX-DEMO-1';
    const lat = 50.3755;
    const lon = -4.1427;
    const ts = new Date().toISOString();

    const result = await processVehiclePing(vehicleId, lat, lon, ts, 'Clear', {
      rawCallsign: vehicleId,
    });
    console.log('🐟 Mock vehicle injected', {
      vehicleId: normaliseCallsign(vehicleId),
      lat,
      lon,
      inside: result?.inside || [],
    });
    res.json({ ok: true, inside: result?.inside || [] });
  } catch (err) {
    console.error('Mock vehicle failed', err);
    res.status(500).json({ error: 'mock failed' });
  }
});

app.get('/api/debug/last-webhook', (_req, res) => {
  res.json(lastWebhook);
});

app.listen(PORT, () => {
  console.log(`🚀 Geofence server running at http://localhost:${PORT}`);
  console.log('LIVE_ENABLED:', LIVE_ENABLED);
});
