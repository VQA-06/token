import { processReceipt, processPdf, preprocessImage } from './ocr';
import { printViaRawBT } from './rawbt';
import { registerSW } from 'virtual:pwa-register';

// State
let currentReceiptData = null;

// DOM Elements
const scannerSection = document.getElementById('scanner-section');
const resultSection = document.getElementById('result-section');
const imagePreview = document.getElementById('image-preview');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const ocrStatus = document.getElementById('ocr-status');
const statusText = document.getElementById('status-text');
const installBtn = document.getElementById('install-btn');

// Result Elements
const resToken = document.getElementById('res-token');
const resIdpel = document.getElementById('res-idpel');
const resNama = document.getElementById('res-nama');
const resTarif = document.getElementById('res-tarif');
const resKwh = document.getElementById('res-kwh');
const resNominal = document.getElementById('res-nominal');
const resPpn = document.getElementById('res-ppn');
const resAngsmat = document.getElementById('res-angsmat');
const resTotal = document.getElementById('res-total');
const adminSelect = document.getElementById('res-admin-select');

// Buttons
const uploadBtn = document.getElementById('upload-btn');
const printBtn = document.getElementById('print-btn');
const resetBtn = document.getElementById('reset-btn');
const settingsBtn = document.getElementById('settings-btn');
const saveSettingsBtn = document.getElementById('save-settings');
const settingsModal = document.getElementById('settings-modal');
const storeNameInput = document.getElementById('store-name-input');

// Preview Elements
const previewModal = document.getElementById('preview-modal');
const closePreviewBtn = document.getElementById('close-preview');
const confirmPrintBtn = document.getElementById('confirm-print-btn');
const preStore = document.getElementById('pre-store');
const preDatetime = document.getElementById('pre-datetime');
const preIdpel = document.getElementById('pre-idpel');
const preNama = document.getElementById('pre-nama');
const preTarif = document.getElementById('pre-tarif');
const preNominal = document.getElementById('pre-nominal');
const prePpn = document.getElementById('pre-ppn');
const preAngsmat = document.getElementById('pre-angsmat');
const preRptoken = document.getElementById('pre-rptoken');
const preKwh = document.getElementById('pre-kwh');
const preAdmin = document.getElementById('pre-admin');
const preTotal = document.getElementById('pre-total');
const preToken = document.getElementById('pre-token');

/**
 * PWA Registration
 */
const updateSW = registerSW({
  onNeedRefresh() {
    showToast('Aplikasi tersedia versi baru. Muat ulang?', 5000);
  },
  onOfflineReady() {
    showToast('Aplikasi siap digunakan secara offline');
  },
});

/**
 * UI State Management
 */
function showScanner() {
  scannerSection.classList.remove('hidden');
  resultSection.classList.add('hidden');
  ocrStatus.classList.add('hidden');
  imagePreview.classList.add('hidden');
  dropZone.classList.remove('hidden');
}

function showResult(data) {
  const customAdmin = parseInt(localStorage.getItem('customAdmin') || '3000');
  
  // OCR sometimes detects Admin if it's there
  const ocrAdmin = parseInt(data.admin || '0');
  
  // If OCR detected 0 admin (like in shopee receipt), we use customAdmin
  // If user wants to override, they can.
  data.admin = customAdmin;
  data.total = (parseInt(data.nominal || '0')) + data.admin;

  currentReceiptData = data;
  resToken.textContent = formatToken(data.token);
  resIdpel.textContent = data.idpel || '-';
  resNama.textContent = data.nama || '-';
  resTarif.textContent = data.tarif || '-';
  resKwh.textContent = formatKwh(data.kwh) || '-';
  resNominal.textContent = `Rp${formatRp(data.nominal)}`;
  resPpn.textContent = `Rp${formatRpDecimal(data.ppn)}`;
  resAngsmat.textContent = `Rp${data.angsmat}`;
  resTotal.textContent = `Rp${formatRp(data.total)}`;

  // Update active admin select
  adminSelect.value = data.admin.toString();

  scannerSection.classList.add('hidden');
  resultSection.classList.remove('hidden');
}

function updatePreview() {
  const storeName = localStorage.getItem('storeName') || 'SA CELL';
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID') + ' ' + now.toLocaleTimeString('id-id', { hour12: false }).replace(/\./g, ':');
  
  preStore.textContent = `** ${storeName.toUpperCase()} **`;
  preDatetime.textContent = dateStr;
  preIdpel.textContent = currentReceiptData.idpel;
  preNama.textContent = currentReceiptData.nama;
  preTarif.textContent = currentReceiptData.tarif;
  preNominal.textContent = `RP. ${formatRp(currentReceiptData.nominal)}`;
  prePpn.textContent = `RP. ${formatRpDecimal(currentReceiptData.ppn)}`;
  preAngsmat.textContent = `RP. 0,00/0,00`;
  preRptoken.textContent = `RP. ${formatRp(currentReceiptData.nominal)}`;
  preKwh.textContent = formatKwh(currentReceiptData.kwh);
  preAdmin.textContent = `RP. ${formatRp(currentReceiptData.admin)}`;
  preTotal.textContent = `RP. ${formatRp(currentReceiptData.total)}`;
  
  // Format token 2 lines
  const token = currentReceiptData.token;
  if (token && token.length === 20) {
    preToken.innerHTML = `${token.substring(0, 4)}-${token.substring(4, 8)}-${token.substring(8, 12)}<br>${token.substring(12, 16)}-${token.substring(16, 20)}`;
  } else {
    preToken.textContent = '---- ---- ---- ---- ----';
  }
}

