/**
 * Gemini AI Integration for Robust Parsing
 * Uses Gemini 2.0 Flash for highest accuracy
 */

const API_KEY = 'AIzaSyC503nWGhR7BmW7jQSPg6GMoUzNZ6Cyvks';
// Using gemini-2.0-flash for maximum accuracy on digit recognition
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

/**
 * Parse receipt directly using Gemini Vision (Image-to-JSON)
 * @param {string} base64Data - Base64 image data (including prefix)
 * @returns {Promise<Object>} - Structured data object
 */
export async function parseWithGeminiVision(base64Data) {
  // Extract pure base64 and mime type
  const [prefix, base64] = base64Data.split(',');
  const mimeType = prefix ? prefix.match(/:(.*?);/)[1] : 'image/png';

  console.log('[Gemini Vision] Mengirim gambar ke API, mimeType:', mimeType, 'panjang base64:', base64.length);

  const prompt = `
    You are a specialized digit-by-digit reader for PLN Electricity Receipts (Struk PLN / ShopeePay Invoice PLN).
    Your PRIMARY job is to extract the TOKEN NUMBER with 100% accuracy.

    === CRITICAL RULES FOR TOKEN READING ===
    1. Find the field labeled: "STROOM/TOKEN", "Token", "PLN Token", "Kode Token", or "No. Token".
    2. The token is ALWAYS exactly 20 digits long.
    3. READ EACH DIGIT ONE BY ONE, very carefully. Do NOT guess or approximate.
    4. DIGIT CONFUSION WARNING:
       - The digit "7" has a horizontal line/bar at the TOP. It is NOT "1".
       - The digit "1" is a simple vertical stroke with NO horizontal bar at top.
       - In this font, 7 and 1 look different: 7 has a "roof", 1 does not.
       - Also distinguish: "0" (oval) vs "O" (letter), use "0".
    5. After reading all 20 digits, COUNT them to confirm you have exactly 20. If not 20, re-read.
    6. Return the token as a string of 20 digits with NO spaces.

    === OTHER FIELDS ===
    Extract these fields too:
    - idpel: customer ID, 11-12 digits (labeled IDPEL, NO METER, or Nomor Pelanggan)
    - nama: customer full name (labeled NAMA)
    - tarif: tariff/power (e.g. "R1M/900VA")
    - kwh: kilowatt-hours (e.g. "35,0")
    - nominal: token value in Rupiah digits only (e.g. "50000"). This is RP STROOM/TOKEN value.
    - admin: admin fee digits only (e.g. "1000")
    - total: total payment digits only (e.g. "51000"). This is RP BAYAR value.
    - ppn: PPN value digits only (e.g. "0")
    - noPesanan: order number (labeled No. Pesanan or similar, could be 18+ digits)
    - token: the 20-digit token (your primary mission)

    Rules for money fields:
    - Remove "Rp", dots, commas from money values. Return digits only.
    - "nominal" = RP STROOM/TOKEN amount (NOT total payment).
    - "total" = RP BAYAR or total paid amount.

    Return ONLY a valid JSON object. No markdown, no explanation.
  `;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0
        }
      })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('[Gemini Vision] API Error Status:', response.status, errorData);
        throw new Error(`AI Vision Request Failed: ${response.status}`);
    }

    const data = await response.json();
    console.log('[Gemini Vision] Candidates:', data.candidates?.length, '| Token hasil:', data.candidates?.[0]?.content?.parts?.[0]?.text?.substring(0, 200));
    const resultText = data.candidates[0].content.parts[0].text;
    const cleanJson = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    console.log('[Gemini Vision] Token terbaca:', parsed.token);
    return parsed;
  } catch (error) {
    console.error('[Gemini Vision] Error:', error.message);
    return null;
  }
}

/**
 * Parse receipt text using Gemini AI (Text-only fallback)
 * @param {string} rawText - Raw OCR text from Tesseract
 * @returns {Promise<Object>} - Structured data object
 */
export async function parseWithGemini(rawText) {
  const prompt = `
    You are a specialized parser for PLN Electricity Receipts (Struk PLN).
    Extract the following fields from the messy OCR text below. 
    Return ONLY a valid JSON object. Do not include markdown formatting like \`\`\`json.
    
    Fields to extract:
    - idpel (Number string, 11-12 digits)
    - nama (String, customer name, preserve special characters like ' or -)
    - tarif (String, e.g. "R1M/900 VA")
    - kwh (String, e.g. "123,45")
    - nominal (String, e.g. "20000". The main token value purchased)
    - admin (String, e.g. "2500")
    - total (String, e.g. "22500")
    - ppn (String, e.g. "0")
    - token (String, 20 digits, remove spaces)
    - stand (String, e.g. "0012345-0012567". For postpaid receipts)
    - denda (String, e.g. "5000". For postpaid receipts)
    - periode (String, e.g. "JAN 2024". For postpaid receipts)
    - noPesanan (String, e.g. "2502061234567890". The order/transaction number)

    Rules:
    1. "nominal" is the value of the token (e.g. Rp 20.000), NOT the total payment.
    2. "tarif" must be extracted EXACTLY as it appears in the text, preserving spaces, slashes, and dots (e.g., "R1 / 450.00 VA" or "R1M / 900 VA"). Do not normalize it.
    3. Correct any obvious OCR typos (e.g. "l" -> "1", "O" -> "0" in numbers).
    4. **KWh FORMATTING RULES**:
       - If the KWh value found has 2 digits (e.g., "46"), format it as "46,0".
       - If the KWh value found has 3 or more digits (e.g., "3530" or "14090"), treat it as having 2 hidden decimal places. Divide by 100 or format as "XX,Y" where Y is the 10th place (e.g., "3530" -> "35,3"; "14090" -> "140,9").
       - Use comma "," for the decimal separator.
    5. Preserve all decimal separators exactly (use comma "," for Indonesian format).
    6. Ensure the "token" field contains ONLY 20 digits, no spaces or special characters.
    7. **No Pesanan**: Look for "No. Pesanan" or "No Pesanan" or "Order No".
    
    OCR TEXT:
    ${JSON.stringify(rawText)}
  `;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: { temperature: 0 }
      })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Gemini API Error Detail:', errorData);
        throw new Error(`AI Request Failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const resultText = data.candidates[0].content.parts[0].text;
    const cleanJson = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanJson);
  } catch (error) {
    console.error('Gemini Parsing Error:', error);
    return null;
  }
}
