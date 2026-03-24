const { Router } = require('express');
const { createClient } = require('@supabase/supabase-js');
const { trackEvent }    = require('../services/events.js');
const { sendPurchaseConfirmation, syncUnpaidLeads } = require('../services/brevo.js');
const { sendTelegram }  = require('../services/telegram.js');
const { sendMetaEvent } = require('../services/meta.js');
const { optimizeCV }    = require('../services/claude.js');
const { generateCvDocx } = require('../services/cvDocx.js');

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Auth middleware — verifies Supabase JWT and checks admin email
async function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token || null);

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

// /api/admin/config removed — credentials are injected server-side into admin.html and login.html

// GET /api/admin/stats — event counts + conversion rates + timeseries
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from + 'T00:00:00').toISOString() : new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const to   = req.query.to   ? new Date(req.query.to   + 'T23:59:59').toISOString() : new Date().toISOString();

    const diffMs   = new Date(to) - new Date(from);
    const granularity = diffMs / 86400000 <= 1.5 ? 'hour' : 'day';

    // Previous period (same duration, immediately before)
    const prevTo   = new Date(new Date(from).getTime() - 1000).toISOString();
    const prevFrom = new Date(new Date(from).getTime() - diffMs).toISOString();

    const [{ data, error }, { data: prevData }, { count: cvCount }, { count: prevCvCount }] = await Promise.all([
      supabase.from('events').select('type, created_at')
        .in('type', ['visit', 'checkout', 'purchase', 'add_to_cart'])
        .gte('created_at', from).lte('created_at', to)
        .order('created_at', { ascending: true }),
      supabase.from('events').select('type, created_at')
        .in('type', ['visit', 'checkout', 'purchase', 'add_to_cart'])
        .gte('created_at', prevFrom).lte('created_at', prevTo),
      // Count CVs from sessions table so deletes are reflected immediately
      supabase.from('sessions').select('*', { count: 'exact', head: true })
        .gte('created_at', from).lte('created_at', to),
      supabase.from('sessions').select('*', { count: 'exact', head: true })
        .gte('created_at', prevFrom).lte('created_at', prevTo),
    ]);

    if (error) throw error;

    const counts     = { visit: 0, checkout: 0, purchase: 0, add_to_cart: 0 };
    const prevCounts = { visit: 0, checkout: 0, purchase: 0, add_to_cart: 0 };

    const buckets = {};
    (data || []).forEach(row => {
      if (counts[row.type] !== undefined) counts[row.type]++;
      const dt  = new Date(row.created_at);
      const key = granularity === 'hour'
        ? `${row.created_at.slice(0, 10)}T${String(dt.getUTCHours()).padStart(2, '0')}`
        : row.created_at.slice(0, 10);
      if (!buckets[key]) buckets[key] = { date: key, visits: 0, checkouts: 0, purchases: 0, add_to_cart: 0 };
      if (row.type === 'visit')       buckets[key].visits++;
      if (row.type === 'checkout')    buckets[key].checkouts++;
      if (row.type === 'purchase')    buckets[key].purchases++;
      if (row.type === 'add_to_cart') buckets[key].add_to_cart++;
    });

    (prevData || []).forEach(row => {
      if (prevCounts[row.type] !== undefined) prevCounts[row.type]++;
    });

    // Fill all time slots
    const timeseries = [];
    if (granularity === 'hour') {
      const start = new Date(from); start.setUTCMinutes(0,0,0);
      const end   = new Date(to);
      for (let d = new Date(start); d <= end; d.setUTCHours(d.getUTCHours() + 1)) {
        const key = `${d.toISOString().slice(0,10)}T${String(d.getUTCHours()).padStart(2,'0')}`;
        timeseries.push(buckets[key] || { date: key, visits: 0, checkouts: 0, purchases: 0, add_to_cart: 0 });
      }
    } else {
      const days = Math.ceil(diffMs / 86400000) + 1;
      const fromDate = new Date(from);
      for (let i = 0; i < days; i++) {
        const d   = new Date(fromDate.getTime() + i * 86400000);
        const key = d.toISOString().slice(0, 10);
        timeseries.push(buckets[key] || { date: key, visits: 0, checkouts: 0, purchases: 0, add_to_cart: 0 });
      }
    }

    const cr_checkout = counts.visit > 0 ? ((counts.checkout / counts.visit) * 100).toFixed(1) : '0.0';
    const cr_purchase = counts.visit > 0 ? ((counts.purchase / counts.visit) * 100).toFixed(1) : '0.0';
    const prev_cr_checkout = prevCounts.visit > 0 ? ((prevCounts.checkout / prevCounts.visit) * 100).toFixed(1) : '0.0';
    const prev_cr_purchase = prevCounts.visit > 0 ? ((prevCounts.purchase / prevCounts.visit) * 100).toFixed(1) : '0.0';

    // Replace add_to_cart with real session count so deletes are reflected
    counts.add_to_cart     = cvCount     ?? counts.add_to_cart;
    prevCounts.add_to_cart = prevCvCount ?? prevCounts.add_to_cart;

    return res.json({
      ok: true,
      stats:      counts,
      prev_stats: prevCounts,
      timeseries,
      granularity,
      conversions:      { cr_checkout, cr_purchase },
      prev_conversions: { cr_checkout: prev_cr_checkout, cr_purchase: prev_cr_purchase },
    });
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
router.get('/cvs', requireAdmin, async (req, res) => {
  try {
    let query = supabase
      .from('sessions')
      .select('id, created_at, paid, tier, data, filename, contact_name, contact_email, situacion, lead_email, checkout, checkout_tier')
      .order('created_at', { ascending: false });

    if (req.query.from) query = query.gte('created_at', new Date(req.query.from + 'T00:00:00').toISOString());
    if (req.query.to)   query = query.lte('created_at', new Date(req.query.to   + 'T23:59:59').toISOString());

    const { data, error } = await query;

    if (error) throw error;

    // Check which sessions have optimizations
    const sessionIds = (data || []).map(r => r.id).filter(Boolean);
    let optimizedSet = new Set();
    if (sessionIds.length) {
      const { data: opts } = await supabase
        .from('cv_optimizations')
        .select('session_id')
        .in('session_id', sessionIds);
      optimizedSet = new Set((opts || []).map(r => r.session_id));
    }

    const cvs = (data || []).map(row => ({
      id:               row.id ? row.id.slice(0, 8) : null,
      full_id:          row.id || null,
      created_at:       row.created_at,
      paid:             row.paid,
      tier:             row.tier,
      real_score:       row.data?.score         ?? null,
      display_score:    row.data?.display_score ?? null,
      nivel:            row.data?.nivel ?? null,
      filename:         row.filename || null,
      contact_name:     row.contact_name  || null,
      contact_email:    row.contact_email || null,
      lead_email:       row.lead_email    || null,
      situacion:        row.situacion     || null,
      puesto:           row.data?._puesto || null,
      checkout:         row.checkout      || false,
      checkout_tier:    row.checkout_tier || null,
      has_optimization: optimizedSet.has(row.id),
    }));

    return res.json({ ok: true, cvs });
  } catch (err) {
    console.error('[admin/cvs]', err.message);
    return res.status(500).json({ ok: false, error: 'Error al obtener CVs.' });
  }
});

