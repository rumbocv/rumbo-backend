require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const analyzeRouter  = require('./routes/analyze.js');
const paymentRouter  = require('./routes/payment.js');
const adminRouter    = require('./routes/admin.js');
const { trackEvent }    = require('./services/events.js');
const { sendMetaEvent } = require('./services/meta.js');
const { saveContact }   = require('./services/sessions.js');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/analyze', analyzeRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/admin',   adminRouter);

app.post('/api/track/visit', async (req, res) => {
  try {
    await Promise.all([
      trackEvent('visit'),
      sendMetaEvent('PageView', {
        ip:        req.ip,
        userAgent: req.headers['user-agent'],
        fbp:       req.cookies?.['_fbp'],
        fbc:       req.cookies?.['_fbc'],
        url:       req.headers['referer'] || process.env.FRONTEND_URL,
        eventId:   `pageview_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      }),
    ]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[track/visit]', err.message);
    return res.status(500).json({ ok: false, error: 'Error al registrar visita.' });
  }
});

app.post('/api/contact', async (req, res) => {
  const { sessionId, name, email } = req.body || {};
  if (!sessionId || !name || !email) {
    return res.status(400).json({ ok: false, error: 'sessionId, name y email son requeridos.' });
  }
  const orderNumber = await saveContact(sessionId, name.trim(), email.trim().toLowerCase());
  return res.json({ ok: orderNumber !== null, orderNumber });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/api/debug-meta', async (req, res) => {
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

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`[rumbo] http://localhost:${PORT}`));
}

module.exports = app;
