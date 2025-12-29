/**
 * Gemini AI Integration for Robust Parsing
 * Uses Gemini 1.5 Flash for high-speed, accurate text extraction
 */

const API_KEY = 'AIzaSyC503nWGhR7BmW7jQSPg6GMoUzNZ6Cyvks';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

/**
 * Parse receipt text using Gemini AI
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
    - nama (String, customer name)
    - tarif (String, e.g. "R1M/900 VA")
    - kwh (String, e.g. "123,45")
    - nominal (String, e.g. "20000". The main token value purchased)
    - admin (String, e.g. "2500")
    - total (String, e.g. "22500")
    - ppn (String, e.g. "0")
    - token (String, 20 digits, remove spaces)

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
        }]
      })
    });

    if (!response.ok) {
        throw new Error(`AI Request Failed: ${response.statusText}`);
    }

    const data = await response.json();
    const resultText = data.candidates[0].content.parts[0].text;
    
    // Clean up markdown code blocks if present
    const cleanJson = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
    
    return JSON.parse(cleanJson);
  } catch (error) {
    console.error('Gemini Parsing Error:', error);
    return null; // Fallback to original regex result if AI fails
  }
}
