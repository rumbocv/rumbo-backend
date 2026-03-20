// ============================================================
// routes/analyze.js — CV upload + analysis endpoints
// ============================================================
// POST /api/analyze
//   Accepts a multipart/form-data upload (field: "cv").
//   Runs Claude analysis, stores full result in session,
//   returns only a partial (freemium gate) response.
//
// GET /api/analyze/unlock/:sessionId
//   Returns the full analysis for a paid session.
// ============================================================

import { Router }    from 'express';
import multer        from 'multer';
import { v4 as uuid } from 'uuid';
import { analyzeCV }     from '../services/claude.js';
import { save, get }     from '../services/sessions.js';
import { sendMetaEvent } from '../services/meta.js';

const router = Router();

// ---------------------------------------------------------------
// Multer — memory storage, 10 MB limit, PDF/DOC/DOCX only
// ---------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    const allowedExts = /\.(pdf|doc|docx)$/i;

    if (allowed.includes(file.mimetype) || allowedExts.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se aceptan archivos PDF, DOC o DOCX.'));
    }
  },
});

// ---------------------------------------------------------------
// POST / — Upload and analyze CV
// ---------------------------------------------------------------
router.post('/', upload.single('cv'), async (req, res) => {
  // multer error passthrough (e.g. wrong file type, size exceeded)
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'No se recibió ningún archivo.' });
  }

  try {
    const puesto = (req.body?.puesto || '').trim() || null;

    // Run Claude analysis
    const analysis = await analyzeCV(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
      puesto
    );

    // Cap scores for categories that are always artificially high
    if (Array.isArray(analysis.categorias)) {
      analysis.categorias = analysis.categorias.map(c => {
        if (c.nombre === 'Estructura')         c.puntaje = Math.min(c.puntaje, 50);
        if (c.nombre === 'Datos de contacto') c.puntaje = Math.min(c.puntaje, 75);
        return c;
      });
      // Recalculate weighted score
      analysis.score = Math.round(
        analysis.categorias.reduce((sum, c) => sum + (c.puntaje * c.peso / 100), 0)
      );
    }

    // Persist the FULL result to session (48h TTL)
    const sessionId = uuid();
    await save(sessionId, analysis);

    // ---- Build partial response (freemium gate) ----
    const partial = {
      sessionId,
      score:           analysis.score,
      nivel:           analysis.nivel,
      resumen:         analysis.resumen,
      categorias:      Array.isArray(analysis.categorias) ? analysis.categorias : [],
      errores_total:   Array.isArray(analysis.errores) ? analysis.errores.length : 0,
      errores_preview: Array.isArray(analysis.errores) ? analysis.errores.slice(0, 3) : [],
      keywords_faltantes: Array.isArray(analysis.keywords_faltantes) ? analysis.keywords_faltantes : [],
    };

    // Evento Lead — usuario vio su análisis
    sendMetaEvent('Lead', {
      ip:        req.ip,
      userAgent: req.headers['user-agent'],
      fbp:       req.cookies?.['_fbp'],
      fbc:       req.cookies?.['_fbc'],
      url:       req.headers['referer'] || process.env.FRONTEND_URL,
      eventId:   `lead_${sessionId}`,
      customData: { content_name: 'diagnostico_cv', value: 0, currency: 'ARS' },
    });

    return res.json({ ok: true, partial });

  } catch (err) {
    console.error('[analyze] Error:', err.message);

    // Surface user-friendly errors vs generic 500
    const status = err.message?.includes('Solo se aceptan') ? 400 : 500;
    return res.status(status).json({ ok: false, error: err.message || 'Error interno al analizar el CV.' });
  }
});

// ---------------------------------------------------------------
// GET /unlock/:sessionId — Return full analysis for paid sessions
// ---------------------------------------------------------------
router.get('/unlock/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  const session = await get(sessionId);

  if (!session) {
    return res.status(404).json({ ok: false, error: 'Sesión no encontrada o expirada.' });
  }

  if (!session.paid) {
    return res.status(402).json({ ok: false, error: 'Acceso no autorizado. Completá el pago primero.' });
  }

  return res.json({ ok: true, analysis: session.data, tier: session.tier });
});

// ---------------------------------------------------------------
// Multer error handler (file too large, wrong type, etc.)
// ---------------------------------------------------------------
router.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'El archivo es demasiado grande. Máximo 10 MB.' });
  }
  console.error('[analyze] Middleware error:', err.message);
  return res.status(400).json({ ok: false, error: err.message });
});

export default router;
