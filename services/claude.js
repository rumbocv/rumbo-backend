const Anthropic = require('@anthropic-ai/sdk');
const mammoth   = require('mammoth');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildPrompt(puesto) {
  const puestoLine = puesto
    ? `El candidato busca el puesto: "${puesto}". Evaluá keywords y logros en relación a ese rol específico.`
    : `No se especificó puesto. Inferí el rol objetivo del CV y evaluá en base a eso.`;

  return `Sos un experto ATS para LATAM. ${puestoLine}
Analizá el CV adjunto y devolvé SOLO JSON válido. Toda la información debe ser ESPECÍFICA al CV leído, nunca genérica.

{
  "score": <0-100, promedio ponderado de categorias>,
  "nivel": "<muy bajo|bajo|medio|alto>",
  "resumen": "<1 oración mencionando el problema principal concreto de ESTE CV>",
  "categorias": [
    {"nombre":"Palabras clave","peso":30,"puntaje":<0-100>,"nota":"<10 palabras max>"},
    {"nombre":"Formato ATS","peso":25,"puntaje":<0-100>,"nota":"<10 palabras max>"},
    {"nombre":"Logros cuantificables","peso":20,"puntaje":<0-100>,"nota":"<10 palabras max>"},
    {"nombre":"Estructura","peso":15,"puntaje":<0-100>,"nota":"<10 palabras max>"},
    {"nombre":"Datos de contacto","peso":10,"puntaje":<0-100>,"nota":"<10 palabras max>"}
  ],
  "errores": [
    {"categoria":"<keywords|formato|estructura|logros|contacto>","descripcion":"<descripción concreta que cite elementos reales del CV>","impacto":"<alto|medio|bajo>"}
  ],
  "keywords_faltantes": ["<keyword real del sector/rol que NO aparece en el CV>"],
  "fortalezas": ["<f1>","<f2>"]
}

Reglas:
- score = suma(puntaje * peso / 100). Mayoría de CVs entre 20-55.
- Max 6 errores. Cada descripción debe ser específica al CV, no genérica.
- keywords_faltantes: entre 4 y 7 términos técnicos ausentes en el CV. No inventes keywords genéricas.
- Respondé en español.`;
}

async function checkIsCV(fileBuffer, mimetype, originalname) {
  const isPdf = mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf');
  try {
    let message;
    if (isPdf) {
      message = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } },
            { type: 'text', text: '¿Es este documento un CV o currículum vitae? Responde únicamente SI o NO.' },
          ],
        }],
      });
    } else {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      const text = (result.value || '').slice(0, 500);
      message = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{
          role: 'user',
          content: `¿Es este documento un CV o currículum vitae? Responde únicamente SI o NO.\n\n${text}`,
        }],
      });
    }
    const answer = message.content[0]?.text?.trim().toUpperCase() ?? '';
    return answer.startsWith('S');
  } catch {
    return true; // on error, allow through
  }
}

function extractJson(raw) {
  // Strip markdown code fences if present
  let text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  // Try direct parse
  try { return JSON.parse(text); } catch {}
  // Try to extract first JSON object from text (handles leading/trailing prose)
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  return null;
}

function mapApiError(err) {
  const status = err.status || err.statusCode;
  const type   = err.error?.type || '';
  if (status === 529 || type === 'overloaded_error') {
    return new Error('Hay muchas solicitudes en este momento. Esperá unos segundos e intentá de nuevo.');
  }
  if (status === 429 || type === 'rate_limit_error') {
    return new Error('Se alcanzó el límite de solicitudes. Intentá en unos minutos.');
  }
  if (status >= 500) {
    return new Error('El servicio de análisis no está disponible. Intentá de nuevo en unos minutos.');
  }
  return err;
}

async function callClaude(params) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    throw mapApiError(err);
  }
}

