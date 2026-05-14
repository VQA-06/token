import { createWorker } from 'tesseract.js';
import { parseWithGemini, parseWithGeminiVision } from './gemini.js';

// PDF.js is loaded via CDN in index.html to avoid bundling issues
// The library exposes 'pdfjsLib' to window
const pdfjsLib = window.pdfjsLib;

if (pdfjsLib) {
  // Use a compatible worker version from CDN
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
}

/**
 * Perform OCR on an image and extract PLN receipt data
 * @param {string|Blob|File} imageSource 
 * @param {string} mode - 'token', 'tagihan-pln', or 'payment'
 * @param {boolean} useAI - Whether to use Gemini AI for parsing (disabled for PDFs)
 */
export async function processReceipt(imageSource, mode = 'token', useAI = true) {
  try {
    // 1. Direct Vision Parsing (High Accuracy) - ONLY FOR IMAGES
    if (useAI) {
        console.log('Using Gemini Vision for high-accuracy parsing...');
        const visionResult = await parseWithGeminiVision(imageSource);
        
        if (visionResult && (visionResult.token || visionResult.tagihan || visionResult.idpel)) {
            console.log('Gemini Vision Success:', visionResult);
            return visionResult;
        }
    }

    // 2. Fallback to Tesseract + Gemini Text if Vision fails or AI is disabled
    console.log(`Using Tesseract OCR (${useAI ? 'AI Fallback' : 'Standard Mode'})...`);
    const worker = await createWorker('ind');
    const { data: { text } } = await worker.recognize(imageSource);
    await worker.terminate();
    
    console.log('Raw OCR Text:', text);
    
    // AI Text Fallback (only if AI is permitted)
    if (useAI) {
        const aiResult = await parseWithGemini(text);
        if (aiResult) {
            aiResult.raw = text;
            return aiResult;
        }
    }

    // Standard Regex Parsers (Always used as final fallback or when AI is disabled)
    if (mode === 'payment') {
        return parsePaymentText(text);
    } else {
        return parsePLNText(text);
    }
    
  } catch (error) {
    console.error('Extraction Error:', error);
    throw error;
  }
}

/**
 * Parse raw text into structured PLN object
 * @param {string} text 
 */