// GET /api/admin/unpaid-leads — devuelve emails de usuarios NO pagados
router.get('/unpaid-leads', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('contact_email, lead_email, contact_name')
      .eq('paid', false)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const emails = (data || [])
      .filter(row => row.contact_email || row.lead_email)
      .map(row => ({
        email: row.contact_email || row.lead_email,
        name: row.contact_name || null
      }));

    return res.json({ ok: true, count: emails.length, leads: emails });
  } catch (err) {
    console.error('[admin/unpaid-leads]', err.message);
    return res.status(500).json({ ok: false, error: 'Error al obtener leads.' });
  }
});

// POST /api/admin/sync-brevo — sincroniza leads no pagados a lista de Brevo
router.post('/sync-brevo', requireAdmin, async (req, res) => {
  try {
    const result = await syncUnpaidLeads(supabase);
    return res.json({ ok: true, synced: result.synced });
  } catch (err) {
    console.error('[admin/sync-brevo]', err.message);
    return res.status(500).json({ ok: false, error: 'Error al sincronizar.' });
  }
});

// PUT /api/admin/cvs/:sessionId/mark-paid — manually mark a session as paid
router.put('/cvs/:sessionId/mark-paid', requireAdmin, async (req, res) => {
  try {
    const { data: session } = await supabase
      .from('sessions')
      .select('id, tier, checkout_tier, contact_name, contact_email, lead_email, order_number')
      .eq('id', req.params.sessionId)
      .single();

    if (!session) {
      return res.status(404).json({ ok: false, error: 'Sesión no encontrada.' });
    }

    const tier = session.tier || session.checkout_tier || null;

    const { error } = await supabase
      .from('sessions')
      .update({ paid: true, ...(tier ? { tier } : {}) })
      .eq('id', req.params.sessionId);

    if (error) throw error;

    // Registrar como compra para estadísticas y atribución
    trackEvent('purchase', { tier, manual: true }).catch(err =>
      console.error('[admin/mark-paid/event]', err.message)
    );

    // Notificación Telegram
    const TIER_PRICES = { informe: 29990, cv: 19990 };
    const amount = TIER_PRICES[tier] ?? 0;
    const tierLabel = tier === 'cv' ? 'CV Listo para Enviar' : 'Informe Completo';
    const orderNum = session.order_number ? `#${session.order_number}` : '—';
    sendTelegram(`💰 Compra manual\n<b>Orden:</b> ${orderNum}\n<b>Plan:</b> ${tierLabel}\n<b>Importe:</b> $${amount.toLocaleString('es-AR')}`).catch(() => {});

    // Enviar mail de confirmación + Meta Purchase CAPI
    const toEmail = session.contact_email || session.lead_email;
    if (toEmail) {
      sendPurchaseConfirmation({
        email:       toEmail,
        name:        session.contact_name || null,
        tier,
        orderNumber: session.order_number || null,
      }).catch(err => console.error('[admin/mark-paid/email]', err.message));
    }

    sendMetaEvent('Purchase', {
      email:      toEmail || null,
      externalId: req.params.sessionId,
      firstName:  session.contact_name ? session.contact_name.trim().split(' ')[0] : null,
      lastName:   session.contact_name ? session.contact_name.trim().split(' ').slice(1).join(' ') || null : null,
      ip:         session.data?._ip  || null,
      userAgent:  session.data?._ua  || null,
      fbp:        session.data?._fbp || null,
      fbc:        session.data?._fbc || null,
      url:        process.env.FRONTEND_URL,
      eventId:    `purchase_manual_${req.params.sessionId}_${Date.now()}`,
      customData: {
        value:        amount,
        currency:     'ARS',
        content_name: tier === 'cv' ? 'cv_listo_para_enviar' : 'informe_completo',
        content_type: 'product',
      },
    }).catch(err => console.error('[admin/mark-paid/meta]', err.message));

    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin/mark-paid]', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno.' });
  }
});

