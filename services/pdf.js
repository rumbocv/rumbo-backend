const chromium  = require('@sparticuz/chromium');
const playwright = require('playwright-core');

// Print-optimized CSS injected into every HTML before rendering
const PRINT_CSS = `
<style>
  @page {
    margin: 0;
  }
  *, *::before, *::after {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    box-sizing: border-box;
  }
  /* Prevent content from being cut mid-element */
  p, li, td, th, blockquote, pre, img, figure {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  /* Keep headings with their following content */
  h1, h2, h3, h4, h5, h6 {
    break-after: avoid;
    page-break-after: avoid;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  /* Tailwind flex/grid containers shouldn't split */
  [class*="flex"], [class*="grid"], section, article, header, footer {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  img {
    max-width: 100%;
    display: block;
  }
  /* Remove browser default link underlines in print */
  a { text-decoration: none; color: inherit; }
</style>
`;

async function generatePdfFromHtml(html) {
  // Inject print CSS just before </head>
  const fullHtml = html.includes('</head>')
    ? html.replace('</head>', PRINT_CSS + '\n</head>')
    : PRINT_CSS + html;

  const browser = await playwright.chromium.launch({
    args:             chromium.args,
    defaultViewport:  chromium.defaultViewport,
    executablePath:   await chromium.executablePath(),
    headless:         true,
  });

  try {
    const page = await browser.newPage();

    // A4 width at 96dpi = 794px; height starts tall to let content flow naturally
    await page.setViewportSize({ width: 794, height: 1200 });

    // Load content — networkidle ensures Google Fonts / Tailwind CDN finish
    await page.setContent(fullHtml, { waitUntil: 'networkidle' });

    // Switch to print media so @media print rules apply
    await page.emulateMedia({ media: 'print' });

    // Measure real content height AFTER all assets load
    const contentHeight = await page.evaluate(
      () => document.documentElement.scrollHeight
    );

    // Generate a single-page PDF sized exactly to the content —
    // no page breaks, no cuts, perfect for CVs sent digitally
    const pdf = await page.pdf({
      width:           '794px',
      height:          `${contentHeight}px`,
      printBackground:  true,
      preferCSSPageSize: false,   // we control the size, not @page
      margin:           { top: 0, right: 0, bottom: 0, left: 0 },
    });

    return pdf;
  } finally {
    await browser.close();
  }
}

module.exports = { generatePdfFromHtml };