function parsePLNText(text) {
  const result = {
    token: '',
    idpel: '',
    nama: '',
    tarif: '',
    kwh: '',
    nominal: '',
    tagihan: '',
    admin: '',
    total: '',
    ppn: '0',
    angsmat: '0,00/0,00',
    noPesanan: '', 
    stand: '',
    denda: '0',
    raw: text
  };

  // 0. Extract No Pesanan (Order Number)
  const noPesananMatch = text.match(/(?:No\.?\s*Pesanan|Nomor\s*Pesanan|Order\s*No)\s*[:]?\s*([A-Z0-9]+)/i);
  if (noPesananMatch) {
    result.noPesanan = noPesananMatch[1].trim();
  }

  // 1. Extract Token (20 digits)
  // Improved: Support direct text with label boundaries and messy OCR spaces
  const tokenMatch = text.match(/Stroom\/Nomor Token\s*([\d\s]{20,25})(?=\s*(?:Nomor Meter|Nomor Pelanggan|Nama|$))/i) ||
                     text.match(/Stroom\/Nomor Token\s*(\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4})/i) ||
                     text.match(/TOKEN\s*[:]\s*(\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4})/i) ||
                     text.match(/(\d{4}\s\d{4}\s\d{4}\s\d{4}\s\d{4})/);
  if (tokenMatch) {
    result.token = tokenMatch[1] ? tokenMatch[1].replace(/[^0-9]/g, '') : tokenMatch[0].replace(/[^0-9]/g, '');
  }

  // 2. Extract IDPEL / Nomor Pelanggan
  const idpelMatch = text.match(/Nomor Pelanggan\s*(\d{11,12})/i) ||
                     text.match(/IDPEL\s*[:]\s*(\d{11,12})/i) ||
                     text.match(/ID\s*PEL\s*[:]\s*(\d{11,12})/i);
  if (idpelMatch) {
    result.idpel = idpelMatch[1];
  }

  // 3. Extract Nama
  // Robust Strategy: Capture EVERYTHING until the next known label
  const namaLabelPattern = /Nama\s*[:]?\s*([\s\S]+?)(?=\s*(?:Tarif\/Daya|Tarif Daya|IDPEL|Nomor|Stroom|Total|No\.\s*Pesanan|No\.\s*Meter|Bulan|Periode|$))/i;
  const namaMatch = text.match(namaLabelPattern);
  if (namaMatch) {
    result.nama = namaMatch[1].trim();
  }

  // 4. Extract Tarif/Daya
  // Robust Strategy: Capture widely, then sanitize.
  
  // Try to find specific pattern R../... VA first (most reliable)
  // Updated to support decimals like 900.00
  let tarifMatch = text.match(/(R[\d\w]+\s*\/[\s\d.]+\s*VA)/i);
  
  if (!tarifMatch) {
    // Fallback: Look for label. 
    // Use word boundaries \b to avoid matching "HIDAYAT" as "DAYA"
    tarifMatch = text.match(/\b(?:Tarif\/Daya|Tarif Daya|Tarif|Daya)\s*[:]?\s*([A-Z0-9\/\s.-]+)/i);
  }

  if (tarifMatch) {
    let raw = tarifMatch[1] ? tarifMatch[1] : tarifMatch[0];
    // Sanitize: 
    // 1. Normalize spaces
    let clean = raw.replace(/\s+/g, ' ').trim();
    
    // 2. Remove redundant labels if they got caught (e.g. "Tarif Daya R1M")
    clean = clean.replace(/^(Tarif\/Daya|Tarif Daya|Tarif|Daya)\s*/i, '');

    // 3. Stop at common garbage words
    clean = clean.replace(/\s(No|Ref|Nomor|Jam).*$/i, '');
    
    // Final Polish: Ensure VA suffix exists if it looks like a power value
    if (clean && !clean.toUpperCase().includes('VA') && /[\d]/.test(clean)) {
        clean += ' VA';
    }
    
    result.tarif = clean.trim();
  }
  // 5. Extract KWh
  const kwhMatch = text.match(/(?:Jumlah|Jml|Total)\s*(?:K\s*W\s*H|KWH|KwH)\s*[:.]?\s*([\d,.]+)/i) || 
                   text.match(/([\d,.]+)\s*(?:k\s*w\s*h|kwh)/i);

  if (kwhMatch) {
    let val = kwhMatch[1].trim().replace(/[^0-9]/g, ''); // Extract only digits
    
    if (val.length === 2) {
        // Rule: 46 -> 46,0
        result.kwh = val + ',0';
    } else if (val.length >= 3) {
        // Rule: 3530 -> 35,3 (divide by 100 concept)
        const num = parseInt(val);
        const scaled = (num / 100).toFixed(1).replace('.', ',');
        result.kwh = scaled;
    } else {
        result.kwh = val;
    }
  }

  // 5.5 Extract Periode (for Postpaid)
  // Look for specific patterns like "BULAN/TAHUN" or months
  const periodeLabelMatch = text.match(/(?:Bulan|Periode)(?:\s*tagihan)?\s*[:]?\s*(\d{2}[/-]\d{4})/i) ||
                            text.match(/(?:Bulan|Periode)(?:\s*tagihan)?\s*[:]?\s*([A-Za-z]+\s*20\d{2})/i) ||
                            text.match(/(?:Bulan|Periode)(?:\s*tagihan)?\s*[:]?\s*(\d{4}[/-]\d{2})/i);
  if (periodeLabelMatch) {
    result.periode = periodeLabelMatch[1].trim();
  }

  // 6. Extract Nominal (Rp Stroom/Token)
  // Relaxed: Look for main nominal amount which is usually the largest Rp value aside from the total, 
  // or specifically labeled Rp Stroom
  const nominalMatch = text.match(/(?:Rp Stroom\/Token|Stroom\/Token|Nilai Token)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i) ||
                       text.match(/NOMINAL\s*[:]\s*Rp?[\s.]*([\d,.]+)/i);
  
  if (nominalMatch) {
    let rawNominal = nominalMatch[1].trim().replace(/\./g, '').replace(/,/g, '');
    result.nominal = snapToNearestPLN(rawNominal);
  } else {
    // Fallback: Smart Guess - Look for 20k, 50k, 100k patterns in text if label is missing
    // We look for isolated numbers that match known denominations
    const rawDigits = text.replace(/[^0-9\s]/g, ' ');
    const possible = rawDigits.match(/\b(20000|50000|100000|200000|500000|1000000)\b/);
    if (possible) {
        result.nominal = possible[1];
    }
  }

  // 7. Extract Admin (Biaya Admin)
  const adminMatch = text.match(/Biaya Admin\s*Rp?([\d,.]+)/i) ||
                     text.match(/ADMIN\s*[:]\s*Rp?([\d,.]+)/i);
  if (adminMatch) {
    result.admin = adminMatch[1].trim().replace(/\./g, '').replace(/,/g, '');
  }

  // 8. Extract Total Tagihan & Total Bayar
  // Robust Strategy: Capture everything after label until next newline or label
  const tagihanLabelPattern = /(?:Total\s*Tagihan|Tagihan)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i;
  const tagihanMatch = text.match(tagihanLabelPattern);
  if (tagihanMatch) {
    result.tagihan = tagihanMatch[1].trim().replace(/\./g, '').replace(/,/g, '');
  }

  const totalLabelPattern = /(?:Total\s*Bayar|Jumlah\s*Bayar|TOTAL)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i;
  const totalMatch = text.match(totalLabelPattern);
  if (totalMatch) {
    result.total = totalMatch[1].trim().replace(/\./g, '').replace(/,/g, '');
  }

  // 8.5 Extract Stand Meter
  // Prune output before common next labels
  const standMatch = text.match(/Stand Meter\s*[:]?\s*([A-Z0-9-/ ]+?)(?=\s*(?:Periode|No|Total|Rp|$))/i);
  if (standMatch) {
    result.stand = standMatch[1].trim();
  }

  // 8.6 Extract Denda
  const dendaMatch = text.match(/Denda\s*Rp?[\s.]*([\d,.]+)/i);
  if (dendaMatch) {
    result.denda = dendaMatch[1].trim().replace(/\./g, '').replace(/,/g, '');
  }

  // 9. Extract PPN
  const ppnMatch = text.match(/PPn\s*Rp?([\d,.]+)/i);
  if (ppnMatch) {
    result.ppn = ppnMatch[1].trim().replace(/ /g, '');
  }

  // Final sanitization for all results
  Object.keys(result).forEach(key => {
    if (typeof result[key] === 'string' && key !== 'raw') {
        result[key] = cleanValue(result[key]);
    }
  });

  return result;
}

