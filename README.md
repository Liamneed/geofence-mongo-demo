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
