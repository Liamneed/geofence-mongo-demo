# v2.0.1 update

- Handles `/HackneyLocation` batch-array payloads from Autocab/Hackney feed.
- Reads coordinates from `Position.Latitude` / `Position.Longitude` and nested `Location.Latitude.TotalDegrees` / `Location.Longitude.TotalDegrees`.
- Reads `VehicleAutoID` and maps it to callsign using the Autocab vehicle directory when `AUTOCAB_SUBSCRIPTION_KEY` is configured.
- Optional fallback: `VEHICLE_AUTOID_AS_CALLSIGN=true` can be used only if your webhook VehicleAutoID is genuinely the callsign. Leave false if VehicleAutoID is an internal Autocab ID.

# Geofence Mongo Demo — Webhook/Stale-Exit Auto POB Fix

This is a full replacement build for the Need-A-Cab Auto POB geofence server.

## What changed

The key fix is architectural:

```text
/HackneyLocation webhook
        ↓
Server stores vehicle route history
        ↓
Server detects Station EXIT
        ↓
Server rejects stale exits and large GPS jumps
        ↓
Server checks crossed/near AutoBusy exit line
        ↓
Server sends Auto POB message if mode is live
```

The browser/dashboard is now only for viewing logs, editing zones/lines, and changing settings. The dashboard being open or closed should not control Auto POB.

## Main fixes included

- `/HackneyLocation` is the live trigger.
- Stores recent vehicle history in MongoDB and memory.
- Uses the last route points, not just one old point and one far-away point.
- Rejects stale Station exits.
- Rejects large GPS jumps.
- Accepts crossed exit line OR near-line route within tolerance.
- Keeps 900–999 callsign guard.
- Keeps Clear-only safety guard.
- Keeps duplicate/cooldown guard.
- Dashboard shows useful reasons and debug details.

## Files

```text
server.js
models/Geofence.js
models/Settings.js
models/AutoBusyLog.js
models/VehicleHistoryPoint.js
public/index.html
.env.example
package.json
```

## Recommended Render environment variables

Use these on Render:

```env
PORT=10000
MONGO_URI=your_mongodb_connection_string
MONGO_DB=geofence_demo

AUTOBUSY_LIVE_ENABLED=false
AUTOBUSY_MODE=off

AUTOCAB_BASE_URL=https://autocab-api.azure-api.net
AUTOCAB_SUBSCRIPTION_KEY=your_autocab_key
AUTOCAB_MESSAGE_URL=https://autocab-api.azure-api.net/vehicle/v1/vehicles/message
AUTOCAB_VEHICLES_URL=https://autocab-api.azure-api.net/vehicle/v1/vehicles

AUTOBUSY_LOCATION_HISTORY_POINTS=20
AUTOBUSY_ROUTE_HISTORY_SECONDS=180
AUTOBUSY_MAX_EXIT_GAP_SECONDS=120
AUTOBUSY_MAX_EXIT_DISTANCE_METERS=350
AUTOBUSY_LINE_TOLERANCE_METERS=50
AUTOBUSY_CONFIRM_BUFFER_METERS=35
AUTOBUSY_DEDUPE_WINDOW_MINUTES=5
AUTOBUSY_PENDING_LOCK_STALE_SECONDS=90
AUTOBUSY_PENDING_MAX_SECONDS=180
AUTOBUSY_CALLSIGN_MIN=900
AUTOBUSY_CALLSIGN_MAX=999

VEHICLE_DIRECTORY_REFRESH_MINUTES=15
VEHICLE_ONLINE_WINDOW_MS=90000

# Optional. Leave blank if you do not want an API key while testing.
TRACKER_API_KEY=
```

Start safely with:

```env
AUTOBUSY_LIVE_ENABLED=false
AUTOBUSY_MODE=off
```

Then use the dashboard to switch to `dry-run` first. Only set live when logs look correct.

## Step-by-step local setup

### 1. Extract the ZIP

Extract this project folder.

### 2. Open terminal in the folder

```bash
cd geofence-mongo-demo-webhook-stale-exit-fix
```

### 3. Install dependencies

```bash
npm install
```