/**
 * Global Sanitizer: Removes common labels that often get caught in OCR
 * @param {string} val 
 */
function cleanValue(val) {
  if (!val) return '';
  let clean = val.replace(/\s+/g, ' ').trim();
  
  // List of labels to strip from the START of results
  const labelsToRemove = [
    /^T\s/i, // Prefix "T " like in user's error
    /^(Nama|Tarif\/Daya|Tarif Daya|Tarif|Daya|IDPEL|Nomor Pelanggan|Nomor Meter|No\.\s*Ref|No|Ref|Stroom|Token)\s*[:.-]?\s*/i,
    /^(Rp|RP)\.?\s*/i
  ];

  labelsToRemove.forEach(pattern => {
    clean = clean.replace(pattern, '');
  });

  return clean.trim();
}

/**
 * Parse raw text into structured Payment (PDAM) object
 * @param {string} text 
 */
function parsePaymentText(text) {
  const result = {
    mode: 'payment',
    lokasi: '',
    nama: '',
    idpel: '',
    periode: '',
    stand: '', // optional
    tagihan: '',
    admin: '',
    total: '',
    noPesanan: '', 
    raw: text
  };

  // 1. Extract Lokasi
  // Looks for common patterns like "PDAM ...", "KAB ...", "KOTA ..."
  // or takes the first meaningful line if it looks like a header
  // User Feedback: "KAB. SOLOK No" -> Remove " No"
  const lokasiMatch = text.match(/(?:PDAM|PERUMDA|TIRTA)\s+([A-Z\s.]+)/i) || 
                      text.match(/(?:KAB\.|KOTA)\s+([A-Z\s.]+)/i);
  
  if (lokasiMatch) {
     let val = lokasiMatch[0].trim();
     // Clean suffix " No", " Nomor", etc if captured accidentally
     result.lokasi = val.replace(/\s(No|Nomor|Pelanggan).*$/i, '').trim();
  } else {
     // Fallback: Take first non-empty line that isn't a date
     const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
     if (lines.length > 0 && !lines[0].match(/\d{4}-\d{2}-\d{2}/)) {
        result.lokasi = lines[0].replace(/\s(No|Nomor|Pelanggan).*$/i, '').trim();
     }
  }

  // 2. Extract Nama
  // Robust Strategy: Capture EVERYTHING until the next known label
  const namaLabelPattern = /(?:\bNama Pelanggan|\bNama|\bNAMA\b)\s*[:]?\s*([\s\S]+?)(?=\s*(?:NO\.PEL|NO\. PEL|ID PEL|IDPEL|NO SAMB|NO\.SAMB|PERIODE|ALAMAT|TOTAL|TAGIHAN|Tarif\/Daya|Tarif Daya|$))/i;
  const namaMatch = text.match(namaLabelPattern);
  if (namaMatch) {
    result.nama = namaMatch[1].trim();
  }

  // 3. Extract IDPEL / No Sambungan
  const idpelMatch = text.match(/(?:Nomor|No\.|ID)\s*(?:Pelanggan|Sambungan|PEL|SAMB)\s*[:.]?\s*(\d+)/i) ||
                     text.match(/(\d{6,12})/); // Raw digits fallback
  if (idpelMatch) {
    result.idpel = idpelMatch[1].trim();
  }

  // 4. Extract Periode
  // Strategy: 
  // A. Look for specific labels first
  // B. Search for known date formats (Month Year)
  
  // 4. Extract Periode
  
  // A. Label Search
  // User Feedback: "Periode Tagihan" is a specific section.
  // We must match "Periode Tagihan" explicitly so "Tagihan" isn't treated as part of the value (and subsequently deleted by cleanup).
  const periodeLabelMatch = text.match(/(?:Periode Tagihan|Periode|Bulan|Thn\.Bln|Rekoning Bulan|Rek\.Bulan)\s*[:]?\s*([^\n\r]+)/i);
  if (periodeLabelMatch) {
    let raw = periodeLabelMatch[1].trim();
    
    // Clean potential trailing garbage labels, BUT be careful not to delete the value itself if it starts with 'Tagihan' (unlikely if label fixed)
    // We only remove if it looks like a separate label starting with "Tagihan:" or "Tagihan Rp" or similar noise at the END
    // Original aggressive replace was: raw = raw.replace(/\s*(?:Tagihan|Meter|Lalu|Kini|Stanst|Stand).*$/i, '');
    // New safer replace searches for known Next-Field labels
    raw = raw.replace(/\s+(?:Meter|Lalu|Kini|Stanst|Stand|Total).*$/i, '');
    
    // Also remove "Tagihan" if it appears as a suffix label match, e.g. "202512 Tagihan..."
    raw = raw.replace(/\s+Tagihan.*$/i, '');

    if ((/\d{4}/.test(raw) || /[A-Za-z]{3}/.test(raw)) && raw.length < 20) {
        result.periode = raw;
    }
  }

  // A.5 Global Search REMOVED as per user request ("tidak perlu mencari YYYYMM pada keseluruhan")

  // B. Fallback: Robust Date Pattern Search (Indonesian Months)
  // If no result yet, look for "JAN 2025", "MEI 25"
  if (!result.periode) {
     const indoMonths = 'JAN|FEB|MAR|APR|MEI|JUN|JUL|AGU|SEP|OKT|NOV|DES|JANUARI|FEBRUARI|MARET|APRIL|MEI|JUNI|JULI|AGUSTUS|SEPTEMBER|OKTOBER|NOVEMBER|DESEMBER';
     const datePattern = new RegExp(`\\b(${indoMonths})[\\s-]*(\\d{2,4})`, 'i');
     const dateMatch = text.match(datePattern);
     if (dateMatch) {
         result.periode = `${dateMatch[1]} ${dateMatch[2]}`.toUpperCase();
     }
  }
  
  // C. Fallback: Numeric patterns MM/YYYY
  if (!result.periode) {
     const mmyyyyMatch = text.match(/\b(0[1-9]|1[0-2])[\/-](20\d{2})\b/);
     if (mmyyyyMatch) {
         result.periode = formatIndoMonth(mmyyyyMatch[1]) + ' ' + mmyyyyMatch[2];
     }
  }

  // --- POST-PROCESSING PERIODE ---
  // Ensure we format "202512" -> "DESEMBER 2025" regardless of how it was captured (Label or Fallback)
  if (result.periode) {
      // Clean up common noise
      let clean = result.periode.replace(/\s*(?:Tagihan|Meter|Lalu|Kini|Stanst|Stand).*$/i, '').trim();
      
      // Check if it matches YYYYMM (ex: 202512)
      // Allow minor noise or spaces: 2025 12
      const yyyymmFormat = clean.match(/\b(20\d{2})\s?(0[1-9]|1[0-2])\b/); 
      if (yyyymmFormat) {
          const year = yyyymmFormat[1];
          const month = yyyymmFormat[2];
          clean = formatIndoMonth(month) + ' ' + year;
      }

      result.periode = clean.toUpperCase();
  }

  // 5. Extract Total Tagihan (before admin)
  // Usually labeled "Tagihan", "Jumlah Tagihan", "Total Air"

  // 5. Extract Total Tagihan (before admin)
  const tagihanMatch = text.match(/(?:Tagihan|Jml Tagihan|Total Air|Biaya Air|Total Tagihan)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i);
  if (tagihanMatch) {
    let raw = tagihanMatch[1].trim().replace(/\./g, '').replace(/,/g, '');
    result.tagihan = raw;
  }

  // 6. Extract Admin (if present on receipt)
  const adminMatch = text.match(/(?:Biaya Admin|Admin|Adm)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i);
  if (adminMatch) {
     let raw = adminMatch[1].trim().replace(/\./g, '').replace(/,/g, '');
     result.admin = raw;
  }

  // 7. Extract Total Bayar
  const totalMatch = text.match(/(?:Total Bayar|Total)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i);
  if (totalMatch) {
    let raw = totalMatch[1].trim().replace(/\./g, '').replace(/,/g, '');
    result.total = raw;
  }
  
  // If we found tagihan but no total, default total = tagihan
  if (!result.total && result.tagihan) result.total = result.tagihan;
  // If we found total but no tagihan, default tagihan = total
  if (!result.tagihan && result.total) result.tagihan = result.total;

  // 8. Extract No Pesanan
  // Pattern: "No. Pesanan : 12345..." or "No Pesanan 12345..."
  const noPesananMatch = text.match(/(?:No\.?|Nomor)\s*Pesanan\s*[:]?\s*([A-Z0-9]+)/i);
  if (noPesananMatch) {
    result.noPesanan = noPesananMatch[1].trim();
  }

  // Final sanitization for all results
  Object.keys(result).forEach(key => {
    if (typeof result[key] === 'string' && key !== 'raw' && key !== 'mode' && key !== 'nama') {
        result[key] = cleanValue(result[key]);
    }
  });

  return result;
}

