require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const app = express();
app.use(express.json());

// --CONFIG--
const token = process.env.TOKEN;
const url = process.env.INFLUX_URL;
const org = process.env.INFLUX_ORG;
const bucket = process.env.INFLUX_BUCKET;

const influxDB = new InfluxDB({ url, token });
const writeApi = influxDB.getWriteApi(org, bucket);
const queryApi = influxDB.getQueryApi(org);

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error("API_KEY environment variable is not set");
}

// API key middleware
function apiKeyAuth(req, res, next) {
  const key = req.header('x-api-key');

  if (!key) {
    return res.status(401).json({ error: 'API key missing' });
  }

  if (key !== API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}

// mTLS middleware
function mtlsAuth(req, res, next) {
  if (!req.client.authorized) {
    return res.status(401).json({
      error: 'Client certificate required or invalid'
    });
  }

  next();
}

// Routes
app.post('/ingest', mtlsAuth, apiKeyAuth, async (req, res) => {
  try {
    const { measurement, value, tag } = req.body;

    if (!measurement || value === undefined) {
      return res.status(400).json({ error: 'measurement and value required' });
    }

    const point = new Point(measurement)
      .floatField('value', value)
      .tag('source', tag || 'default');

    writeApi.writePoint(point);
    await writeApi.flush();

    res.json({ status: 'written' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'write failed' });
  }
});

app.get('/output', apiKeyAuth, async (req, res) => {
  const query = `
    from(bucket: "${bucket}")
      |> range(start: 0)
  `;

  try {
    const rows = await queryApi.collectRows(query);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/output/24h', apiKeyAuth, async (req, res) => {
  const query = `
    from(bucket: "${bucket}")
      |> range(start: -24h)
  `;

  try {
    const rows = await queryApi.collectRows(query);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// HTTPS + mTLS config
const httpsOptions = {
  key: fs.readFileSync('./certs/server.key'),
  cert: fs.readFileSync('./certs/server.crt'),
  ca: fs.readFileSync('./certs/ca.crt'),

  requestCert: true,
  rejectUnauthorized: true
};

// Run HTTPS server
const PORT = process.env.PORT || 3000;

https.createServer(httpsOptions, app).listen(PORT, () => {
  console.log(`API running on HTTPS port ${PORT}`);
});