### 4. Create `.env`

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
copy .env.example .env
```

Edit `.env` and add your MongoDB connection string and Autocab key.

### 5. Run syntax check

```bash
npm run check
```

### 6. Start the server

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Step-by-step GitHub deploy

### 1. Backup your current repo first

In your current project folder:

```bash
git status
git add .
git commit -m "Backup before webhook stale exit fix"
git push
```

### 2. Replace project files

Copy the files from this ZIP into your existing `geofence-mongo-demo` folder.

Replace:

```text
server.js
package.json
.env.example
models/
public/
README.md
```

Do not copy `.env` to GitHub.

### 3. Commit the update

```bash
git add .
git commit -m "Fix Auto POB webhook route history and stale exits"
git push
```

## Step-by-step Render deploy

### 1. Open Render

Go to your existing service:

```text
geofence-mongo-demo
```

### 2. Set build/start commands

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

### 3. Add/update environment variables

Add the recommended variables listed above.

Important safe starting values:

```env
AUTOBUSY_LIVE_ENABLED=false
AUTOBUSY_MODE=off
```

### 4. Deploy

Click:

```text
Manual Deploy → Deploy latest commit
```

### 5. Check health

Open:

```text
https://your-render-url/health
```

Expected:

```json
{ "ok": true }
```

Then open:

```text
https://your-render-url/api/status
```

Check:

```text
mongoReadyState: 1
liveAllowed: false initially
lastWebhook
settings
```

## Step-by-step test

### 1. Make sure AutoBusy is safe

In the dashboard:

```text
Mode: dry-run
Line tolerance: 50
Confirm buffer: 35
Callsign range: 900 to 999
```

### 2. Confirm webhook is reaching the server

Send a test point:

```bash
curl -X POST https://your-render-url/HackneyLocation \
  -H "Content-Type: application/json" \
  -d '{"callsign":"920","lat":50.37701,"lon":-4.14454,"status":"Clear","eventTime":"2026-06-22T08:00:00+01:00"}'
```

If you set `TRACKER_API_KEY`, include:

```bash
-H "x-tracker-key: your_key"
```

### 3. Check status

Open:

```text
https://your-render-url/api/status
```

`lastWebhook` should now show the test.

### 4. Draw your Station zone and exit line

In the dashboard:

1. Draw the Station polygon.
2. Name it:

```text
Station
```

3. Draw the exit line.
4. Name it:

```text
Station AutoBusy Exit Line
```

### 5. Test dry-run first

Send a route with points inside, near exit, then outside. Check Recent AutoBusy Activity.

You want to see:

```text
PENDING → DRY-RUN
```

or useful ignores such as:

```text
Ignored: stale Station exit — last inside point too old
Ignored: stale/large jump exit — no fresh route through Station
Ignored: vehicle was BusyMeterOnFromMeterOffAccount on EXIT
```

## Going live

Only go live after dry-run looks right.

On Render set:

```env
AUTOBUSY_LIVE_ENABLED=true
```

Then in dashboard set:

```text
Mode: live
```

Both are required. This prevents accidental live sends from only changing one setting.

## Important notes

- The browser/dashboard no longer needs to be open for tracking.
- The system depends on `/HackneyLocation` receiving vehicle locations.
- If a vehicle appears far away after an old Station point, it will be ignored as stale/large jump instead of being treated as a valid Station exit.
- If vehicle status is not `Clear`, Auto POB is ignored.
- If a vehicle already had Auto POB recently, duplicate cooldown blocks repeat sends.


### HackneyLocation array payload fix

This version handles HackneyLocation payloads sent as an array of vehicles. It also accepts `VehicleAutoID` as the vehicle key when no separate callsign field is present, and uses `Received` as the event timestamp. This should make `/api/status` show `vehiclesInMemory` above 0 after the webhook is received.

If your webhook does not include vehicle status, keep `AUTOBUSY_ASSUME_CLEAR_WHEN_STATUS_MISSING=false` for safe dry-run testing. Only set it to `true` if you are happy for location-only vehicles to be treated as Clear.


## v2.0.2

- Dashboard now loads `/api/vehicles` and plots current vehicle markers on the Leaflet map.
- Yellow markers are 900-999 AutoBusy callsigns; blue markers are other vehicles.
- Stale vehicles display faded.
