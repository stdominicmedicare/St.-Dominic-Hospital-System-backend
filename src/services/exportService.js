/**
 * Excel / PDF export helpers for reports and patient chart packs.
 */
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export async function workbookToBuffer(workbook) {
  return workbook.xlsx.writeBuffer();
}

/**
 * @param {string} sheetName
 * @param {string[]} headers
 * @param {Array<Array<string|number|null|undefined>>} rows
 */
export async function buildExcelBuffer(sheetName, headers, rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'St. Dominic Care';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(sheetName || 'Report');
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) {
    sheet.addRow(row.map((v) => (v == null ? '' : v)));
  }
  headers.forEach((_, i) => {
    sheet.getColumn(i + 1).width = Math.min(40, Math.max(12, String(headers[i]).length + 4));
  });
  return workbookToBuffer(workbook);
}

/**
 * Multi-sheet Excel from { name, headers, rows }[].
 */
export async function buildMultiSheetExcel(sheets) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'St. Dominic Care';
  workbook.created = new Date();
  for (const def of sheets) {
    const sheet = workbook.addWorksheet((def.name || 'Sheet').slice(0, 31));
    sheet.addRow(def.headers || []);
    sheet.getRow(1).font = { bold: true };
    for (const row of def.rows || []) {
      sheet.addRow(row.map((v) => (v == null ? '' : v)));
    }
  }
  return workbookToBuffer(workbook);
}

/**
 * Simple multi-section PDF.
 * @param {string} title
 * @param {Array<{ heading: string, lines?: string[], table?: { headers: string[], rows: string[][] } }>} sections
 */
export function buildPdfBuffer(title, sections = []) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text(title || 'Report', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#666').text(`Generated: ${new Date().toISOString()}`);
    doc.fillColor('#000');
    doc.moveDown();

    for (const section of sections) {
      if (doc.y > 700) doc.addPage();
      doc.fontSize(12).text(section.heading || 'Section', { underline: true });
      doc.moveDown(0.3);

      if (section.lines?.length) {
        doc.fontSize(10);
        for (const line of section.lines) {
          doc.text(String(line ?? ''), { width: 500 });
        }
        doc.moveDown(0.5);
      }

      if (section.table) {
        const { headers = [], rows = [] } = section.table;
        doc.fontSize(9);
        if (headers.length) {
          doc.font('Helvetica-Bold').text(headers.join(' | '), { width: 500 });
          doc.font('Helvetica');
        }
        if (!rows.length) {
          doc.text('(No rows)');
        } else {
          for (const row of rows) {
            if (doc.y > 740) doc.addPage();
            doc.text(row.map((c) => String(c ?? '')).join(' | '), { width: 500 });
          }
        }
        doc.moveDown(0.8);
      }
    }

    doc.end();
  });
}

export function sendBinary(res, buffer, { filename, contentType }) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(Buffer.from(buffer));
}
