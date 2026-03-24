const BREVO_API  = 'https://api.brevo.com/v3';
const BREVO_LIST = 5; // "Leads Rumbo"

function headers() {
  return {
    'accept':       'application/json',
    'content-type': 'application/json',
    'api-key':      process.env.BREVO_API_KEY,
  };
}

// Crear o actualizar contacto cuando llega un lead
async function upsertLead({ email, name, score, puesto, situacion, sessionId }) {
  if (!process.env.BREVO_API_KEY) { console.error('[brevo] BREVO_API_KEY not set'); return; }
  if (!email) { console.error('[brevo] no email provided'); return; }
  try {
    const body = JSON.stringify({
      email,
      attributes: {
        PAID:       false,
        NOMBRE:     name      || null,
        SCORE:      score     || null,
        PUESTO:     puesto    || null,
        SITUACION:  situacion || null,
        SESSION_ID: sessionId || null,
      },
      listIds:       [BREVO_LIST],
      updateEnabled: true,
    });
    console.log('[brevo/upsertLead] email:', email, '| key prefix:', process.env.BREVO_API_KEY?.slice(0, 12));
    const res  = await fetch(`${BREVO_API}/contacts`, { method: 'POST', headers: headers(), body });
    const json = await res.json();
    console.log('[brevo/upsertLead] status:', res.status, '| body:', JSON.stringify(json));
  } catch (err) {
    console.error('[brevo/upsertLead] error:', err.message);
  }
}

// Marcar como pagado cuando llega el webhook de MercadoPago
async function markPaid({ email, tier }) {
  if (!process.env.BREVO_API_KEY || !email) return;
  try {
    const res  = await fetch(`${BREVO_API}/contacts/${encodeURIComponent(email)}`, {
      method:  'PUT',
      headers: headers(),
      body: JSON.stringify({ attributes: { PAID: true, TIER: tier || null } }),
    });
    const json = await res.json();
    console.log('[brevo/markPaid] status:', res.status, JSON.stringify(json));
  } catch (err) {
    console.error('[brevo/markPaid] error:', err.message);
  }
}