async function analyzeCV(fileBuffer, mimetype, originalname, puesto = null) {
  const isPdf  = mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf');
  const prompt = buildPrompt(puesto);

  const MAX_TOKENS = 1600;

  async function callOnce() {
    if (isPdf) {
      return callClaude({
        model:       'claude-haiku-4-5-20251001',
        max_tokens:  MAX_TOKENS,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } },
            { type: 'text', text: prompt },
          ],
        }],
      });
    }

    let extractedText;
    try {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      extractedText = result.value;
    } catch (err) {
      throw new Error(`No se pudo extraer texto del archivo: ${err.message}`);
    }
    if (!extractedText || extractedText.trim().length < 50) {
      throw new Error('El archivo parece estar vacío o no contiene texto legible.');
    }
    return callClaude({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  MAX_TOKENS,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `${prompt}\n\n---CV---\n${extractedText.slice(0, 3000)}`,
      }],
    });
  }

  // First attempt
  let message = await callOnce();

  // Detect truncation and log it
  if (message.stop_reason === 'max_tokens') {
    console.warn('[claude] response truncated — retrying with higher token limit');
    if (isPdf) {
      message = await callClaude({
        model:       'claude-haiku-4-5-20251001',
        max_tokens:  2200,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } },
            { type: 'text', text: prompt },
          ],
        }],
      });
    }
  }

  const rawText = message.content[0]?.text ?? '';
  const parsed  = extractJson(rawText);

  if (parsed) return parsed;

  // One retry on parse failure (Claude occasionally adds preamble)
  console.warn('[claude] JSON parse failed — retrying once. Raw:', rawText.slice(0, 200));
  const retry = await callOnce();
  const retryText   = retry.content[0]?.text ?? '';
  const retryParsed = extractJson(retryText);

  if (retryParsed) return retryParsed;

  console.error('[claude] JSON parse failed after retry. Raw:', retryText.slice(0, 400));
  throw new Error('El análisis no pudo completarse. Intentá de nuevo en unos segundos.');
}

const OPTIMIZATION_SYSTEM_PROMPT = require('./optimizationPrompt.js');

async function optimizeCV(cvBuffer, mimetype, originalname, jd, market = null) {
  const isPdf = mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf');
  const jobBlock = `<oferta_laboral>\n${jd}\n</oferta_laboral>\n\n<mercado_objetivo>\n${market || 'No especificado'}\n</mercado_objetivo>`;

  let message;
  if (isPdf) {
    message = await callClaude({
      model:       'claude-sonnet-4-6',
      max_tokens:  8192,
      temperature: 0.1,
      system:      OPTIMIZATION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: cvBuffer.toString('base64') } },
          { type: 'text', text: jobBlock },
        ],
      }],
    });
  } else {
    let cvText;
    try {
      const result = await mammoth.extractRawText({ buffer: cvBuffer });
      cvText = result.value || '';
    } catch (err) {
      throw new Error(`No se pudo extraer texto del CV: ${err.message}`);
    }
    message = await callClaude({
      model:       'claude-sonnet-4-6',
      max_tokens:  8192,
      temperature: 0.1,
      system:      OPTIMIZATION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `<cv_original>\n${cvText}\n</cv_original>\n\n${jobBlock}`,
      }],
    });
  }

  const raw = message.content[0]?.text ?? '';

  // Split on ###INFORME_HTML### delimiter
  const splitIdx = raw.indexOf('###INFORME_HTML###');
  const cvOptimized = splitIdx > 0
    ? raw.slice(0, splitIdx).replace('###CV_HTML###', '').trim()
    : raw.trim();
  const informe = splitIdx > 0
    ? raw.slice(splitIdx + '###INFORME_HTML###'.length).trim()
    : '';

  const usage = {
    input_tokens:  message.usage?.input_tokens  ?? null,
    output_tokens: message.usage?.output_tokens ?? null,
    stop_reason:   message.stop_reason          ?? null,
  };

  return { cv_optimized: cvOptimized, informe, usage };
}

module.exports = { analyzeCV, checkIsCV, optimizeCV };
