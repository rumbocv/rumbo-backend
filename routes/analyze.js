const { Router } = require('express');
const multer     = require('multer');
const { v4: uuid } = require('uuid');
const { analyzeCV }     = require('../services/claude.js');
const { save, get }     = require('../services/sessions.js');
const { sendMetaEvent } = require('../services/meta.js');

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

// POST / — Upload and analyze CV
router.post('/', upload.single('cv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No se recibió ningún archivo.' });
  }

  try {
    const puesto   = (req.body?.puesto || '').trim() || null;
    const analysis = await analyzeCV(req.file.buffer, req.file.mimetype, req.file.originalname, puesto);

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

    const sessionId = uuid();
    await save(sessionId, analysis);

    const partial = {
      sessionId,
      score:              analysis.score,
      nivel:              analysis.nivel,
      resumen:            analysis.resumen,
      categorias:         Array.isArray(analysis.categorias) ? analysis.categorias : [],
      errores_total:      Array.isArray(analysis.errores) ? analysis.errores.length : 0,
      errores_preview:    Array.isArray(analysis.errores) ? analysis.errores.slice(0, 3) : [],
      keywords_faltantes: Array.isArray(analysis.keywords_faltantes) ? analysis.keywords_faltantes : [],
    };

    sendMetaEvent('Lead', {
      ip:         req.ip,
      userAgent:  req.headers['user-agent'],
      fbp:        req.cookies?.['_fbp'],
      fbc:        req.cookies?.['_fbc'],
      url:        req.headers['referer'] || process.env.FRONTEND_URL,
      eventId:    `lead_${sessionId}`,
      customData: { content_name: 'diagnostico_cv', value: 0, currency: 'ARS' },
    });

    return res.json({ ok: true, partial });

  } catch (err) {
    console.error('[analyze] Error:', err.message);
    const status = err.message?.includes('Solo se aceptan') ? 400 : 500;
    return res.status(status).json({ ok: false, error: err.message || 'Error interno.' });
  }
});

// GET /unlock/:sessionId
router.get('/unlock/:sessionId', async (req, res) => {
  const session = await get(req.params.sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Sesión no encontrada o expirada.' });
  if (!session.paid) return res.status(402).json({ ok: false, error: 'Completá el pago primero.' });
  return res.json({ ok: true, analysis: session.data, tier: session.tier });
});

// Multer error handler
router.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'El archivo es demasiado grande. Máximo 10 MB.' });
  }
  return res.status(400).json({ ok: false, error: err.message });
});

module.exports = router;
