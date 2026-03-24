const { Router } = require('express');
const multer     = require('multer');
const { v4: uuid } = require('uuid');
const { analyzeCV, checkIsCV }                                   = require('../services/claude.js');
const { save, get, getForCheckout }                               = require('../services/sessions.js');
const { sendMetaEvent }                                          = require('../services/meta.js');
const { trackEvent }                                             = require('../services/events.js');
const { analyzeRateLimit, validateMagicBytes, sanitizePuesto, isWhitelisted } = require('../middleware/security.js');
const { upsertLead }                                             = require('../services/brevo.js');

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','guerrillamail.net','guerrillamail.org',
  'guerrillamail.biz','guerrillamail.de','guerrillamail.info','spam4.me',
  'tempmail.com','temp-mail.org','throwam.com','sharklasers.com',
  'guerrillamailblock.com','grr.la','guerrillamail.com','yopmail.com',
  'yopmail.fr','cool.fr.nf','jetable.fr.nf','nospam.ze.tc','nomail.xl.cx',
  'mega.zik.dj','speed.1s.fr','courriel.fr.nf','moncourrier.fr.nf',
  'monemail.fr.nf','monmail.fr.nf','trashmail.com','trashmail.me',
  'trashmail.net','trashmail.at','trashmail.io','trashmail.org',
  'dispostable.com','mailnull.com','maildrop.cc','spamgourmet.com',
  'spamgourmet.net','spamgourmet.org','10minutemail.com','10minutemail.net',
  'fakeinbox.com','fakeinbox.net','mailexpire.com','spamfree24.org',
  'meltmail.com','discardmail.com','discardmail.de','throwam.com',
  'spamthisplease.com','tempr.email','discard.email','mailnesia.com',
]);

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  // RFC 5321 practical limit
  if (trimmed.length > 254) return false;
  // Practical email regex
  const re = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
  if (!re.test(trimmed)) return false;
  const domain = trimmed.split('@')[1];
  if (DISPOSABLE_DOMAINS.has(domain)) return false;
  return true;
}

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype) || /\.(pdf|doc|docx)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se aceptan archivos PDF, DOC o DOCX.'));
    }
  },
});

const DEMO_ANALYSIS = {
  score: 43, display_score: 43, nivel: 'Bajo',
  resumen: 'Tu CV tiene problemas de formato y le faltan palabras clave para superar los filtros automáticos de las empresas.',
  categorias: [
    { nombre: 'Formato',           puntaje: 38, peso: 25, comentario: 'El formato dificulta la lectura automática.' },
    { nombre: 'Palabras clave',    puntaje: 41, peso: 30, comentario: 'Faltan términos clave del sector.' },
    { nombre: 'Experiencia',       puntaje: 52, peso: 25, comentario: 'Los logros no están cuantificados.' },
    { nombre: 'Datos de contacto', puntaje: 60, peso: 10, comentario: 'Falta LinkedIn actualizado.' },
    { nombre: 'Estructura',        puntaje: 44, peso: 10, comentario: 'El orden de secciones no es óptimo.' },
  ],
  errores: [
    { descripcion: 'Palabras clave faltantes para el puesto', cantidad: 8 },
    { descripcion: 'Formato incompatible con lectores ATS',   cantidad: 3 },
    { descripcion: 'Sin sección de habilidades técnicas',     cantidad: 1 },
    { descripcion: 'Experiencia sin métricas ni resultados',  cantidad: 4 },
    { descripcion: 'Foto de perfil inapropiada detectada',    cantidad: 1 },
    { descripcion: 'Datos de contacto incompletos',           cantidad: 2 },
    { descripcion: 'Errores ortográficos en sección clave',   cantidad: 3 },
    { descripcion: 'Resumen profesional genérico',            cantidad: 1 },
    { descripcion: 'Fechas de experiencia inconsistentes',    cantidad: 2 },
  ],
  keywords_faltantes: ['liderazgo', 'gestión de proyectos', 'Excel avanzado', 'orientación a resultados'],
};

