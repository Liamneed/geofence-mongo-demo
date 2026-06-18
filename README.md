# Geofence Mongo Demo

Simple example of:
- OpenStreetMap + Leaflet + Leaflet.draw to create geofence polygons
- Node + Express backend
- MongoDB (via Mongoose) to persist geofences
- Turf.js to detect ENTER / EXIT events when vehicles send GPS points

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure MongoDB in `.env`:

```bash
cp .env.example .env
# edit if needed (defaults assume local Mongo on 27017)
```

3. Run:

```bash
npm start
```

Visit: `http://localhost:3000`

## Usage

- Draw polygons/rectangles on the map.
- Each shape is saved to MongoDB as a GeoJSON Polygon.
- Send tracking pings:

```bash
curl -X POST http://localhost:3000/api/track \
  -H "Content-Type: application/json" \
  -d '{"vehicleId":"TX001","lat":50.3755,"lon":-4.1427}'
```

Check terminal logs for:

- `[ENTER] Vehicle ... ENTERED geofence ...`
- `[EXIT] Vehicle ... EXITED geofence ...`

Hook your own actions (webhooks/SMS/etc) in `server.js` where indicated.

## Auto POB reliability fix

This version runs Auto POB from the Node server when a live AutoCab location webhook creates a station-zone EXIT event. It no longer depends on the browser window being open. The dashboard can still display events and logs, but the live decision is made server-side.

Required live settings in `.env`:

```bash
AUTOBUSY_LIVE_ENABLED=true
AUTOCAB_SUBSCRIPTION_KEY=your_autocab_key
AUTOCAB_BASE_URL=https://autocab-api.azure-api.net
AUTOCAB_VEHICLES_URL=https://autocab-api.azure-api.net/vehicle/v1/vehicles
AUTOCAB_MESSAGE_URL=https://autocab-api.azure-api.net/vehicle/v1/vehicles/message
```

In the dashboard, AutoBusy mode must also be set to `Live`. `AUTOBUSY_LIVE_ENABLED=true` only permits live sending; it does not force live mode by itself.

The server now logs Auto POB decisions with `source: server-auto`, so you can confirm whether the backend is making decisions while the page is closed.