function formatRp(num) {
  if (!num) return '0,00';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".") + ',00';
}

function formatRpDecimal(val) {
  if (!val) return '0,00';
  let clean = val.toString().replace(/[^0-9,.]/g, '').replace(',', '.');
  let num = parseFloat(clean);
  if (isNaN(num)) return val;
  return num.toFixed(2).replace('.', ',');
}

function formatKwh(val) {
  if (!val) return '0,0';
  // Clean value (only digits and decimal markers)
  let clean = val.replace(/[^0-9,.]/g, '').replace(',', '.');
  let num = parseFloat(clean);
  if (isNaN(num)) return val;
  
  // If no decimal places and high value, assume OCR missed the comma (e.g. 3530 -> 35.30)
  // This is a heuristic for Shopee receipts where 35,30 might be read as 3530
  if (!clean.includes('.') && num > 1000) {
    num = num / 100;
  }
  
  // Return with 1 decimal place and DOT separator + KWH suffix
  return num.toFixed(1) + 'KWH';
}

function formatToken(token) {
  if (!token) return '---- ---- ---- ---- ----';
  return token.replace(/(\d{4})/g, '$1 ').trim();
}

/**
 * Image Processing Flow
 */
async function processImage(source, isPdf = false) {
  ocrStatus.classList.remove('hidden');
  statusText.textContent = 'Memproses ' + (isPdf ? 'PDF' : 'OCR') + '...';
  
  try {
    let data;
    if (isPdf) {
      // PDF preview is handled differently or we can use a placeholder
      imagePreview.classList.add('hidden');
      data = await processPdf(source);
    } else {
      // Show preview
      imagePreview.src = source;
      imagePreview.classList.remove('hidden');
      data = await processReceipt(source);
    }
    
    dropZone.classList.add('hidden');

    if (!data.token) {
      statusText.textContent = 'Token tidak ditemukan. Coba lagi.';
      setTimeout(() => ocrStatus.classList.add('hidden'), 3000);
      return;
    }

    showResult(data);
  } catch (err) {
    showToast('Gagal memproses file: ' + err.message);
    ocrStatus.classList.add('hidden');
  }
}

/**
 * Event Listeners
 */

uploadBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const reader = new FileReader();
    reader.onload = (event) => processImage(event.target.result, isPdf);
    reader.readAsDataURL(file);
  }
});

adminSelect.addEventListener('change', () => {
  if (!currentReceiptData) return;
  const value = parseInt(adminSelect.value);
  currentReceiptData.admin = value;
  currentReceiptData.total = (parseInt(currentReceiptData.nominal || '0')) + value;
  
  // Update UI
  resTotal.textContent = `Rp${formatRp(currentReceiptData.total)}`;
  
  // Save as default
  localStorage.setItem('customAdmin', value);
});

dropZone.addEventListener('click', () => fileInput.click());

printBtn.addEventListener('click', async () => {
  if (!currentReceiptData) return;
  
  // Visual feedback
  const originalText = printBtn.innerHTML;
  printBtn.disabled = true;
  printBtn.innerHTML = '<div class="spinner"></div> Mengirim ke RawBT...';

  try {
    const storeName = localStorage.getItem('storeName') || 'SA CELL';
    // Use RawBT Service
    await printViaRawBT({ ...currentReceiptData, storeName });
    showToast('Berhasil dikirim ke RawBT!');
  } catch (err) {
    showToast(err.message); 
    // Show specific advice if error mentions RawBT
    if (err.message.includes('RawBT')) {
        showToast('Pastikan RawBT aktif & "Server Pencetakan" ON', 5000);
    }
  } finally {
    printBtn.disabled = false;
    printBtn.innerHTML = originalText;
  }
});

// Confirm print listener removed as preview is bypassed
// confirmPrintBtn.addEventListener('click', async () => { ... });

closePreviewBtn.addEventListener('click', () => {
  previewModal.classList.add('hidden');
});

resetBtn.addEventListener('click', showScanner);

// Settings Modal
settingsBtn.addEventListener('click', () => {
  storeNameInput.value = localStorage.getItem('storeName') || 'SA CELL';
  settingsModal.classList.remove('hidden');
});

saveSettingsBtn.addEventListener('click', () => {
  localStorage.setItem('storeName', storeNameInput.value);
  settingsModal.classList.add('hidden');
  if (currentReceiptData) {
    showResult(currentReceiptData); // Recalculate if result is showing
  }
});

window.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
  if (e.target === previewModal) previewModal.classList.add('hidden');
});

/**
 * Utilities
 */
function showToast(message, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

// PWA Install Prompt
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.classList.remove('hidden');
});

installBtn.addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      installBtn.classList.add('hidden');
    }
    deferredPrompt = null;
  }
});
