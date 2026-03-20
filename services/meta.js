// ============================================================
// meta.js — Meta Conversions API (server-side events)
// Docs: https://developers.facebook.com/docs/marketing-api/conversions-api
// ============================================================
import crypto from 'crypto';

const PIXEL_ID      = process.env.META_PIXEL_ID;
const ACCESS_TOKEN  = process.env.META_ACCESS_TOKEN;
const API_VERSION   = 'v19.0';
const ENDPOINT      = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events`;

// SHA-256 hash requerido por Meta para datos personales
function hash(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).toLowerCase().trim()).digest('hex');
}

/**
 * Envía un evento a Meta CAPI.
 *
 * @param {string} eventName   - 'Purchase' | 'Lead' | 'ViewContent' | etc.
 * @param {object} opts
 * @param {string} [opts.email]
 * @param {string} [opts.ip]
 * @param {string} [opts.userAgent]
 * @param {string} [opts.fbp]        - cookie _fbp del browser
 * @param {string} [opts.fbc]        - cookie _fbc del browser
 * @param {string} [opts.eventId]    - ID único para deduplicar con pixel client-side
 * @param {object} [opts.customData] - { value, currency, content_name, ... }
 */
export async function sendMetaEvent(eventName, opts = {}) {
  if (!PIXEL_ID || !ACCESS_TOKEN) {
    console.warn('[meta] META_PIXEL_ID o META_ACCESS_TOKEN no configurados — evento omitido.');
    return;
  }

  const userData = {
    em:                  hash(opts.email),
    client_ip_address:   opts.ip,
    client_user_agent:   opts.userAgent,
    fbp:                 opts.fbp,
    fbc:                 opts.fbc,
  };

  // Eliminar campos undefined para no mandar ruido
  Object.keys(userData).forEach(k => userData[k] === undefined && delete userData[k]);

  const payload = {
    data: [{
      event_name:        eventName,
      event_time:        Math.floor(Date.now() / 1000),
      event_id:          opts.eventId || crypto.randomUUID(),
      action_source:     'website',
      event_source_url:  opts.url || process.env.FRONTEND_URL || '',
      user_data:         userData,
      ...(opts.customData && { custom_data: opts.customData }),
    }],
  };

  try {
    const res  = await fetch(`${ENDPOINT}?access_token=${ACCESS_TOKEN}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) {
      console.error('[meta] Error CAPI:', JSON.stringify(data));
    } else {
      console.log(`[meta] Evento "${eventName}" enviado. Recibidos: ${data.events_received}`);
    }
  } catch (err) {
    console.error('[meta] Fetch error:', err.message);
  }
}
