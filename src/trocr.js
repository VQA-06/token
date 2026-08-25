/**
 * Microsoft TrOCR integration via Transformers.js
 * High precision Vision Transformer for printed text & digit recognition (100% offline via IndexedDB/Cache)
 */
import { pipeline, env } from '@xenova/transformers';

// Setup environment for browser execution
env.allowLocalModels = false;
env.useBrowserCache = true;

let ocrPipeline = null;
let isLoading = false;
let loadPromise = null;

/**
 * Initialize TrOCR pipeline
 * @param {Function} onProgress - Progress callback ({ status, progress, file, total })
 * @returns {Promise<any>}
 */
export async function getTrOCRPipeline(onProgress = null) {
  if (ocrPipeline) return ocrPipeline;
  if (isLoading && loadPromise) return loadPromise;

  isLoading = true;
  loadPromise = (async () => {
    try {
      console.log('[TrOCR] Inisialisasi pipeline Xenova/trocr-small-printed...');
      ocrPipeline = await pipeline('image-to-text', 'Xenova/trocr-small-printed', {
        progress_callback: (progress) => {
          if (onProgress) onProgress(progress);
        }
      });
      console.log('[TrOCR] Model berhasil dimuat.');
      return ocrPipeline;
    } catch (err) {
      console.error('[TrOCR] Gagal memuat model:', err);
      ocrPipeline = null;
      throw err;
    } finally {
      isLoading = false;
    }
  })();

  return loadPromise;
}

/**
 * Recognizes text from an image data URL, canvas, or blob using TrOCR
 * @param {string|HTMLCanvasElement} imageInput - Base64 Data URL or Canvas
 * @returns {Promise<string>} - Extracted text
 */
export async function recognizeTextWithTrOCR(imageInput, onProgress = null) {
  const pipe = await getTrOCRPipeline(onProgress);
  
  let src = imageInput;
  if (typeof imageInput !== 'string' && imageInput.toDataURL) {
    src = imageInput.toDataURL('image/png');
  }

  const output = await pipe(src);
  console.log('[TrOCR Output]:', output);

  if (Array.isArray(output) && output.length > 0) {
    return output[0].generated_text || '';
  }
  if (output && output.generated_text) {
    return output.generated_text;
  }
  return '';
}
