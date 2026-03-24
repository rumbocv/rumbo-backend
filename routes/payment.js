const { Router } = require('express');
const crypto     = require('crypto');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { isWhitelisted } = require('../middleware/security.js');
const { get, markPaid, markCheckout } = require('../services/sessions.js');
const { markPaid: brevoPaid, sendPurchaseConfirmation } = require('../services/brevo.js');
const { sendMetaEvent }   = require('../services/meta.js');
const { trackEvent }      = require('../services/events.js');
const { sendTelegram }    = require('../services/telegram.js');

// Verify MercadoPago webhook signature (HMAC-SHA256)
// Docs: https://www.mercadopago.com.ar/developers/en/docs/your-integrations/notifications/webhooks
function verifyMPWebhook(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // skip in dev if not configured

  const xSignature = req.headers['x-signature']   || '';
  const xRequestId = req.headers['x-request-id']  || '';
  const paymentId  = req.query.id || req.body?.data?.id;

  // IPN format (legacy) doesn't send signature headers — allow through.
  // The payment is verified against the MP API anyway (Payment.get).
  if (!xSignature || !xRequestId || !paymentId) return true;

  // Parse ts= and v1= from the header
  const parts = {};
  xSignature.split(',').forEach(part => {
    const idx = part.indexOf('=');
    if (idx !== -1) parts[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  });

  if (!parts.ts || !parts.v1) return true;

  const manifest = `id:${paymentId};request-id:${xRequestId};ts:${parts.ts}`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

const router   = Router();
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || '' });

const TIERS = {
  cv: {
    title:      'CV Listo para Enviar — Rumbo ATS',
    unit_price: 29990,
    original_price: 59990,
    description:'Informe completo + CV reescrito y optimizado para pasar filtros ATS en 24hs.',
  },
  informe: {
    title:      'Informe Completo — Rumbo ATS',
    unit_price: 19990,
    original_price: 39990,
    description:'Análisis completo de CV: todos los errores, keywords faltantes y fortalezas.',
  },
};

// POST /create
router.post('/create', async (req, res) => {
  const { sessionId, tier, utm, eventId } = req.body;
  if (!sessionId || !tier)  return res.status(400).json({ ok: false, error: 'sessionId y tier son requeridos.' });
  if (!TIERS[tier])         return res.status(400).json({ ok: false, error: 'Tier inválido.' });

  const session = await get(sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Sesión no encontrada o expirada.' });

  const tierData    = TIERS[tier];
  const apiUrl      = process.env.API_URL      || 'https://rumbo-six.vercel.app';
  const frontendUrl = process.env.FRONTEND_URL || 'https://rumbo-six.vercel.app';

  try {
    const userIp = session?.data?._ip || req.ip;
    if (!isWhitelisted(userIp)) {
      trackEvent('checkout', { tier, utm: utm || {} }).catch(err => console.error('[trackEvent/checkout]', err.message));
      markCheckout(sessionId, tier).catch(err => console.error('[markCheckout]', err.message));
    }

    // Meta CAPI — InitiateCheckout
    if (!isWhitelisted(userIp)) sendMetaEvent('InitiateCheckout', {
      email:      session?.lead_email || null,
      externalId: sessionId,
      ip:         session?.data?._ip  || req.ip,
      userAgent:  session?.data?._ua  || req.headers['user-agent'],
      fbp:        req.body?.fbp       || session?.data?._fbp || null,
      fbc:        req.body?.fbc       || session?.data?._fbc || null,
      url:        req.headers['referer'] || frontendUrl,
      eventId:    eventId || `checkout_${sessionId}_${tier}_${Date.now()}`,
      customData: {
        content_name: tier === 'cv' ? 'cv_listo_para_enviar' : 'informe_completo',
        value:        TIERS[tier].unit_price,
        currency:     'ARS',
        num_items:    1,
      },
    }).catch(err => console.error('[meta/checkout]', err.message));

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
          success: `${frontendUrl}/thank-you?session=${sessionId}`,
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
  // Reject forged webhooks
  if (!verifyMPWebhook(req)) {
    console.warn('[payment/webhook] Firma inválida — descartado');
    return res.sendStatus(200); // return 200 so MP doesn't retry, but do nothing
  }

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
      const amount  = TIERS[tier]?.unit_price ?? 0;
      const session = await get(sessionId);
      const orderNum = session?.order_number ? `#${session.order_number}` : `ID: ${paymentId}`;
      const tierLabel = tier === 'cv' ? 'CV Listo para Enviar' : 'Informe Completo';
      sendTelegram(`💰 Nueva compra\n<b>Orden:</b> ${orderNum}\n<b>Plan:</b> ${tierLabel}\n<b>Importe:</b> $${amount.toLocaleString('es-AR')}`).catch(() => {});

      const toEmail = session?.contact_email || session?.lead_email;
      if (toEmail) {
        brevoPaid({ email: toEmail, tier }).catch(() => {});
        sendPurchaseConfirmation({
          email:       toEmail,
          name:        session?.contact_name || null,
          tier,
          orderNumber: session?.order_number || null,
        }).catch(() => {});
      }

      const sessionUserIp = session?.data?._ip || null;
      if (!isWhitelisted(sessionUserIp)) {
        await Promise.all([
          trackEvent('purchase', { tier, amount: TIERS[tier]?.unit_price }).catch(err =>
            console.error('[trackEvent/purchase]', err.message)
          ),
          sendMetaEvent('Purchase', {
            email:      toEmail || null,
            externalId: sessionId,
            firstName:  session?.contact_name ? session.contact_name.trim().split(' ')[0] : null,
            lastName:   session?.contact_name ? session.contact_name.trim().split(' ').slice(1).join(' ') || null : null,
            ip:         sessionUserIp,
            userAgent:  session?.data?._ua  || null,
            fbp:        session?.data?._fbp || null,
            fbc:        session?.data?._fbc || null,
            url:        process.env.FRONTEND_URL,
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
    }
  } catch (err) {
    console.error('[payment/webhook]', err.message);
  }

  return res.sendStatus(200);
});

module.exports = router;
