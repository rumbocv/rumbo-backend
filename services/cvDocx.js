const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, convertInchesToTwip } = require('docx');

// Section headers that get heading style
const SECTION_HEADERS = [
  'datos de contacto', 'resumen profesional', 'experiencia laboral',
  'educación', 'educacion', 'certificaciones', 'habilidades',
  'idiomas', 'información adicional', 'informacion adicional',
];

function isHeader(line) {
  return SECTION_HEADERS.some(h => line.toLowerCase().trim() === h);
}

function buildParagraphs(text) {
  const lines = text.split('\n');
  const paragraphs = [];

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (isHeader(line)) {
      paragraphs.push(new Paragraph({
        text: line.toUpperCase(),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: convertInchesToTwip(0.15), after: convertInchesToTwip(0.04) },
        border: { bottom: { color: 'CCCCCC', size: 6, space: 4, style: 'single' } },
      }));
      continue;
    }

    if (line.trim() === '') {
      paragraphs.push(new Paragraph({ spacing: { after: convertInchesToTwip(0.05) } }));
      continue;
    }

    // Detect bullet points
    const bulletMatch = line.match(/^(\s*[-•·]\s*)(.+)/);
    if (bulletMatch) {
      paragraphs.push(new Paragraph({
        bullet: { level: 0 },
        children: [new TextRun({ text: bulletMatch[2].trim(), size: 22 })],
        spacing: { after: 40 },
      }));
      continue;
    }

    // Detect bold-like patterns: lines that are all caps or end with : (role/company lines)
    const isRoleLine = /^[A-ZÁÉÍÓÚÑÜ\s,.|–-]+$/.test(line.trim()) && line.trim().length > 3 && line.trim().length < 80;

    paragraphs.push(new Paragraph({
      children: [new TextRun({
        text: line,
        size: 22,
        bold: isRoleLine,
      })],
      spacing: { after: 40 },
    }));
  }

  return paragraphs;
}

async function generateCvDocx(cvText) {
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 },
        },
      },
      paragraphStyles: [
        {
          id: 'Heading2',
          name: 'Heading 2',
          run: { font: 'Calibri', size: 24, bold: true, color: '1F2937' },
          paragraph: { spacing: { before: 200, after: 80 } },
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(0.9),
            right: convertInchesToTwip(0.9),
            bottom: convertInchesToTwip(0.9),
            left: convertInchesToTwip(0.9),
          },
        },
      },
      children: buildParagraphs(cvText),
    }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { generateCvDocx };
