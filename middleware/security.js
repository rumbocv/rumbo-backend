const { createClient } = require('@supabase/supabase-js');

// ── 1. Origin check ───────────────────────────────────────────────────────────
// Only accepts requests from the configured FRONTEND_URL.
// Skips check in local dev (localhost).
function checkOrigin(req, res, next) {
  const landingUrl  = (process.env.LANDING_URL   || '').replace(/\/$/, '');
  const backendUrl  = (process.env.API_URL        || '').replace(/\/$/, '');

  // Skip in local dev
  if (!landingUrl || landingUrl.includes('localhost')) return next();

  const origin  = (req.headers['origin']  || '').replace(/\/$/, '');
  const referer = (req.headers['referer'] || '');

  function getHostname(value) {
    if (!value) return null;
    try {
      return new URL(value).hostname;
    } catch (_) {
      return null;
    }
  }

  const allowedHosts = new Set(['rumbocv.com', 'www.rumbocv.com', 'rumbo-six.vercel.app', 'landing-sigma-drab.vercel.app']);
  const originHost   = getHostname(origin);
  const refererHost  = getHostname(referer);
  const isAllowedDomain = [originHost, refererHost].some(host => host && allowedHosts.has(host));

  // Also allow explicitly configured URLs
  const explicitUrls = [landingUrl, backendUrl].filter(Boolean);
  const isExplicitUrl = explicitUrls.some(url => origin === url || referer.startsWith(url));

  if (isAllowedDomain || isExplicitUrl) return next();

  console.warn('[security] Blocked origin:', origin || referer || '(none)');
  return res.status(403).json({ ok: false, error: 'Acceso no permitido.' });
}

// ── 2. Internal IP whitelist ───────────────────────────────────────────────────
// IPs in this list skip rate limiting AND all analytics/tracking events.
const WHITELISTED_IPS = new Set([process.env.INTERNAL_IP].filter(Boolean));

function resolveIp(req) {
  const xVercel = req.headers['x-vercel-forwarded-for'];
  const xFwd    = req.headers['x-forwarded-for'];
  return xVercel
    ? xVercel.split(',')[0].trim()
    : xFwd
      ? xFwd.split(',').pop().trim()
      : req.ip || 'unknown';
}

function isWhitelisted(ip) {
  return WHITELISTED_IPS.has(ip);
}

// ── 3. Rate limiting via Supabase (works across Vercel instances) ─────────────
// Allows MAX_ANALYZE_PER_WINDOW requests per IP in WINDOW_MS milliseconds.
const WINDOW_MS              = 15 * 60 * 1000; // 15 min
const MAX_ANALYZE_PER_WINDOW = 5;

async function analyzeRateLimit(req, res, next) {
  const ip = resolveIp(req);

  // Whitelisted IPs bypass rate limit entirely
  if (isWhitelisted(ip)) return next();

  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    // Re-use resolved ip for Supabase query

    const { count } = await supabase
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('type', 'analyze_attempt')
      .eq('metadata->>ip', ip)
      .gte('created_at', since);

    if (count >= MAX_ANALYZE_PER_WINDOW) {
      console.warn('[security] Rate limit hit for IP:', ip);
      return res.status(429).json({
        ok: false,
        error: 'Demasiados intentos. Esperá 15 minutos e intentá de nuevo.',
      });
    }

    // Log attempt (fire-and-forget, don't block)
    supabase.from('events').insert({ type: 'analyze_attempt', metadata: { ip } }).then(() => {}).catch(() => {});
  } catch (err) {
    console.error('[security/rateLimit]', err.message);
    // Don't block if Supabase is down
  }

  next();
}

// ── 3. File magic bytes validation ───────────────────────────────────────────
// Checks actual binary signature before sending to Claude.
// PDF: %PDF | DOCX: PK (ZIP) | DOC: OLE2 magic
function validateMagicBytes(buffer, mimetype) {
  if (!buffer || buffer.length < 8) return false;

  const isPDF  = buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46; // %PDF
  const isZIP  = buffer[0] === 0x50 && buffer[1] === 0x4B; // PK (DOCX/ZIP)
  const isOLE2 = buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0; // DOC

  if (mimetype === 'application/pdf') return isPDF;
  if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return isZIP;
  if (mimetype === 'application/msword') return isOLE2 || isZIP;

  return isPDF || isZIP || isOLE2;
}

// ── 4. Prompt injection sanitization ─────────────────────────────────────────
// Strips patterns that attempt to hijack the Claude prompt via the `puesto` field.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier|former)?\s*(instructions?|prompts?|context|rules?|constraints?)/gi,
  /disregard\s+(all\s+)?(previous|prior|above)?\s*(instructions?|prompts?)/gi,
  /you\s+are\s+now\s+/gi,
  /act\s+as\s+(a\s+)?(?!recruiter|hr|human)/gi,
  /system\s*:\s*/gi,
  /\bDAN\b/g,
  /<\|.*?\|>/g,           // special tokens like <|endoftext|>
  /\[INST\]|\[\/INST\]/g, // llama-style injection
  /###\s*(instruction|system|human|assistant)/gi,
];

function sanitizePuesto(puesto) {
  if (!puesto) return null;
  let cleaned = puesto.slice(0, 200); // hard cap
  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return cleaned || null;
}

module.exports = { checkOrigin, analyzeRateLimit, validateMagicBytes, sanitizePuesto, isWhitelisted, resolveIp };