// Helper to extract text from PDF items
async function extractPdfText(page) {
  try {
    const textContent = await page.getTextContent();
    const strings = textContent.items.map(item => item.str);
    // Join with space, but preserve some formatting hints if possible
    return strings.join(' ').replace(/\s+/g, ' ');
  } catch (err) {
    console.error('Text extraction failed:', err);
    return null;
  }
}

/**
 * Helper: Extract text from PDF preserving line breaks (for table-style PDFs)
 */
async function extractPdfTextWithLines(page) {
  try {
    const textContent = await page.getTextContent();
    // Group items by their Y position to reconstruct rows/lines
    const lineMap = {};
    for (const item of textContent.items) {
      const y = Math.round(item.transform[5]); // Y coordinate
      if (!lineMap[y]) lineMap[y] = [];
      lineMap[y].push(item.str);
    }
    // Sort lines from top to bottom (descending Y in PDF coords)
    const sortedY = Object.keys(lineMap).map(Number).sort((a, b) => b - a);
    return sortedY.map(y => lineMap[y].join(' ')).join('\n');
  } catch (err) {
    console.error('Line text extraction failed:', err);
    return null;
  }
}

/**
 * Parser for the NEW web-receipt PDF format (e.g. Sa Cell / Tokopedia PLN).
 * Fields: PLN Meter No, Nama Pemilik, Tarif/Daya, Jumlah KWH, PLN Token, Tagihan
 * PPN and ANGS/MAT default to empty/zero if not present.
 * @param {string} text - Raw joined text from PDF
 * @returns {object|null} parsed data, or null if format not recognised
 */
