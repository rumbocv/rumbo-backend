// ============================================================
// Rumbo Backend — Entry Point
// Express server with CORS, JSON body parser, route mounts
// ============================================================
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import analyzeRouter  from './routes/analyze.js';
import paymentRouter  from './routes/payment.js';

const app  = express();
const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// JSON body parser (for payment routes, etc.)
// Note: multer handles multipart/form-data on its own routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------
// Routes
// ---------------------------------------------------------------
app.use('/api/analyze',  analyzeRouter);
app.use('/api/payment',  paymentRouter);

// Health check — useful for uptime monitors and local dev checks
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// ---------------------------------------------------------------
// Start (local) / Export (Vercel)
// ---------------------------------------------------------------
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`[rumbo] Server listening on http://localhost:${PORT}`);
  });
}

export default app;
