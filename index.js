require('dotenv').config();

// Timestamps en hora Buenos Aires
['log', 'warn', 'error'].forEach(method => {
  const orig = console[method].bind(console);
  console[method] = (...args) => {
    const ts = new Date().toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    orig(`[${ts}]`, ...args);
  };
});

const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const cookieParser = require('cookie-parser');

const analyzeRouter  = require('./routes/analyze.js');
const paymentRouter  = require('./routes/payment.js');
const adminRouter    = require('./routes/admin.js');
const pdfRouter      = require('./routes/pdf.js');
const { trackEvent }    = require('./services/events.js');
const { sendMetaEvent } = require('./services/meta.js');
const { saveContact }   = require('./services/sessions.js');
const { checkOrigin, isWhitelisted, resolveIp } = require('./middleware/security.js');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(cookieParser());

// Security: only accept requests from the legitimate frontend
// Note: /api/payment/webhook is excluded — MercadoPago servers don't send Origin headers
app.use('/api/analyze',         checkOrigin);
app.use('/api/payment/create',  checkOrigin);
app.use('/api/track',           checkOrigin);
app.use('/api/contact',         checkOrigin);

app.use('/api/analyze', analyzeRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/admin',   adminRouter);
app.use('/api/pdf',     pdfRouter);

async function geolocateIP(ip) {
  try {
    const clean = (ip || '').replace('::ffff:', '').trim();
    if (!clean || clean === '::1' || clean === '127.0.0.1' ||
        clean.startsWith('192.168.') || clean.startsWith('10.') || clean.startsWith('172.')) return null;
    const r = await fetch(`http://ip-api.com/json/${clean}?fields=status,lat,lon,city,regionName&lang=es`);
    const d = await r.json();
    if (d.status === 'success') return { lat: d.lat, lng: d.lon, city: d.city, region: d.regionName };
  } catch (_) {}
  return null;
}

app.post('/api/track/visit', async (req, res) => {
  const utm     = req.body?.utm || {};
  const fbp     = req.body?.fbp || req.cookies?.['_fbp'] || null;
  const fbc     = req.body?.fbc || req.cookies?.['_fbc'] || null;
  const eventId = req.body?.eventId || null;
  const realIp  = resolveIp(req);

  // Skip all tracking for whitelisted IPs
  if (isWhitelisted(realIp)) return res.json({ ok: true });

  console.log('[track/visit] ip:', realIp);
  const geo = await Promise.race([
    geolocateIP(realIp),
    new Promise(r => setTimeout(() => r(null), 1500)),
  ]);
  console.log('[track/visit] geo:', geo ? `${geo.city}, ${geo.region}` : 'null');
  try {
    await Promise.all([
      trackEvent('visit', { utm, ...(geo ? { geo } : {}) }),
      sendMetaEvent('PageView', {
        ip:        realIp,
        userAgent: req.headers['user-agent'],
        fbp,
        fbc,
        url:       req.headers['referer'] || process.env.FRONTEND_URL,
        eventId:   eventId || `pageview_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      }),
    ]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[track/visit]', err.message);
    return res.status(500).json({ ok: false, error: 'Error al registrar visita.' });
  }
});

app.post('/api/contact', async (req, res) => {
  const { sessionId, name, apellido, email } = req.body || {};
  if (!sessionId || !name || !apellido || !email) {
    return res.status(400).json({ ok: false, error: 'sessionId, name, apellido y email son requeridos.' });
  }
  const fullName    = `${name.trim()} ${apellido.trim()}`;
  const orderNumber = await saveContact(sessionId, fullName, email.trim().toLowerCase());
  return res.json({ ok: orderNumber !== null, orderNumber });
});

// Serve admin pages with Supabase config injected server-side (avoids public /api/admin/config endpoint)
function injectConfig(filePath, res) {
  try {
    const html = fs.readFileSync(filePath, 'utf8');
    const tag  = `<script>window.__SB_URL__='${process.env.SUPABASE_URL}';window.__SB_ANON__='${process.env.SUPABASE_ANON_KEY}';</script>`;
    const injected = html.replace('</head>', `${tag}\n</head>`);
    res.setHeader('Content-Type', 'text/html');
    res.send(injected);
  } catch (e) {
    res.status(500).send('Error al cargar página.');
  }
}

app.get('/admin', (_req, res) => injectConfig(path.join(__dirname, 'public/admin.html'), res));
app.get('/login', (_req, res) => injectConfig(path.join(__dirname, 'public/login.html'), res));
app.get('/demo', requireDebugKey, (_req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
    const tag  = `<script>window.__DEMO_KEY__='${process.env.DEBUG_SECRET}';</script>`;
    res.setHeader('Content-Type', 'text/html');
    res.send(html.replace('</head>', `${tag}\n</head>`));
  } catch (e) {
    res.status(500).send('Error al cargar página.');
  }
});

app.get('/demo/:slug', (req, res) => {
  const demoSlug = process.env.DEMO_SLUG;
  if (!demoSlug || req.params.slug !== demoSlug) {
    return res.status(404).send('Not found');
  }
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
    const tag  = `<script>window.__DEMO_KEY__='${process.env.DEBUG_SECRET}';</script>`;
    res.setHeader('Content-Type', 'text/html');
    res.send(html.replace('</head>', `${tag}\n</head>`));
  } catch (e) {
    res.status(500).send('Error al cargar página.');
  }
});


app.get('/health', requireDebugKey, (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

function requireDebugKey(req, res, next) {
  const key = process.env.DEBUG_SECRET;
  if (!key || req.query.key !== key) return res.status(403).json({ ok: false, error: 'Forbidden' });
  next();
}

app.get('/api/debug-telegram', requireDebugKey, async (req, res) => {
  const { sendTelegram } = require('./services/telegram.js');
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const result = await sendTelegram('✅ Test de conexión Rumbo → Telegram OK');
  return res.json({ token_set: !!token, chat_id_set: !!chatId, result });
});

app.get('/api/debug-meta', requireDebugKey, async (req, res) => {
  const pixelId     = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  const result = await sendMetaEvent('PageView', {
    ip:        req.ip,
    userAgent: req.headers['user-agent'],
    url:       process.env.FRONTEND_URL,
    eventId:   `debug_${Date.now()}`,
  });
  return res.json({
    pixel_id_set:     !!pixelId,
    access_token_set: !!accessToken,
    meta_response:    result,
  });
});

// Cron: sincronizar leads no pagados a Brevo (ejecuta cada hora)
const { syncUnpaidLeads } = require('./services/brevo.js');
const { createClient } = require('@supabase/supabase-js');

const cronSupabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.get('/api/cron/sync-brevo', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { synced } = await syncUnpaidLeads(cronSupabase);
  return res.json({ ok: true, synced, timestamp: new Date().toISOString() });
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`[rumbo] http://localhost:${PORT}`));
}

module.exports = app;