function parseNewFormatPdf(text) {
  // Detect this format by checking for its distinctive field labels
  const isNewFormat =
    /PLN\s*Meter\s*No/i.test(text) ||
    /Nama\s*Pemilik/i.test(text) ||
    /PLN\s*Token/i.test(text);

  if (!isNewFormat) return null;

  console.log('[NewFormat] Detected new PDF format, parsing...');

  const result = {
    token: '',
    idpel: '',
    nama: '',
    tarif: '',
    kwh: '',
    nominal: '',
    tagihan: '',
    admin: '',
    total: '',
    ppn: '',        // empty by default
    angsmat: '',    // empty by default
    noPesanan: '',
    stand: '',
    denda: '',
    raw: text
  };

  // Helper: extract value that follows a label in the format "Label ... Value"
  // Works for both inline (label: value) and table-row (label ... value on same line)
  const extract = (patterns) => {
    for (const pattern of patterns) {
      const m = text.match(pattern);
      if (m && m[1] && m[1].trim()) return m[1].trim();
    }
    return '';
  };

  // 1. ID Pelanggan (PLN Meter No)
  result.idpel = extract([
    /PLN\s*Meter\s*No\s+(\d{6,15})/i,
    /PLN\s*Meter\s*No[\s:]+([\d]+)/i,
  ]);

  // 2. Nama Pemilik → Nama
  result.nama = extract([
    /Nama\s*Pemilik\s+([A-Z][A-Z\s]+?)(?=\s+(?:Tarif|Jumlah|PLN|Tagihan|Biaya|Total|Nama\s*Pengguna|No\s*Telp|Email|$))/i,
    /Nama\s*Pemilik[\s:]+([^\n]+)/i,
  ]);

  // 3. Tarif / Daya
  result.tarif = extract([
    /Tarif\s*\/\s*Daya\s+([A-Z0-9]+\s*\/\s*[\d.,]+)/i,
    /Tarif\s*\/\s*Daya[\s:]+([^\n]+)/i,
  ]);
  // Remove trailing noise from tarif
  if (result.tarif) {
    result.tarif = result.tarif.replace(/\s+(Jumlah|PLN|Tagihan|Biaya|Total|Nama|No\s*Telp|Email).*$/i, '').trim();
  }

  // 4. Jumlah KWH → KWh (keep as-is, simple numeric)
  const kwhRaw = extract([
    /Jumlah\s*KWH\s+([\d.,]+)/i,
    /Jumlah\s*KWH[\s:]+([\d.,]+)/i,
  ]);
  if (kwhRaw) {
    // In this format, dot is the DECIMAL separator (e.g. "70.50"), NOT thousands separator.
    // Parse directly without stripping dots.
    const numKwh = parseFloat(kwhRaw.replace(',', '.'));
    result.kwh = isNaN(numKwh) ? kwhRaw : numKwh.toFixed(2).replace('.', ',');
  }

  // 5. PLN Token → Nomor Token (format: XXXX-XXXX-XXXX-XXXX-XXXX or 20 digits)
  const tokenRaw = extract([
    /PLN\s*Token\s+([\d][\d\s-]{15,25}[\d])/i,
    /PLN\s*Token[\s:]+([\d\s-]+)/i,
  ]);
  if (tokenRaw) {
    // Strip all non-digits
    result.token = tokenRaw.replace(/[^0-9]/g, '');
  }

  // 6. Tagihan → Nominal (in this format "Tagihan" in Rincian Pembayaran = the token value)
  // The value is usually "Rp 100.000" or "Rp100.000"
  const tagihanRaw = extract([
    /Tagihan\s+Rp\s*([\d.,]+)/i,
    /Tagihan[\s:]+Rp\s*([\d.,]+)/i,
    /Tagihan\s+([\d.,]+)/i,
  ]);
  if (tagihanRaw) {
    // Remove dots (thousands separator), keep the number
    const cleaned = tagihanRaw.replace(/\./g, '').replace(',', '');
    result.nominal = cleaned;
    result.tagihan = cleaned;
  }

  // Also try "Produk" line for denomination hint (e.g. "PLN 100.000")
  if (!result.nominal) {
    const produkMatch = text.match(/Produk\s+PLN\s+([\d.,]+)/i);
    if (produkMatch) {
      result.nominal = produkMatch[1].replace(/\./g, '').replace(',', '');
    }
  }

  // 7. PPN – optional, leave empty if not found
  const ppnRaw = extract([
    /PPN\s+Rp\s*([\d.,]+)/i,
    /PPN[\s:]+Rp\s*([\d.,]+)/i,
    /PPn\s+Rp\s*([\d.,]+)/i,
  ]);
  // Default: '0' → formatRpDecimal() will render as "Rp0,00"
  result.ppn = ppnRaw ? ppnRaw.replace(/\./g, '').replace(',', '.') : '0';

  // 8. ANGS/MAT – optional, default "0,00/0,00" if not found
  const angsmatRaw = extract([
    /ANGS\s*\/\s*MAT\s+([\d.,\/]+)/i,
    /Angsuran[\s:]+([\d.,\/]+)/i,
  ]);
  // Default: '0,00/0,00' → displayed as "Rp0,00/0,00"
  result.angsmat = angsmatRaw || '0,00/0,00';

  // 9. No Pesanan / Kode Transaksi
  result.noPesanan = extract([
    /Kode\s*Transaksi\s+([A-Z0-9-]+)/i,
    /No\.?\s*Pesanan[\s:]+([A-Z0-9]+)/i,
  ]);

  console.log('[NewFormat] Parsed result:', result);
  return result;
}

