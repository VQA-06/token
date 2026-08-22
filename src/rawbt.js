export async function printViaRawBT(data) {
  try {
    const commands = generateEscPosCommands(data);
    const base64Data = btoa(String.fromCharCode(...commands));
    
    // 1. Primary Strategy: RawBT WS API via WebSocket (port 40213, fast 250ms check)
    let printedSilently = await printViaWebSocket(base64Data, 250);

    // 2. Secondary Strategy: Silent HTTP POST to RawBT Local Server (port 40213, fast 250ms check)
    if (!printedSilently) {
      printedSilently = await printViaHttp(base64Data, 250);
    }

    if (printedSilently) {
      console.log('Printed silently via RawBT Local Service!');
      return;
    }

    // 3. Fallback Strategy: Android Intent URL
    // (Used if WS API / Local Server is OFF in RawBT settings)
    console.log('RawBT WS API / Server inactive, falling back to Intent...');
    const intentUrl = `intent:base64,${base64Data}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`;
    
    // Direct location redirect for reliable Intent opening
    window.location.href = intentUrl;

  } catch (error) {
    console.error('RawBT Print Error:', error);
    throw new Error('Gagal mengirim ke RawBT.');
  }
}

/**
 * Send data silently via RawBT WS API (WebSocket on port 40213)
 */
function printViaWebSocket(base64Data, timeoutMs = 250) {
  return new Promise((resolve) => {
    let resolved = false;
    let ws;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (ws) try { ws.close(); } catch (e) {}
        resolve(false);
      }
    }, timeoutMs);

    try {
      ws = new WebSocket('ws://127.0.0.1:40213');

      ws.onopen = () => {
        ws.send(base64Data);
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            try { ws.close(); } catch (e) {}
            console.log('Silent print via RawBT WS API (WebSocket) success!');
            resolve(true);
          }
        }, 100);
      };

      ws.onerror = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(false);
        }
      };
    } catch (e) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

/**
 * Send data silently via RawBT HTTP Server (port 40213)
 */
