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
export async function processReceipt(imageSource) {
  const worker = await createWorker('ind'); // Using Indonesian language
  
  try {
    const { data: { text } } = await worker.recognize(imageSource);
    await worker.terminate();
    
    console.log('Raw OCR Text:', text);
    
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
  // We explicitly stop at 'VA' if present, or avoid capturing 'No', 'Ref', etc.
  
  // Try to find specific pattern R../... VA first (most reliable)
  let tarifMatch = text.match(/(R[\d\w]+\s*\/[\s\d]+\s*VA)/i);
  
  if (!tarifMatch) {
    // Fallback: Look for label
    tarifMatch = text.match(/(?:Tarif\/Daya|Tarif Daya|Daya)\s*[:]?\s*([A-Z0-9\/\s\-]+)/i);
  }

  if (tarifMatch) {
    let raw = tarifMatch[1] ? tarifMatch[1] : tarifMatch[0];
    // Sanitize: 
    // 1. Remove "No", "Ref", "Nama" if they accidentally got caught
    // 2. If "VA" is in the string, cut everything after it.
    
    // Clean: Normalize spaces but keep dots/slashes
    let clean = raw.replace(/\s+/g, ' ').trim();
    
    // Stop at common garbage words
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

  // 10. Extract ANGS/MAT (Angsuran/Materai)
  const angsuranMatch = text.match(/Angsuran\s*Rp?([\d,.]+)/i);
  const materaiMatch = text.match(/Materai\s*Rp?([\d,.]+)/i);
  if (angsuranMatch && materaiMatch) {
    result.angsmat = `${angsuranMatch[1]}/${materaiMatch[1]}`;
  }

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