async function sendPurchaseConfirmation({ email, name, tier, orderNumber }) {
  if (!process.env.BREVO_API_KEY || !email) return;
  const tierLabel  = tier === 'cv' ? 'CV Listo para Enviar' : 'Informe Completo';
  const firstName  = name ? name.split(' ')[0] : null;
  const greeting   = firstName ? `Hola ${firstName},` : 'Hola,';
  const orderLine  = orderNumber ? `<span style="font-family:monospace;font-size:15px;font-weight:700;color:#0a1628">#${orderNumber}</span>` : '';
  const fromEmail  = process.env.FROM_EMAIL_ADDR || 'hola@rumbocv.com';

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f2f5;padding:40px 16px 60px">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.09)">

  <!-- Header -->
  <tr>
    <td style="background:#0f1f3d;padding:26px 40px;text-align:center">
      <span style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">rumbo<span style="color:#22c55e">.</span></span>
    </td>
  </tr>

  <!-- Hero -->
  <tr>
    <td style="padding:44px 40px 0;text-align:center">
      <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 20px">
        <tr>
          <td width="68" height="68" style="background:#dcfce7;border-radius:34px;text-align:center;vertical-align:middle">
            <span style="font-size:30px;line-height:68px;color:#16a34a">✓</span>
          </td>
        </tr>
      </table>
      <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:#0f1f3d;letter-spacing:-0.4px">¡Compra confirmada!</h1>
      <p style="margin:0;font-size:14px;color:#6b7280;font-weight:500">${tierLabel}</p>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:32px 40px 0">
      <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.7">${greeting} recibimos tu pago y ya estamos trabajando en tu pedido.</p>

      ${orderNumber ? `
      <!-- Orden -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:24px">
        <tr>
          <td style="padding:14px 20px">
            <span style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.07em;display:block;margin-bottom:4px">Número de orden</span>
            <span style="font-size:18px;font-weight:800;color:#0f1f3d;font-family:monospace">#${orderNumber}</span>
          </td>
        </tr>
      </table>` : ''}

      <!-- Qué sigue -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;margin-bottom:28px">
        <tr>
          <td style="padding:20px 24px">
            <p style="margin:0 0 14px;font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:0.07em">¿Qué sigue?</p>
            <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px">
              <tr>
                <td width="26" valign="top" style="padding-top:1px">
                  <table cellpadding="0" cellspacing="0" border="0">
                    <tr><td width="22" height="22" style="background:#22c55e;border-radius:11px;text-align:center;vertical-align:middle;font-size:11px;font-weight:700;color:#fff;line-height:22px">1</td></tr>
                  </table>
                </td>
                <td style="font-size:14px;color:#166534;line-height:1.6;padding-left:10px">Nuestro equipo analiza tu CV en detalle.</td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="26" valign="top" style="padding-top:1px">
                  <table cellpadding="0" cellspacing="0" border="0">
                    <tr><td width="22" height="22" style="background:#22c55e;border-radius:11px;text-align:center;vertical-align:middle;font-size:11px;font-weight:700;color:#fff;line-height:22px">2</td></tr>
                  </table>
                </td>
                <td style="font-size:14px;color:#166534;line-height:1.6;padding-left:10px">Recibís tu${tier === 'cv' ? ' CV reescrito y optimizado' : ' informe completo'} en este correo en las próximas <strong>24 horas</strong>.</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 40px;font-size:14px;color:#6b7280;line-height:1.7">¿Tenés alguna duda? Escribinos por Instagram <a href="https://www.instagram.com/rumbo.cv" style="color:#0f1f3d;font-weight:600;text-decoration:none">@rumbo.cv</a> y te respondemos a la brevedad.</p>
    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="border-top:1px solid #f3f4f6;padding:20px 40px;text-align:center">
      <p style="margin:0;font-size:11px;color:#9ca3af">
        Rumbo · <a href="https://www.rumbocv.com" style="color:#9ca3af;text-decoration:none">rumbocv.com</a>
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  try {
    const res = await fetch(`${BREVO_API}/smtp/email`, {
      method:  'POST',
      headers: headers(),
      body: JSON.stringify({
        sender:      { name: 'Rumbo', email: fromEmail },
        replyTo:     { email: fromEmail },
        to:          [{ email, ...(name ? { name } : {}) }],
        subject:     `✅ Compra confirmada — orden #${orderNumber || 'Rumbo'}`,
        htmlContent: html,
      }),
    });
    const json = await res.json();
    console.log('[brevo/confirmation] status:', res.status, JSON.stringify(json));
  } catch (err) {
    console.error('[brevo/confirmation] error:', err.message);
  }
}

module.exports = { upsertLead, markPaid, sendPurchaseConfirmation, syncUnpaidLeads };

// Sincronizar todos los leads no pagados de la DB a Brevo
async function syncUnpaidLeads(supabase) {
  if (!process.env.BREVO_API_KEY) { console.error('[brevo/sync] BREVO_API_KEY not set'); return { synced: 0 }; }
  
  const { data, error } = await supabase
    .from('sessions')
    .select('id, contact_email, contact_name, lead_email, data, situacion')
    .eq('paid', false);

  if (error) { console.error('[brevo/sync] fetch error:', error.message); return { synced: 0 }; }
  
  let synced = 0;
  for (const row of data || []) {
    const email = row.contact_email || row.lead_email;
    if (!email) continue;
    
    let score = null, puesto = null;
    try {
      const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      score  = parsed?.score   || null;
      puesto = parsed?._puesto || null;
    } catch (e) { /* ignore parse errors */ }
    
    await upsertLead({
      email,
      name:      row.contact_name || null,
      score,
      puesto,
      situacion: row.situacion || null,
      sessionId: row.id,
    });
    synced++;
  }
  
  console.log(`[brevo/sync] synced ${synced} unpaid leads`);
  return { synced };
}