function printViaHttp(base64Data, timeoutMs = 250) {
  return new Promise(async (resolve) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch('http://127.0.0.1:40213/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: base64Data,
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok || res.status === 200) {
        console.log('Silent print via RawBT HTTP Server success!');
        resolve(true);
      } else {
        resolve(false);
      }
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * Generate ESC/POS Commands (Copied & Adapted from bluetooth.js)
 */
function generateEscPosCommands(data) {
  const encoder = new TextEncoder();
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID') + ' ' + now.toLocaleTimeString('id-id', { hour12: false }).replace(/\./g, ':');
  
  // ESC/POS Commands
  const ESC = 0x1B;
  const GS = 0x1D;
  const LF = 0x0A;
  
  const isPayment = data.mode === 'payment';
  const isPostpaidPLN = data.mode === 'tagihan-pln';

  let commands = [
    // Initialize
    ESC, 0x40,
    
    // Header
    ESC, 0x61, 0x01, // Center
    ...encoder.encode(`** ${data.storeName.toUpperCase()} **\n`),
    ...encoder.encode(`${dateStr} (CU)\n`),
    LF
  ];

  if (isPayment) {
    // === PAYMENT MODE (PDAM) ===
    commands.push(
      ...encoder.encode('STRUK PEMBAYARAN\n'),
      ...encoder.encode('TAGIHAN\n'),
      LF,
      
      ESC, 0x61, 0x00, // Left
      ...encoder.encode(formatRow('IDPEL', `: ${data.idpel || '-'}`)),
      ...encoder.encode(formatRow('NAMA', `: ${data.nama || '-'}`)),
      ...encoder.encode(formatRow('JENIS TAGIHAN', `: PDAM`)),
      ...encoder.encode(formatRow('LOKASI', `: ${(data.lokasi || '-').replace(/\. /g, '.')}`)), 
      ...encoder.encode(formatRow('PERIODE', `: ${data.periode || '-'}`)), 
      ...encoder.encode(formatRow('TAGIHAN', `: RP.${formatNumber(data.tagihan)}`)),
      ...encoder.encode(formatRow('NO. PESANAN', `: ${data.noPesanan || '-'}`)),
      ...encoder.encode(formatRow('BIAYA ADM', `: RP.${formatNumber(data.admin)}`)),
      
      ESC, 0x45, 0x01, // Bold On
      ...encoder.encode(formatRow('TOTAL BAYAR', `: RP.${formatNumber(data.total)}`)),
      ESC, 0x45, 0x00, // Bold Off
      LF, LF,
      
      ESC, 0x61, 0x01, // Center
      ...encoder.encode('Simpan Struk Ini\n'),
      ...encoder.encode('Sebagai Bukti Pembayaran Yang Sah\n'),
      LF,
      ...encoder.encode('-- Terima Kasih --\n'),
      LF
    );
  } else if (isPostpaidPLN) {
    // === POSTPAID PLN MODE ===
    commands.push(
      ...encoder.encode('STRUK PEMBAYARAN TAGIHAN LISTRIK\n'),
      LF,
      
      ESC, 0x61, 0x00, // Left
      ...encoder.encode(formatRow('IDPEL', `: ${data.idpel}`)),
      ...encoder.encode(formatRow('NAMA', `: ${data.nama}`)),
      ...encoder.encode(formatRow('TRF/DAYA', `: ${data.tarif}`)),
      ...encoder.encode(formatRow('PERIODE', `: ${data.periode}`)),
      ...encoder.encode(formatRow('STAND MET', `: ${data.stand}`)),
      ...encoder.encode(formatRow('TAGIHAN', `: RP. ${formatNumber(data.tagihan || data.nominal)}`)),
      ...encoder.encode(formatRow('DENDA', `: RP. ${formatNumber(data.denda)}`)),
      ...encoder.encode(formatRow('PPN', `: RP. ${formatNumberDecimal(data.ppn)}`)),
      ...encoder.encode(formatRow('NO PESANAN', `: ${data.noPesanan}`)),
      ...encoder.encode(formatRow('BIAYA ADM', `: RP. ${formatNumber(data.admin)}`)),
      
      ESC, 0x45, 0x01, // Bold On
      ...encoder.encode(formatRow('TOTAL BAYAR', `: RP. ${formatNumber(data.total)}`)),
      ESC, 0x45, 0x00, // Bold Off
      LF, LF,
      
      ESC, 0x61, 0x01, // Center
      ...encoder.encode('Simpan Struk Ini\n'),
      ...encoder.encode('Sebagai Bukti Pembayaran Yang Sah\n'),
      LF,
      ...encoder.encode('-- Terima Kasih --\n'),
      LF
    );
  } else {
    // === TOKEN MODE ===
    commands.push(
      ...encoder.encode('STRUK PEMBELIAN LISTRIK\n'),
      ...encoder.encode('PRABAYAR\n'),
      LF,
      
      ESC, 0x61, 0x00, // Left
      ...encoder.encode(formatRow('IDPEL', `: ${data.idpel}`)),
      ...encoder.encode(formatRow('NAMA', `: ${data.nama}`)),
      ...encoder.encode(formatRow('TRF/DAYA', `: ${data.tarif}`)),
      ...encoder.encode(formatRow('NOMINAL', `: RP. ${formatNumber(data.nominal)}`)),
      ...encoder.encode(formatRow('PPN', `: RP. ${formatNumberDecimal(data.ppn)}`)),
      ...encoder.encode(formatRow('ANGS/MAT', `: RP. 0,00/0,00`)),
      ...encoder.encode(formatRow('RP TOKEN', `: RP. ${formatNumber(data.nominal)}`)),
      ...encoder.encode(formatRow('JML KWH', `: ${formatKwh(data.kwh)}`)),
      ...encoder.encode(formatRow('BIAYA ADM', `: RP. ${formatNumber(data.admin)}`)),
      ESC, 0x45, 0x01, // Bold On
      ...encoder.encode(formatRow('TOTAL BAYAR', `: RP. ${formatNumber(data.total)}`)),
      ESC, 0x45, 0x00, // Bold Off
      LF, LF,
      
      ESC, 0x61, 0x01, // Center
      ...encoder.encode('-- TOKEN --\n'),
      ESC, 0x45, 0x01, // Bold On
      GS, 0x21, 0x11, // Double height & width
      ...encoder.encode(splitToken(data.token)),
      GS, 0x21, 0x00, // Normal size
      ESC, 0x45, 0x00, // Bold Off
      LF,
      
      ESC, 0x61, 0x01, // Center
      ...encoder.encode('Info Hubungi Call Center 123\n'),
      ...encoder.encode('Atau Hubungi PLN Terdekat\n'),
      LF
    );
  }

  return new Uint8Array(commands); 
}

// Helpers
function formatRow(label, value) {
  const labelWidth = 14; 
  const padding = ' '.repeat(Math.max(0, labelWidth - label.length));
  return `   ${label}${padding}${value}\n`;
}

function splitToken(token) {
  if (!token || token.length !== 20) return '---- ---- ---- ----\n---- ----';
  const line1 = `${token.substring(0, 4)}-${token.substring(4, 8)}-${token.substring(8, 12)}`;
  const line2 = `${token.substring(12, 16)}-${token.substring(16, 20)}`;
  return `${line1}\n${line2}\n`;
}

function formatNumber(num) {
  if (!num) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function formatNumberDecimal(val) {
  if (!val) return '0,00';
  let clean = val.toString().replace(/[^0-9,.]/g, '').replace(',', '.');
  let num = parseFloat(clean);
  if (isNaN(num)) return val;
  return num.toFixed(2).replace('.', ',');
}

function formatKwh(val) {
  if (!val) return '0,0';
  let clean = val.toString().replace(/[^0-9,.]/g, '').replace(',', '.');
  let num = parseFloat(clean);
  if (isNaN(num)) return val;
  if (!clean.includes('.') && num > 1000) num = num / 100;
  return num.toFixed(1) + 'KWH';
}
