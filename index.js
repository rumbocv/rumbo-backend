require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const analyzeRouter  = require('./routes/analyze.js');
const paymentRouter  = require('./routes/payment.js');

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

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`[rumbo] http://localhost:${PORT}`));
}

module.exports = app;
