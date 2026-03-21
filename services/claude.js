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

async function analyzeCV(fileBuffer, mimetype, originalname, puesto = null) {
  const isPdf = mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf');
  const prompt = buildPrompt(puesto);

  let message;

  if (isPdf) {
    message = await client.messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  1200,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBuffer.toString('base64') } },
          { type: 'text', text: prompt },
        ],
      }],
    });
  } else {
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

    message = await client.messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  1200,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `${prompt}\n\n---CV---\n${extractedText.slice(0, 3000)}`,
      }],
    });
  }

  const rawText = message.content[0]?.text ?? '';
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('Claude devolvió una respuesta inválida. Intentá de nuevo.');
  }
}

module.exports = { analyzeCV, checkIsCV };
