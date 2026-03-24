const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = process.env.FROM_EMAIL || 'Rumbo <noreply@rumbocv.com>';

// ----------------------------------------------------------------
// sendPartialReport — enviado justo después del análisis
// ----------------------------------------------------------------
async function sendPartialReport({ email, score, nivel, resumen, errores_total, errores_preview = [], puesto }) {
  const nivelColor = nivel?.toLowerCase() === 'alto' ? '#16a34a'
    : nivel?.toLowerCase() === 'medio' ? '#d97706'
    : '#dc2626';

  const erroresHtml = errores_preview.slice(0, 3).map(e =>
    `<li style="margin-bottom:8px;padding:10px 14px;background:#fef2f2;border-left:3px solid #ef4444;border-radius:0 8px 8px 0;font-size:14px;color:#374151">
       <strong>×${e.cantidad ?? 1}</strong> — ${e.descripcion}
     </li>`
  ).join('');

  const puestoLinea = puesto
    ? `<p style="margin:0 0 16px;font-size:15px;color:#6b7280">Analizado para: <strong style="color:#0a1628">${puesto}</strong></p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <!-- Header -->
    <div style="background:#0a1628;padding:32px 40px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.5px">rumbo<span style="color:#00d26a">.</span></div>
      <div style="margin-top:8px;font-size:13px;color:rgba(255,255,255,.6)">Diagnóstico de CV</div>
    </div>

    <!-- Score -->
    <div style="padding:40px 40px 0;text-align:center">
      <div style="display:inline-block;width:96px;height:96px;border-radius:50%;background:#f3f4f6;line-height:96px;font-size:36px;font-weight:800;color:#0a1628">${score}</div>
      <div style="margin-top:12px;font-size:13px;font-weight:700;color:${nivelColor};text-transform:uppercase;letter-spacing:1px">Nivel ${nivel || ''}</div>
      <div style="margin:6px 0 0;font-size:13px;color:#9ca3af">sobre 100 puntos</div>
    </div>

    <!-- Body -->
    <div style="padding:32px 40px">
      ${puestoLinea}
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6">${resumen || ''}</p>

      <div style="margin-bottom:8px;font-size:13px;font-weight:700;color:#0a1628;text-transform:uppercase;letter-spacing:.5px">
        ${errores_total} errores detectados — vista previa
      </div>
      <ul style="list-style:none;padding:0;margin:0 0 28px">
        ${erroresHtml}
        <li style="margin-top:8px;padding:10px 14px;background:#f9fafb;border-radius:8px;font-size:13px;color:#9ca3af;text-align:center">
          🔒 ${Math.max(0, errores_total - errores_preview.length)} errores más — desbloqueá el informe completo
        </li>
      </ul>

      <!-- CTA -->
      <div style="text-align:center;margin-bottom:32px">
        <a href="${process.env.FRONTEND_URL || 'https://rumbocv.com'}?utm_source=email&utm_medium=partial_report&utm_campaign=lead"
           style="display:inline-block;background:#00d26a;color:#0a1628;font-weight:700;font-size:15px;padding:14px 36px;border-radius:10px;text-decoration:none">
          Ver informe completo →
        </a>
        <div style="margin-top:12px;font-size:12px;color:#9ca3af">Al costo de un almuerzo</div>
      </div>

      <hr style="border:none;border-top:1px solid #f3f4f6;margin:0 0 24px">
      <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center">
        Recibiste este email porque subiste tu CV a Rumbo.<br>
        Si no fuiste vos, ignorá este mensaje.
      </p>
    </div>
  </div>
</body>
</html>`;

  return resend.emails.send({
    from: FROM,
    to:   email,
    subject: `Tu CV obtuvo ${score}/100 — ${errores_total} errores detectados`,
    html,
  });
}

// ----------------------------------------------------------------
// sendFollowUp — 24 h después si no pagó
// ----------------------------------------------------------------
async function sendFollowUp({ email, score, puesto, errores_total }) {
  const puestoLinea = puesto
    ? `para el puesto de <strong>${puesto}</strong> `
    : '';

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:#0a1628;padding:32px 40px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.5px">rumbo<span style="color:#00d26a">.</span></div>
    </div>
    <div style="padding:40px">
      <p style="margin:0 0 20px;font-size:16px;font-weight:700;color:#0a1628">¿Seguís buscando trabajo ${puestoLinea}?</p>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6">
        Ayer analizamos tu CV y detectamos <strong>${errores_total ?? 'varios'} errores</strong> que podrían estar frenando tus chances.
        Tu score fue <strong>${score}/100</strong>.
      </p>
      <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.6">
        El informe completo te muestra exactamente qué arreglar, con un CV reescrito incluido si elegís el plan premium.
      </p>
      <div style="text-align:center;margin-bottom:32px">
        <a href="${process.env.FRONTEND_URL || 'https://rumbocv.com'}?utm_source=email&utm_medium=followup_24h&utm_campaign=lead"
           style="display:inline-block;background:#00d26a;color:#0a1628;font-weight:700;font-size:15px;padding:14px 36px;border-radius:10px;text-decoration:none">
          Ver mi informe completo →
        </a>
      </div>
      <hr style="border:none;border-top:1px solid #f3f4f6;margin:0 0 24px">
      <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center">
        Recibiste este email porque subiste tu CV a Rumbo.<br>
        Si no querés recibir más emails, ignorá este mensaje.
      </p>
    </div>
  </div>
</body>
</html>`;

  return resend.emails.send({
    from: FROM,
    to:   email,
    subject: `Tu informe de CV sigue esperándote — ${score}/100`,
    html,
  });
}

// ----------------------------------------------------------------
// sendPaymentConfirmation — después de pagar
// ----------------------------------------------------------------
async function sendPaymentConfirmation({ email, name, tier }) {
  const tierLabel = tier === 'cv' ? 'Informe + CV reescrito' : 'Informe completo';

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:#0a1628;padding:32px 40px;text-align:center">
      <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.5px">rumbo<span style="color:#00d26a">.</span></div>
    </div>
    <div style="padding:40px">
      <div style="text-align:center;margin-bottom:28px">
        <div style="font-size:40px">✅</div>
        <div style="margin-top:12px;font-size:20px;font-weight:800;color:#0a1628">¡Pago recibido!</div>
        <div style="margin-top:6px;font-size:14px;color:#6b7280">${tierLabel}</div>
      </div>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6">
        Hola${name ? ` ${name.split(' ')[0]}` : ''}, recibimos tu pago correctamente.
        Tu informe completo${tier === 'cv' ? ' y CV reescrito están' : ' está'} siendo preparado y te lo enviamos en las próximas <strong>24 horas</strong>.
      </p>
      <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.6">
        Si tenés alguna duda, respondé este email y te ayudamos.
      </p>
      <hr style="border:none;border-top:1px solid #f3f4f6;margin:0 0 24px">
      <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center">
        Compra protegida · Revisiones ilimitadas · Garantía de devolución
      </p>
    </div>
  </div>
</body>
</html>`;

  return resend.emails.send({
    from: FROM,
    to:   email,
    subject: '✅ Pago recibido — tu informe está en camino',
    html,
  });
}

module.exports = { sendPartialReport, sendFollowUp, sendPaymentConfirmation };
