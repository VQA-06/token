import { createWorker } from 'tesseract.js';
import { parseWithGemini } from './gemini.js';

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
 */
export async function processReceipt(imageSource, mode = 'token') {
  const worker = await createWorker('ind'); // Using Indonesian language
  
  try {
    const { data: { text } } = await worker.recognize(imageSource);
    await worker.terminate();
    
    console.log('Raw OCR Text:', text);
    
    if (mode === 'payment') {
        console.log('Mode: Payment. Using Regex Parser.');
        return parsePaymentText(text);
    }
    
    // Full AI Parsing Mode - Gemini handles everything
    console.log('Using Gemini AI for parsing...');
    const aiResult = await parseWithGemini(text);
    
    if (aiResult) {
        console.log('AI Parsing Success:', aiResult);
        // Ensure raw text is preserved
        aiResult.raw = text;
        return aiResult;
    } else {
        // Fallback to regex only if AI completely fails
        console.warn('AI parsing failed. Using regex fallback...');
        return parsePLNText(text);
    }
  } catch (error) {
    console.error('OCR Error:', error);
    await worker.terminate();
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
    admin: '',
    total: '',
    ppn: '0',
    angsmat: '0,00/0,00',
    noPesanan: '', 
    raw: text
  };

  // 1. Extract Token (20 digits)
  const tokenMatch = text.match(/Stroom\/Nomor Token\s*(\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4})/i) ||
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
  // Extremely robust: capture any non-newline character until a known label
  const namaLabelPattern = /Nama\s*[:]?\s*([^\n\r]+?)(?=\s*(?:Tarif\/Daya|Tarif Daya|IDPEL|Nomor|Stroom|Total|No\.\s*Pesanan|No\.\s*Meter|$))/i;
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
  // Robust: Handle spaced out 'K W H', suffix placement '123,4 kWh', and typo variations
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

  // 8. Extract Total (Total tagihan)
  const totalMatch = text.match(/Total tagihan\s*Rp?([\d,.]+)/i) ||
                     text.match(/TOTAL\s*[:]\s*Rp?([\d,.]+)/i);
  if (totalMatch) {
    result.total = totalMatch[1].trim().replace(/\./g, '').replace(/,/g, '');
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
  // Rule: Capture everything on the same line after labeling, allowing special characters.
  // We use word boundaries to avoid matching "Pelanggan" inside "ID Pelanggan".
  const namaLabelPattern = /(?:\bNama Pelanggan|\bNama|\bNAMA\b)\s*[:]?\s*([^\n\r]+)/i;
  const namaMatch = text.match(namaLabelPattern);
  if (namaMatch) {
    let rawNama = namaMatch[1].trim();
    
    // Safety: If the OCR caught the next field on the same line (e.g. "MARDALENA No. Pel"), 
    // we prune at known field boundaries
    const fields = ['NO.PEL', 'NO. PEL', 'ID PEL', 'IDPEL', 'NO SAMB', 'NO.SAMB', 'PERIODE', 'ALAMAT', 'TOTAL', 'TAGIHAN'];
    let clean = rawNama;
    for (const f of fields) {
      const idx = clean.toUpperCase().indexOf(f);
      if (idx !== -1) {
        // Only prune if it looks like a separate word (preceded by space)
        if (idx === 0 || /\s/.test(clean[idx - 1])) {
          clean = clean.substring(0, idx).trim();
        }
      }
    }
    
    // Final check to remove leading noise but preserve internal characters
    result.nama = clean.replace(/^(?:Pelanggan|Plg|Nama)\s*[:.-]?\s*/i, '').trim();
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
  // Usually labeled "Tagihan", "Jumlah Tagihan", "Total Air"
  const tagihanMatch = text.match(/(?:Tagihan|Jml Tagihan|Total Air|Biaya Air)\s*[:]?\s*Rp?[\s.]*([\d,.]+)/i);
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
  // Usually labeled "Total Bayar", "Total"
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

/**
 * Process PDF file and return extracted data
 */
export async function processPdf(pdfDataUrl) {
  if (!pdfjsLib) {
    throw new Error('PDF library belum dimuat. Silakan muat ulang halaman.');
  }
  const loadingTask = pdfjsLib.getDocument(pdfDataUrl);
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1); // Process first page
  
  const viewport = page.getViewport({ scale: 3.0 }); // Increased scale for better OCR on mobile browsers
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({ canvasContext: context, viewport: viewport }).promise;
  
  const imageData = canvas.toDataURL('image/png');
  return await processReceipt(imageData);
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