// GET /api/admin/cvs/:sessionId/download — signed URL for CV file
router.get('/cvs/:sessionId/download', requireAdmin, async (req, res) => {
  try {
    const { data: row, error } = await supabase
      .from('sessions')
      .select('storage_path')
      .eq('id', req.params.sessionId)
      .single();

    if (error || !row?.storage_path) {
      return res.status(404).json({ ok: false, error: 'Archivo no encontrado.' });
    }

    const { data, error: signError } = await supabase.storage
      .from('cvs')
      .createSignedUrl(row.storage_path, 60); // 60 segundos de validez

    if (signError || !data?.signedUrl) {
      return res.status(500).json({ ok: false, error: 'No se pudo generar el link de descarga.' });
    }

    return res.json({ ok: true, url: data.signedUrl });
  } catch (err) {
    console.error('[admin/download]', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno.' });
  }
});

// PUT /api/admin/cvs/:sessionId — actualizar email del CV
router.put('/cvs/:sessionId', requireAdmin, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const { email } = req.body;

    const { error } = await supabase
      .from('sessions')
      .update({ contact_email: email })
      .eq('id', sessionId);

    if (error) throw error;

    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin/cv/update]', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno.' });
  }
});

// DELETE /api/admin/cvs/:sessionId — eliminar registro de CV
router.delete('/cvs/:sessionId', requireAdmin, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;

    // Obtener storage_path antes de eliminar
    const { data: row } = await supabase
      .from('sessions')
      .select('storage_path')
      .eq('id', sessionId)
      .single();

    // Eliminar de la tabla sessions
    const { error } = await supabase
      .from('sessions')
      .delete()
      .eq('id', sessionId);

    if (error) throw error;

    // Eliminar archivo de storage si existe (fire-and-forget)
    if (row?.storage_path) {
      supabase.storage.from('cvs').remove([row.storage_path])
        .catch(err => console.error('[admin/delete/storage]', err.message));
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin/delete]', err.message);
    return res.status(500).json({ ok: false, error: 'Error al eliminar el registro.' });
  }
});

