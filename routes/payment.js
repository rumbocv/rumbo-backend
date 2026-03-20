const { Router } = require('express');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { get, markPaid }   = require('../services/sessions.js');
const { sendMetaEvent }   = require('../services/meta.js');
const { trackEvent }      = require('../services/events.js');

const router   = Router();
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || '' });

const TIERS = {
  informe: {
    title:      'Informe Completo — Rumbo ATS',
    unit_price: 19990,
    description:'Análisis completo de CV: todos los errores, keywords faltantes y fortalezas.',
  },
  cv: {
    title:      'CV Listo para Enviar — Rumbo ATS',
    unit_price: 34990,
    description:'Informe completo + CV reescrito y optimizado para pasar filtros ATS en 24hs.',
  },
};

// POST /create
router.post('/create', async (req, res) => {
  const { sessionId, tier } = req.body;
  if (!sessionId || !tier)  return res.status(400).json({ ok: false, error: 'sessionId y tier son requeridos.' });
  if (!TIERS[tier])         return res.status(400).json({ ok: false, error: 'Tier inválido.' });

  const session = await get(sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Sesión no encontrada o expirada.' });

  const tierData    = TIERS[tier];
  const apiUrl      = process.env.API_URL      || 'http://localhost:3001';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5500';

  try {
    trackEvent('checkout', { tier }).catch(err => console.error('[trackEvent/checkout]', err.message));

    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: [{
          id:          `${tier}-${sessionId}`,
          title:       tierData.title,
          description: tierData.description,
          quantity:    1,
          unit_price:  tierData.unit_price,
          currency_id: 'ARS',
        }],
        external_reference: `${sessionId}|${tier}`,
        back_urls: {
          success: `${frontendUrl}?payment=success&session=${sessionId}`,
          failure: `${frontendUrl}?payment=failure`,
          pending: `${frontendUrl}?payment=pending`,
        },
        auto_return:      'approved',
        notification_url: `${apiUrl}/api/payment/webhook`,
      },
    });
    return res.json({ ok: true, checkoutUrl: result.init_point });
  } catch (err) {
    console.error('[payment/create]', err.message);
    return res.status(500).json({ ok: false, error: 'No se pudo crear el checkout.' });
  }
});

// POST /webhook
router.post('/webhook', async (req, res) => {
  const paymentId = req.query.id || req.body?.data?.id;
  const topic     = req.query.topic || req.body?.type;

  if (topic !== 'payment' && topic !== 'payment_intent' || !paymentId) {
    return res.sendStatus(200);
  }

  try {
    const payment = await new Payment(mpClient).get({ id: paymentId });
    if (payment.status !== 'approved') return res.sendStatus(200);

    const [sessionId, tier] = (payment.external_reference || '').split('|');
    if (!sessionId || !tier) return res.sendStatus(200);

    const updated = await markPaid(sessionId, tier);
    if (updated) {
      await Promise.all([
        trackEvent('purchase', { tier, amount: TIERS[tier]?.unit_price }).catch(err =>
          console.error('[trackEvent/purchase]', err.message)
        ),
        sendMetaEvent('Purchase', {
          eventId:    `purchase_${paymentId}`,
          customData: {
            value:        TIERS[tier]?.unit_price ?? 0,
            currency:     'ARS',
            content_name: tier === 'cv' ? 'cv_listo_para_enviar' : 'informe_completo',
            content_type: 'product',
            order_id:     String(paymentId),
          },
        }),
      ]);
    }
  } catch (err) {
    console.error('[payment/webhook]', err.message);
  }

  return res.sendStatus(200);
});

module.exports = router;
