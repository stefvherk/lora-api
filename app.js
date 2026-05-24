require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const ingestApp = express();
const outputApp = express();

ingestApp.use(express.json());
outputApp.use(express.json());

// --CONFIG--
const token = process.env.INFLUX_TOKEN;
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
ingestApp.post('/ingest', mtlsAuth, apiKeyAuth, async (req, res) => {
  try {
    const { measurement, value, tag, humidity, movement } = req.body;

    if (!measurement || value === undefined || !tag) {
      return res.status(400).json({ error: 'measurement, value, and tag are required' });
    }

    const point = new Point(measurement)
      .floatField('value', parseFloat(value))
      .tag('tag', tag);

    if (humidity !== undefined) {
      const humidityValue = parseFloat(humidity);
      if (Number.isNaN(humidityValue) || humidityValue < 0 || humidityValue > 100) {
        return res.status(400).json({ error: 'humidity must be a percentage between 0 and 100' });
      }
      point.floatField('humidity', humidityValue);
    }

    if (movement !== undefined) {
      const movementValue = typeof movement === 'boolean'
        ? movement
        : movement === 'true' || movement === 'false'
          ? movement === 'true'
          : undefined;

      if (movementValue === undefined) {
        return res.status(400).json({ error: 'movement must be boolean' });
      }

      point.booleanField('movement', movementValue);
    }

    writeApi.writePoint(point);
    await writeApi.flush();

    res.json({ status: 'written' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'write failed' });
  }
});

ingestApp.post('/ingest/mock', mtlsAuth, apiKeyAuth, async (req, res) => {
  try {
    const { measurement, value, tag, timestamp, humidity, movement } = req.body;

    if (!measurement || value === undefined || !tag || !timestamp) {
      return res.status(400).json({ error: 'measurement, value, tag and timestamp are required for mock data' });
    }

    const date = new Date(timestamp);

    const point = new Point(measurement)
      .floatField('value', parseFloat(value))
      .tag('tag', tag)
      .timestamp(date);

    if (humidity !== undefined) {
      const humidityValue = parseFloat(humidity);
      if (Number.isNaN(humidityValue) || humidityValue < 0 || humidityValue > 100) {
        return res.status(400).json({ error: 'humidity must be a percentage between 0 and 100' });
      }
      point.floatField('humidity', humidityValue);
    }

    if (movement !== undefined) {
      const movementValue = typeof movement === 'boolean'
        ? movement
        : movement === 'true' || movement === 'false'
          ? movement === 'true'
          : undefined;

      if (movementValue === undefined) {
        return res.status(400).json({ error: 'movement must be boolean' });
      }

      point.booleanField('movement', movementValue);
    }
      
    writeApi.writePoint(point);
    await writeApi.flush();

    res.json({ status: 'mock written' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'mock write failed' });
  }
});

outputApp.get('/output', apiKeyAuth, async (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to query parameters are required' });
  }

  const query = `
    from(bucket: "${bucket}")
      |> range(start: ${from}, stop: ${to})
  `;

  try {
    const rows = await queryApi.collectRows(query);
    const pointsByKey = {};

    rows.forEach(r => {
      if (r._value === undefined) {
        return;
      }

      const key = `${r._measurement}-${r.tag}-${r._time}`;
      if (!pointsByKey[key]) {
        pointsByKey[key] = {
          measurement: r._measurement,
          tag: r.tag,
          time: r._time
        };
      }

      const cleanedValue = typeof r._value === 'string' ? parseFloat(r._value) : r._value;

      if (r._field === 'value') {
        pointsByKey[key].value = cleanedValue;
      } else if (r._field === 'humidity') {
        pointsByKey[key].humidity = cleanedValue;
      } else if (r._field === 'movement') {
        pointsByKey[key].movement = cleanedValue;
      }
    });

    const cleaned = Object.values(pointsByKey);
    res.json(cleaned);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'query failed' });
  }
});

outputApp.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const mtlsOptions = {
  key: fs.readFileSync('./certs/server.key'),
  cert: fs.readFileSync('./certs/server.crt'),
  ca: fs.readFileSync('./certs/ca.crt'),
  requestCert: true,
  rejectUnauthorized: true
};

const httpsOptions = {
  key: fs.readFileSync('./certs/server.key'),
  cert: fs.readFileSync('./certs/server.crt')
};

const MTLS_PORT = process.env.MTLS_PORT;
const OUTPUT_PORT = process.env.OUTPUT_PORT;

https.createServer(mtlsOptions, ingestApp).listen(MTLS_PORT, () => {
  console.log(`mTLS ingest API running on HTTPS port ${MTLS_PORT}`);
});

https.createServer(httpsOptions, outputApp).listen(OUTPUT_PORT, () => {
  console.log(`HTTPS output API running on HTTPS port ${OUTPUT_PORT}`);
});
