async function sendTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('[telegram] Credenciales no configuradas — notificación omitida.');
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) console.error('[telegram] Error:', data.description);
  } catch (err) {
    console.error('[telegram] fetch error:', err.message);
  }
}

module.exports = { sendTelegram };