// GET /api/admin/utm — UTM attribution: visits / checkouts / purchases per source
router.get('/utm', requireAdmin, async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from + 'T00:00:00').toISOString() : new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const to   = req.query.to   ? new Date(req.query.to   + 'T23:59:59').toISOString() : new Date().toISOString();

    const { data, error } = await supabase
      .from('events')
      .select('type, metadata, created_at')
      .in('type', ['visit', 'checkout', 'purchase'])
      .gte('created_at', from)
      .lte('created_at', to);

    if (error) throw error;

    const groups = {};
    (data || []).forEach(row => {
      const utm = row.metadata?.utm || {};
      if (!utm.source) return;
      const key = `${utm.source}||${utm.medium || '(none)'}||${utm.campaign || '(none)'}`;
      if (!groups[key]) {
        groups[key] = {
          source:   utm.source,
          medium:   utm.medium   || '(none)',
          campaign: utm.campaign || '(none)',
          visit: 0, checkout: 0, purchase: 0,
        };
      }
      if (groups[key][row.type] !== undefined) groups[key][row.type]++;
    });

    const rows = Object.values(groups).sort((a, b) => b.visit - a.visit);
    return res.json({ ok: true, utm: rows });
  } catch (err) {
    console.error('[admin/utm]', err.message);
    return res.status(500).json({ ok: false, error: 'Error al obtener datos UTM.' });
  }
});

// GET /api/admin/geo — visitas geolocalizadas en los últimos 5 minutos (tiempo real)
router.get('/geo', requireAdmin, async (_req, res) => {
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('events')
      .select('metadata, created_at')
      .eq('type', 'visit')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    console.log('[admin/geo] total visits:', (data||[]).length, 'with geo:', (data||[]).filter(r=>r.metadata?.geo).length);
    const points = (data || [])
      .filter(r => r.metadata?.geo?.lat != null && r.metadata?.geo?.lng != null)
      .map(r => ({
        lat:       r.metadata.geo.lat,
        lng:       r.metadata.geo.lng,
        city:      r.metadata.geo.city   || null,
        region:    r.metadata.geo.region || null,
        created_at: r.created_at,
      }));

    return res.json({ ok: true, points });
  } catch (err) {
    console.error('[admin/geo]', err.message);
    return res.status(500).json({ ok: false, points: [] });
  }
});

