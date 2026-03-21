const { Router } = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Auth middleware — verifies Supabase JWT and checks admin email
async function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ ok: false, error: 'Token inválido.' });
    }
    if (user.email !== 'ramiro.suarezf@gmail.com') {
      return res.status(401).json({ ok: false, error: 'Acceso denegado.' });
    }
    req.adminUser = user;
    next();
  } catch (err) {
    console.error('[admin/auth]', err.message);
    return res.status(401).json({ ok: false, error: 'Error de autenticación.' });
  }
}

// GET /api/admin/config — public, returns Supabase credentials for frontend
router.get('/config', (_req, res) => {
  res.json({
    supabaseUrl:     process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// GET /api/admin/stats — event counts + conversion rates + timeseries
router.get('/stats', requireAdmin, async (_req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    const { data, error } = await supabase
      .from('events')
      .select('type, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) throw error;

    const counts = { visit: 0, checkout: 0, purchase: 0 };
    const daily  = {};

    (data || []).forEach(row => {
      if (counts[row.type] !== undefined) counts[row.type]++;
      if (row.type === 'visit') {
        const day = row.created_at.slice(0, 10);
        daily[day] = (daily[day] || 0) + 1;
      }
    });

    // Fill last 30 days (including zeros)
    const timeseries = [];
    for (let i = 29; i >= 0; i--) {
      const d   = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      timeseries.push({ date: key, visits: daily[key] || 0 });
    }

    // Conversion rates
    const cr_checkout = counts.visit > 0 ? ((counts.checkout / counts.visit) * 100).toFixed(1) : '0.0';
    const cr_purchase = counts.visit > 0 ? ((counts.purchase / counts.visit) * 100).toFixed(1) : '0.0';

    return res.json({ ok: true, stats: counts, timeseries, conversions: { cr_checkout, cr_purchase } });
  } catch (err) {
    console.error('[admin/stats]', err.message);
    return res.status(500).json({ ok: false, error: 'Error al obtener estadísticas.' });
  }
});

// GET /api/admin/active — visitors in the last 5 minutes
router.get('/active', requireAdmin, async (_req, res) => {
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count, error } = await supabase
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('type', 'visit')
      .gte('created_at', since);

    if (error) throw error;
    return res.json({ ok: true, active: count || 0 });
  } catch (err) {
    console.error('[admin/active]', err.message);
    return res.status(500).json({ ok: false, active: 0 });
  }
});

// GET /api/admin/cvs — list sessions with summary fields
router.get('/cvs', requireAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('id, created_at, paid, tier, data, filename')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const cvs = (data || []).map(row => ({
      id:         row.id ? row.id.slice(0, 8) : null,
      created_at: row.created_at,
      paid:       row.paid,
      tier:       row.tier,
      score:      row.data?.score ?? null,
      nivel:      row.data?.nivel ?? null,
      filename:   row.filename || null,
    }));

    return res.json({ ok: true, cvs });
  } catch (err) {
    console.error('[admin/cvs]', err.message);
    return res.status(500).json({ ok: false, error: 'Error al obtener CVs.' });
  }
});

module.exports = router;