// POST / — Upload and analyze CV
router.post('/', analyzeRateLimit, upload.single('cv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No se recibió ningún archivo.' });
  }

  // Validate actual file bytes (before touching Claude)
  if (!validateMagicBytes(req.file.buffer, req.file.mimetype)) {
    return res.status(400).json({ ok: false, error: 'El archivo no es un PDF o Word válido.' });
  }

  try {
    const puesto    = sanitizePuesto(req.body?.puesto || '');
    const situacion = req.body?.situacion || null;
    const isDemo    = process.env.DEBUG_SECRET && req.body?.demo_key === process.env.DEBUG_SECRET;
    const rawEmail  = (req.body?.email || '').trim().toLowerCase();
    const leadEmail = isDemo ? null : (isValidEmail(rawEmail) ? rawEmail : null);
    console.log('[analyze] email raw:', rawEmail, '| valid:', !!leadEmail, '| isDemo:', isDemo);

    // Browser tracking data — captured early for use in CAPI events and session storage
    const _fbp = req.cookies?.['_fbp'] || null;
    const _fbc = req.cookies?.['_fbc'] || null;
    const _ip  = req.headers['x-vercel-forwarded-for']?.split(',')[0].trim()
              || req.headers['x-forwarded-for']?.split(',')[0].trim()
              || req.ip || null;
    const _ua  = req.headers['user-agent'] || null;

    let analysis;
    if (isDemo) {
      analysis = JSON.parse(JSON.stringify(DEMO_ANALYSIS)); // deep copy
    } else {
      // Quick CV check — minimal tokens
      const isCV = await checkIsCV(req.file.buffer, req.file.mimetype, req.file.originalname);
      if (!isCV) {
        return res.status(400).json({ ok: false, error: 'El archivo no parece ser un CV. Por favor subí tu currículum.' });
      }

      analysis = await analyzeCV(req.file.buffer, req.file.mimetype, req.file.originalname, puesto);

      if (Array.isArray(analysis.categorias)) {
        analysis.categorias = analysis.categorias.map(c => {
          if (c.nombre === 'Estructura')        c.puntaje = Math.min(c.puntaje, 50);
          if (c.nombre === 'Datos de contacto') c.puntaje = Math.min(c.puntaje, 75);
          return c;
        });
        analysis.score = Math.round(
          analysis.categorias.reduce((sum, c) => sum + (c.puntaje * c.peso / 100), 0)
        );
      }
    }

    const sessionId   = uuid();
    const storagePath = `${sessionId}/${req.file.originalname}`;

    // Score real + score visible (máx 60) — ambos se guardan en la DB
    const realScore    = analysis.score;
    const displayScore = realScore > 60 ? 60 : realScore;
    // Aplicar boost del 15% al score para mostrar
    const boostedScore = Math.min(100, Math.round(displayScore * 1.15));
    analysis.display_score = boostedScore;

    if (!isDemo && !isWhitelisted(_ip)) {
      // Fire AddToCart CAPI solo si el score real es <= 60
      if (realScore <= 60) {
        sendMetaEvent('AddToCart', {
          email:      leadEmail || null,
          externalId: sessionId,
          ip:         _ip,
          userAgent:  _ua,
          fbp:        _fbp,
          fbc:        _fbc,
          url:        req.headers['referer'] || process.env.FRONTEND_URL,
          eventId:    `addtocart_${sessionId}`,
          customData: { content_name: 'diagnostico_cv', value: 0, currency: 'ARS' },
        }).catch(err => console.error('[meta/addtocart]', err.message));
      }
      // Track CV upload in events table (for admin "add to cart" metric)
      trackEvent('add_to_cart', { score: realScore }).catch(err => console.error('[trackEvent/add_to_cart]', err.message));
    }

    // Upload CV to Supabase Storage (fire-and-forget, don't block response)
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    supabase.storage.from('cvs').upload(storagePath, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    }).catch(err => console.error('[storage] upload error:', err.message));

    if (puesto)  analysis._puesto = puesto;
    if (isDemo)  analysis._demo   = true;
    if (_fbp) analysis._fbp = _fbp;
    if (_fbc) analysis._fbc = _fbc;
    if (_ip)  analysis._ip  = _ip;
    if (_ua)  analysis._ua  = _ua;
    await save(sessionId, analysis, req.file.originalname, storagePath, situacion, leadEmail);

    if (leadEmail) {
      upsertLead({
        email:     leadEmail,
        score:     displayScore,
        puesto:    puesto || null,
        situacion: situacion || null,
        sessionId,
      }).catch(err => console.error('[brevo/lead]', err.message));
    }

    const partial = {
      sessionId,
      score:              displayScore,   // score visible para el usuario (máx 60)
      nivel:              analysis.nivel,
      resumen:            analysis.resumen,
      categorias:         Array.isArray(analysis.categorias) ? analysis.categorias : [],
      errores_total:      Array.isArray(analysis.errores) ? analysis.errores.length : 0,
      errores_preview:    Array.isArray(analysis.errores) ? analysis.errores.slice(0, 3) : [],
      keywords_faltantes: Array.isArray(analysis.keywords_faltantes) ? analysis.keywords_faltantes : [],
    };

    return res.json({ ok: true, partial });

  } catch (err) {
    console.error('[analyze] Error:', err.message);
    let status = 500;
    if (err.message?.includes('Solo se aceptan') || err.message?.includes('vacío') || err.message?.includes('no parece')) status = 400;
    if (err.message?.includes('muchas solicitudes') || err.message?.includes('límite')) status = 429;
    return res.status(status).json({ ok: false, error: err.message || 'Error interno. Intentá de nuevo.' });
  }
});

// GET /unlock/:sessionId
router.get('/unlock/:sessionId', async (req, res) => {
  const session = await get(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Sesión no encontrada o expirada.' });
  if (!session.paid) return res.status(402).json({ ok: false, error: 'Completá el pago primero.' });
  return res.json({ ok: true, analysis: session.data, tier: session.tier });
});

// GET /session/:sessionId — info for checkout pre-population from email link
router.get('/session/:sessionId', async (req, res) => {
  const session = await getForCheckout(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Sesión no encontrada.' });
  return res.json({ 
    ok: true, 
    paid: session.paid || false,
    name: session.contact_name || null,
    email: session.contact_email || null,
    data: session.data 
  });
});

// Multer error handler
router.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'El archivo es demasiado grande. Máximo 10 MB.' });
  }
  return res.status(400).json({ ok: false, error: err.message });
});

module.exports = router;
