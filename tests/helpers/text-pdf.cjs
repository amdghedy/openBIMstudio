// Builds a small text PDF in memory (Helvetica, one string array per page,
// one line per entry). Used by the family creator tests; no binary fixture
// is stored in the repo.
module.exports = function buildTextPdf(pages) {
  const objs = [];
  const n = pages.length;
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  const fontObj = 3 + n * 2;
  pages.forEach((lines, i) => {
    const content = "BT /F1 12 Tf 14 TL 72 700 Td " +
      lines.map((l) => `(${String(l).replace(/([()\\])/g, "\\$1")}) Tj T*`).join(" ") + " ET";
    objs[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`;
    objs[4 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objs[fontObj] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};