/**
 * Process PDF file and return extracted data
 */
export async function processPdf(pdfDataUrl, mode = 'token') {
  if (!pdfjsLib) {
    throw new Error('PDF library belum dimuat. Silakan muat ulang halaman.');
  }
  const loadingTask = pdfjsLib.getDocument(pdfDataUrl);
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  
  // 1. Try Direct Text Extraction (Digital PDF) - HIGH ACCURACY
  console.log('Mencoba ekstraksi teks langsung dari PDF mode:', mode);
  const directText = await extractPdfText(page);

  if (directText && directText.length > 20) {
    // 1a. Try NEW format parser FIRST (web receipt: PLN Meter No, Nama Pemilik, PLN Token, etc.)
    const newFormatData = parseNewFormatPdf(directText);
    if (newFormatData) {
      const hasToken = newFormatData.token && newFormatData.token.length >= 20;
      const hasIdpel = newFormatData.idpel && newFormatData.idpel.length >= 6;
      if (hasToken || hasIdpel) {
        console.log('[NewFormat] Extraction success:', newFormatData);
        return newFormatData;
      }
      // If only partial data found but we have token or idpel, still try line-based
    }

    // 1b. Also try with line-preserved text for new format (table PDFs)
    const lineText = await extractPdfTextWithLines(page);
    if (lineText) {
      const newFormatDataLines = parseNewFormatPdf(lineText);
      if (newFormatDataLines) {
        const hasToken = newFormatDataLines.token && newFormatDataLines.token.length >= 20;
        const hasIdpel = newFormatDataLines.idpel && newFormatDataLines.idpel.length >= 6;
        if (hasToken || hasIdpel) {
          console.log('[NewFormat] Line-based extraction success:', newFormatDataLines);
          return newFormatDataLines;
        }
      }
    }

    // 1c. Legacy format parsers
    console.log('Digital PDF detected. Parsing direct text (legacy)...');
    const data = (mode === 'payment') ? parsePaymentText(directText) : parsePLNText(directText);
    
    // Validate if mandatory fields found
    const hasToken = data.token && data.token.length >= 20;
    const hasIdpel = data.idpel && data.idpel.length >= 11;
    const hasTagihan = data.tagihan || data.total;
    
    if ((mode === 'token' && hasToken) || 
        (mode === 'tagihan-pln' && hasIdpel) || 
        (mode === 'payment' && (hasIdpel || hasTagihan))) {
      console.log('Direct extraction success (legacy):', data);
      return data;
    }
    console.log('Data penting tidak ditemukan di teks digital, lanjut ke mode visual...');
  }
  
  // 2. Fallback: Render to canvas for Vision/OCR
  const viewport = page.getViewport({ scale: 3.0 });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({ canvasContext: context, viewport: viewport }).promise;
  
  const imageData = canvas.toDataURL('image/png');
  // PDFs should NEVER use AI, even when rendered to images
  return await processReceipt(imageData, mode, false);
}

