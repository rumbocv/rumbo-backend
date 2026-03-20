const crypto = require('crypto');

const PIXEL_ID     = process.env.META_PIXEL_ID;
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION  = 'v19.0';
const ENDPOINT     = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events`;

function hash(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).toLowerCase().trim()).digest('hex');
}

async function sendMetaEvent(eventName, opts = {}) {
  if (!PIXEL_ID || !ACCESS_TOKEN) {
    console.warn('[meta] Credenciales no configuradas — evento omitido.');
    return;
  }

  const userData = {
    em:                 hash(opts.email),
    client_ip_address:  opts.ip,
    client_user_agent:  opts.userAgent,
    fbp:                opts.fbp,
    fbc:                opts.fbc,
  };
  Object.keys(userData).forEach(k => userData[k] === undefined && delete userData[k]);

  const payload = {
    data: [{
      event_name:       eventName,
      event_time:       Math.floor(Date.now() / 1000),
      event_id:         opts.eventId || crypto.randomUUID(),
      action_source:    'website',
      event_source_url: opts.url || process.env.FRONTEND_URL || '',
      user_data:        userData,
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
    if (!res.ok) console.error('[meta] Error:', JSON.stringify(data));
    else console.log(`[meta] "${eventName}" enviado. Recibidos: ${data.events_received}`);
  } catch (err) {
    console.error('[meta] Error:', err.message);
  }
}

module.exports = { sendMetaEvent };
