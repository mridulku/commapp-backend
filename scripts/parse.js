const fs = require('fs');
const pdf = require('pdf-parse');

(async () => {
  try {
    // 1. Read PDF (defaults to "myFile.pdf" if no argument passed)
    const pdfPath = process.argv[2] || 'myFile.pdf';
    const dataBuffer = fs.readFileSync(pdfPath);

    // 2. Extract text using pdf-parse
    const pdfData = await pdf(dataBuffer);
    const fullText = pdfData.text;

    // 3. Split the entire text into lines
    const lines = fullText.split(/\r?\n/);

    // 4. Convert lines to paragraphs
    //    - If we encounter a blank line, we treat that as the end of a paragraph.
    //    - Otherwise, we keep appending lines until we reach a blank line.
    const paragraphs = [];
    let currentParaLines = [];

    lines.forEach(line => {
      const trimmed = line.trim();

      if (!trimmed) {
        // Blank line => end of paragraph
        if (currentParaLines.length > 0) {
          paragraphs.push(currentParaLines.join(' '));
          currentParaLines = [];
        }
      } else {
        // Non-blank line => keep accumulating
        currentParaLines.push(trimmed);
      }
    });

    // If there's leftover text in currentParaLines, push it as the final paragraph
    if (currentParaLines.length > 0) {
      paragraphs.push(currentParaLines.join(' '));
    }

    // 5. Convert paragraphs to CSV
    //    Format: ParagraphNumber,Text
    let csvContent = 'ParagraphNumber,Text\n';
    paragraphs.forEach((para, index) => {
      // Escape any quotes
      const sanitized = para.replace(/"/g, '""');
      csvContent += `${index + 1},"${sanitized}"\n`;
    });

    // 6. Save CSV to file
    fs.writeFileSync('extracted_paragraphs.csv', csvContent, 'utf-8');

    console.log('Extraction complete! See "extracted_paragraphs.csv" for the output.');
  } catch (err) {
    console.error('Error extracting paragraphs:', err);
  }
})();