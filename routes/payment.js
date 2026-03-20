// ============================================================
// routes/payment.js — MercadoPago checkout + webhook
// ============================================================
// POST /api/payment/create
//   Body: { sessionId, tier: 'informe' | 'cv' }
//   Creates a MercadoPago preference and returns checkoutUrl.
//
// POST /api/payment/webhook
//   Handles MercadoPago IPN/webhook notifications.
//   Marks the session as paid when status is 'approved'.
// ============================================================

import { Router }          from 'express';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { get, markPaid }   from '../services/sessions.js';
import { sendMetaEvent }   from '../services/meta.js';

const router = Router();

// ---------------------------------------------------------------
// MercadoPago SDK init
// ---------------------------------------------------------------
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || '',
});

// ---------------------------------------------------------------
// Pricing tiers (ARS)
// ---------------------------------------------------------------
const TIERS = {
  informe: {
    title:       'Informe Completo — Rumbo ATS',
    unit_price:  19990,
    description: 'Análisis completo de CV: todos los errores, keywords faltantes y fortalezas.',
  },
  cv: {
    title:       'CV Listo para Enviar — Rumbo ATS',
    unit_price:  34990,
    description: 'Informe completo + CV reescrito y optimizado para pasar filtros ATS en 24hs.',
  },
};

// ---------------------------------------------------------------
// POST /create — Create MercadoPago checkout preference
// ---------------------------------------------------------------
router.post('/create', async (req, res) => {
  const { sessionId, tier } = req.body;

  // Validate inputs
  if (!sessionId || !tier) {
    return res.status(400).json({ ok: false, error: 'sessionId y tier son requeridos.' });
  }
  if (!TIERS[tier]) {
    return res.status(400).json({ ok: false, error: 'Tier inválido. Usá "informe" o "cv".' });
  }

  // Make sure the session exists (and hasn't expired)
  const session = await get(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Sesión no encontrada o expirada. Analizá tu CV de nuevo.' });
  }

  const tierData   = TIERS[tier];
  const apiUrl     = process.env.API_URL || 'http://localhost:3001';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5500';

  try {
    const preference = new Preference(mpClient);

    const result = await preference.create({
      body: {
        items: [
          {
            id:          `${tier}-${sessionId}`,
            title:       tierData.title,
            description: tierData.description,
            quantity:    1,
            unit_price:  tierData.unit_price,
            currency_id: 'ARS',
          },
        ],
        // Pass sessionId + tier through so the webhook can match the payment
        external_reference: `${sessionId}|${tier}`,

        // Redirect URLs after payment flow
        back_urls: {
          success: `${frontendUrl}?payment=success&session=${sessionId}`,
          failure: `${frontendUrl}?payment=failure`,
          pending: `${frontendUrl}?payment=pending`,
        },
        auto_return: 'approved',

        // Webhook notification URL
        notification_url: `${apiUrl}/api/payment/webhook`,
      },
    });

    return res.json({
      ok:          true,
      checkoutUrl: result.init_point, // Live checkout URL
    });

  } catch (err) {
    console.error('[payment/create] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'No se pudo crear el checkout. Intentá de nuevo.' });
  }
});

// ---------------------------------------------------------------
// POST /webhook — Handle MercadoPago IPN notification
// ---------------------------------------------------------------
router.post('/webhook', async (req, res) => {
  // MercadoPago sends the payment id via query params (IPN style)
  // or in the body (Webhooks v2 style). We handle both.
  const paymentId = req.query.id || req.body?.data?.id;
  const topic     = req.query.topic || req.body?.type;

  // Acknowledge immediately — MP requires a quick 200
  res.sendStatus(200);

  // We only care about payment notifications
  if (topic !== 'payment' && topic !== 'payment_intent') return;
  if (!paymentId) return;

  try {
    const paymentApi = new Payment(mpClient);
    const payment    = await paymentApi.get({ id: paymentId });

    // Only process approved payments
    if (payment.status !== 'approved') return;

    // external_reference carries "sessionId|tier"
    const ref = payment.external_reference || '';
    const [sessionId, tier] = ref.split('|');

    if (!sessionId || !tier) {
      console.warn('[payment/webhook] Missing external_reference on payment', paymentId);
      return;
    }

    const updated = await markPaid(sessionId, tier);
    if (updated) {
      console.log(`[payment/webhook] Session ${sessionId} marked as paid (tier: ${tier})`);

      // Evento Purchase para Meta CAPI
      const tierData = TIERS[tier];
      sendMetaEvent('Purchase', {
        eventId:    `purchase_${paymentId}`,
        customData: {
          value:        tierData?.unit_price ?? 0,
          currency:     'ARS',
          content_name: tier === 'cv' ? 'cv_listo_para_enviar' : 'informe_completo',
          content_type: 'product',
          order_id:     String(paymentId),
        },
      });
    } else {
      console.warn(`[payment/webhook] Session ${sessionId} not found — may have expired`);
    }

  } catch (err) {
    console.error('[payment/webhook] Error fetching payment:', err.message);
  }
});

export default router;
