// Guest photo sharing for Kiley & Ian's wedding.
// Express + Postgres. Photos are resized in the browser and stored in the database.
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const archiver = require('archiver');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL;
// Stop taking uploads before the database fills up (free plan is 1 GB).
const MAX_DB_BYTES = Number(process.env.MAX_DB_MB || 900) * 1024 * 1024;
const MAX_FULL = 4 * 1024 * 1024;
const MAX_THUMB = 300 * 1024;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /render\.com/.test(DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 8,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS photos (
      id BIGSERIAL PRIMARY KEY,
      guest_name TEXT NOT NULL DEFAULT '',
      width INT NOT NULL,
      height INT NOT NULL,
      full_jpeg BYTEA NOT NULL,
      thumb_jpeg BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));

// Simple per-IP upload limit so one phone can't flood the gallery.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 150;
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

function isHost(req) {
  const key = req.get('x-host-key') || req.query.key || '';
  if (!HOST_KEY || key.length !== HOST_KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(HOST_KEY));
}

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/photos', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 60, 120);
    const before = Number(req.query.before) || null;
    const { rows } = await pool.query(
      `SELECT id, guest_name AS name, width AS w, height AS h, created_at
         FROM photos WHERE ($1::bigint IS NULL OR id < $1)
        ORDER BY id DESC LIMIT $2`,
      [before, limit]
    );
    const total = (await pool.query('SELECT count(*)::int AS n FROM photos')).rows[0].n;
    res.set('Cache-Control', 'no-store').json({ photos: rows, total });
  } catch (e) { next(e); }
});

app.post('/api/photos', async (req, res, next) => {
  try {
    if (limited(req.ip)) return res.status(429).json({ error: 'That is a lot of photos at once. Give it a few minutes and try again.' });
    const { name = '', full, thumb, w, h } = req.body || {};
    if (typeof full !== 'string' || typeof thumb !== 'string') return res.status(400).json({ error: 'Missing photo.' });
    const fullBuf = Buffer.from(full, 'base64');
    const thumbBuf = Buffer.from(thumb, 'base64');
    if (!isJpeg(fullBuf) || !isJpeg(thumbBuf)) return res.status(400).json({ error: 'That file is not a photo we can read.' });
    if (fullBuf.length > MAX_FULL || thumbBuf.length > MAX_THUMB) return res.status(413).json({ error: 'That photo is too large.' });
    const width = Math.round(Number(w)), height = Math.round(Number(h));
    if (!(width > 0 && width < 10000 && height > 0 && height < 10000)) return res.status(400).json({ error: 'Bad photo size.' });
    const size = (await pool.query('SELECT pg_database_size(current_database())::bigint AS s')).rows[0].s;
    if (Number(size) > MAX_DB_BYTES) return res.status(507).json({ error: 'The album is full. Thank you for sharing!' });
    const clean = String(name).replace(/\s+/g, ' ').trim().slice(0, 40);
    const { rows } = await pool.query(
      `INSERT INTO photos (guest_name, width, height, full_jpeg, thumb_jpeg)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, guest_name AS name, width AS w, height AS h, created_at`,
      [clean, width, height, fullBuf, thumbBuf]
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

async function sendImage(col, req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.sendStatus(404);
    const { rows } = await pool.query(`SELECT ${col} AS img FROM photos WHERE id = $1`, [id]);
    if (!rows.length) return res.sendStatus(404);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
    if (req.query.dl) res.set('Content-Disposition', `attachment; filename="kiley-ian-wedding-${id}.jpg"`);
    res.send(rows[0].img);
  } catch (e) { next(e); }
}
app.get('/p/:id.jpg', (req, res, next) => sendImage('full_jpeg', req, res, next));
app.get('/t/:id.jpg', (req, res, next) => sendImage('thumb_jpeg', req, res, next));

// Host only: check the key, remove a photo, download everything.
app.get('/api/host', (req, res) => res.json({ host: isHost(req) }));

app.delete('/api/photos/:id', async (req, res, next) => {
  try {
    if (!isHost(req)) return res.sendStatus(403);
    await pool.query('DELETE FROM photos WHERE id = $1', [Number(req.params.id) || 0]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/download.zip', async (req, res, next) => {
  try {
    if (!isHost(req)) return res.sendStatus(403);
    const ids = (await pool.query('SELECT id FROM photos ORDER BY id')).rows.map((r) => r.id);
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="kiley-ian-wedding-photos.zip"' });
    const zip = archiver('zip', { store: true });
    zip.on('error', next);
    zip.pipe(res);
    for (const id of ids) {
      const { rows } = await pool.query('SELECT guest_name, full_jpeg FROM photos WHERE id = $1', [id]);
      if (!rows.length) continue;
      const who = rows[0].guest_name.replace(/[^\w\- ]+/g, '').trim().replace(/ +/g, '-');
      zip.append(rows[0].full_jpeg, { name: `${String(id).padStart(4, '0')}${who ? '-' + who : ''}.jpg` });
    }
    zip.finalize();
  } catch (e) { next(e); }
});

// QR code that points at wherever this site is running.
const siteUrl = (req) => process.env.SITE_URL || `${req.protocol}://${req.get('host')}/`;
app.get('/qr.svg', async (req, res, next) => {
  try {
    const svg = await QRCode.toString(siteUrl(req), { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#16302f', light: '#0000' } });
    res.type('image/svg+xml').send(svg);
  } catch (e) { next(e); }
});
app.get('/qr.png', async (req, res, next) => {
  try {
    const png = await QRCode.toBuffer(siteUrl(req), { errorCorrectionLevel: 'M', margin: 2, width: 1600 });
    res.set('Content-Disposition', 'attachment; filename="wedding-photos-qr.png"').type('png').send(png);
  } catch (e) { next(e); }
});
app.get('/sign', (req, res) => res.sendFile(path.join(__dirname, 'public', 'sign.html')));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return res.end();
  const tooBig = err.type === 'entity.too.large';
  res.status(tooBig ? 413 : 500).json({ error: tooBig ? 'That photo is too large.' : 'Something went wrong on our end. Try again.' });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`Wedding photos listening on ${PORT}`)))
  .catch((e) => { console.error('Startup failed', e); process.exit(1); });
