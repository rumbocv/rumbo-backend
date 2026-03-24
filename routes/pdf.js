const express = require('express');
const { generatePdfFromHtml } = require('../services/pdf.js');

const router = express.Router();

// POST /api/pdf/generate
// Body: { html: string }
// Returns: PDF binary stream
router.post('/generate', async (req, res) => {
  const { html } = req.body || {};

  if (!html || typeof html !== 'string' || html.length < 50) {
    return res.status(400).json({ ok: false, error: 'html requerido.' });
  }

  // Rough size guard — reject suspiciously large payloads
  if (html.length > 5_000_000) {
    return res.status(413).json({ ok: false, error: 'HTML demasiado grande.' });
  }

  try {
    console.log('[pdf] Generating PDF, html size:', html.length);
    const buffer = await generatePdfFromHtml(html);
    console.log('[pdf] Generated, bytes:', buffer.length);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="documento.pdf"');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('[pdf] Error:', err.message);
    res.status(500).json({ ok: false, error: 'Error al generar el PDF.' });
  }
});

module.exports = router;