// POST /api/admin/cvs/:sessionId/optimize — run Claude optimization and save
router.post('/cvs/:sessionId/optimize', requireAdmin, async (req, res) => {
  const { jd, market } = req.body || {};
  if (!jd?.trim()) return res.status(400).json({ ok: false, error: 'Se requiere la descripción del puesto (JD).' });

  try {
    const { data: session, error: sErr } = await supabase
      .from('sessions')
      .select('id, storage_path, filename')
      .eq('id', req.params.sessionId)
      .single();

    if (sErr || !session) return res.status(404).json({ ok: false, error: 'Sesión no encontrada.' });
    if (!session.storage_path) return res.status(400).json({ ok: false, error: 'No hay CV almacenado para esta sesión.' });

    const { data: fileData, error: fileErr } = await supabase.storage
      .from('cvs')
      .download(session.storage_path);
    if (fileErr || !fileData) return res.status(500).json({ ok: false, error: 'No se pudo descargar el CV.' });

    const cvBuffer  = Buffer.from(await fileData.arrayBuffer());
    const filename  = session.filename || session.storage_path;
    const mimetype  = filename.toLowerCase().endsWith('.pdf')
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    const result = await optimizeCV(cvBuffer, mimetype, filename, jd, market || null);

    await supabase.from('cv_optimizations').upsert(
      { session_id: req.params.sessionId, jd_text: jd, cv_optimized: result.cv_optimized, informe: result.informe },
      { onConflict: 'session_id' }
    );

    return res.json({ ok: true, cv_optimized: result.cv_optimized, informe: result.informe, usage: result.usage });
  } catch (err) {
    console.error('[admin/optimize]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/cvs/:sessionId/optimization — fetch saved optimization
router.get('/cvs/:sessionId/optimization', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cv_optimizations')
      .select('cv_optimized, informe, created_at')
      .eq('session_id', req.params.sessionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return res.json({ ok: false, exists: false });
    return res.json({ ok: true, exists: true, cv_optimized: data.cv_optimized, informe: data.informe, created_at: data.created_at });
  } catch (err) {
    return res.json({ ok: false, exists: false });
  }
});

// GET /api/admin/cvs/:sessionId/optimization/download-docx — download CV optimizado as DOCX
router.get('/cvs/:sessionId/optimization/download-docx', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cv_optimizations')
      .select('cv_optimized')
      .eq('session_id', req.params.sessionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return res.status(404).json({ ok: false, error: 'No hay optimización guardada.' });

    const buffer = await generateCvDocx(data.cv_optimized);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="cv_optimizado.docx"');
    res.send(buffer);
  } catch (err) {
    console.error('[admin/optimization/download-docx]', err.message);
    res.status(500).json({ ok: false, error: 'Error al generar el DOCX.' });
  }
});

// GET /api/admin/locations — visitas agrupadas por ciudad para el rango seleccionado
router.get('/locations', requireAdmin, async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from + 'T00:00:00').toISOString() : new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const to   = req.query.to   ? new Date(req.query.to   + 'T23:59:59').toISOString() : new Date().toISOString();

    const { data, error } = await supabase
      .from('events')
      .select('metadata')
      .eq('type', 'visit')
      .gte('created_at', from)
      .lte('created_at', to);

    if (error) throw error;

    const counts = {};
    (data || []).forEach(row => {
      const geo = row.metadata?.geo;
      if (!geo?.city) return;
      const key = `${geo.city}||${geo.region || ''}`;
      if (!counts[key]) counts[key] = { city: geo.city, region: geo.region || null, count: 0 };
      counts[key].count++;
    });

    const locations = Object.values(counts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    return res.json({ ok: true, locations });
  } catch (err) {
    console.error('[admin/locations]', err.message);
    return res.status(500).json({ ok: false, locations: [] });
  }
});

module.exports = router;