/**
 * Snaps a value to the nearest common PLN denomination if within threshold
 */
function snapToNearestPLN(value) {
  const num = parseInt(value);
  if (isNaN(num)) return value;

  const denominations = [20000, 50000, 100000, 200000, 500000, 1000000];
  const threshold = 0.15; // 15% margin for OCR errors (e.g. 42k -> 50k, 18k -> 20k)
  
  for (const den of denominations) {
    const diff = Math.abs(num - den);
    if (diff / den <= threshold) {
      return den.toString();
    }
  }
  
  return value;
}

/**
 * Preprocess image to improve OCR (optional but recommended)
 * @param {HTMLImageElement|HTMLCanvasElement} image 
 */
export function preprocessImage(image) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = image.width;
  canvas.height = image.height;
  
  ctx.drawImage(image, 0, 0);
  
  // Grayscale filtering
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Simple sharpening (Unsharp Masking style)
  for (let i = 0; i < data.length; i += 4) {
    const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
    // Basic thresholding for higher contrast
    const val = avg < 128 ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = val;
  }
  ctx.putImageData(imageData, 0, 0);
  
  return canvas.toDataURL('image/png');
}

function formatIndoMonth(monthStr) {
    const months = [
        'JANUARI', 'FEBRUARI', 'MARET', 'APRIL', 'MEI', 'JUNI', 
        'JULI', 'AGUSTUS', 'SEPTEMBER', 'OKTOBER', 'NOVEMBER', 'DESEMBER'
    ];
    let idx = parseInt(monthStr) - 1;
    if (idx >= 0 && idx < 12) return months[idx];
    return monthStr;
}
