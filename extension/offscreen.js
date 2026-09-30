// extension/offscreen.js
import { pipeline, env } from './transformers.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL('models/');
env.useBrowserCache = false;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/');

let detector = null;
let ocrWorker = null;

// NEW: Fallback from WebGPU to WASM
async function loadDetector() {
  try {
    return await pipeline('zero-shot-object-detection', 'Xenova/owlvit-base-patch32', { device: 'webgpu' });
  } catch (e) {
    console.warn("[Offscreen AI] WebGPU failed, falling back to WASM:", e.message);
    return await pipeline('zero-shot-object-detection', 'Xenova/owlvit-base-patch32', { device: 'wasm' });
  }
}

let modelsReady = null;

async function initModels() {
  try {
    console.log("[Offscreen AI] Pre-loading models and workers...");
    
    detector = await loadDetector();
    
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      workerPath: chrome.runtime.getURL('worker.min.js'),
      corePath: chrome.runtime.getURL('tesseract-core-simd-lstm.wasm.js'), 
      langPath: chrome.runtime.getURL('/'),
      workerBlobURL: false,
      logger: m => console.log("[Tesseract Progress]:", m.status, Math.round(m.progress * 100) + "%")
    });
    
    console.log("[Offscreen AI] Models successfully pre-loaded and ready.");
  } catch (err) {
    console.error("🔥 [CRITICAL INIT ERROR] Failed to load models:", err);
    throw err;
  }
}

function ensureModels() {
  if (!modelsReady) {
    modelsReady = initModels().catch(err => { 
      modelsReady = null; 
      throw err; 
    });
  }
  return modelsReady;
}

// Warm-up on script load without crashing the state on failure
ensureModels().catch(() => {});

const REDACTION_TARGETS = ["human face", "identification card", "credit card", "passport"];

async function getOcrRedactionBoxes(imageDataUrl) {
  try {
    console.log("[Offscreen AI] Running OCR...");
    const ret = await ocrWorker.recognize(imageDataUrl, {}, { text: true, blocks: true });
    
    const lines = [];
    (ret.data.blocks || []).forEach(b =>
      (b.paragraphs || []).forEach(p =>
        (p.lines || []).forEach(l => lines.push(l.words || []))));

    const textBoxes = [];
    const ocrCounts = {};
    const caughtTextLogs = [];

    lines.forEach(words => {
      let text = '';
      const spans = [];
      words.forEach(w => {
        const start = text.length;
        text += w.text;
        spans.push({ start, end: text.length, bbox: w.bbox });
        text += ' ';
      });

      // Because 'phone' is listed before 'aadhaar' in PII_PATTERNS, it runs first.
      PII_PATTERNS.forEach(({ name, regex }) => {
        const re = new RegExp(regex.source, 'gi');
        let m;
        const matches = [];

        // 1. Collect all matches for the current pattern
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) { re.lastIndex++; continue; }
          matches.push({ s: m.index, e: m.index + m[0].length, matchedText: m[0] });
        }

        // 2. Process boxes and apply the Destructive Read
        matches.forEach(({ s, e, matchedText }) => {
          // Skip if a previous pattern already wiped this exact section
          if (text.substring(s, e).trim() === '') return;

          spans.forEach(sp => { if (sp.start < e && sp.end > s) textBoxes.push(sp.bbox); });
          ocrCounts[name] = (ocrCounts[name] || 0) + 1;
          caughtTextLogs.push(`[${name.toUpperCase()}] "${matchedText}"`);

          // THE FIX: Overwrite the matched text with blank spaces.
          // This keeps the bounding box coordinates perfectly aligned,
          // but prevents subsequent regexes (like Aadhaar) from seeing those numbers!
          text = text.substring(0, s) + ' '.repeat(e - s) + text.substring(e);
        });
      });
    });

    return { textBoxes, ocrCounts, caughtTextLogs };
  } catch (err) {
    console.error("🔥 [CRITICAL OCR ERROR]", err.message, err);
    return { textBoxes: [], ocrCounts: {}, caughtTextLogs: [], error: err.message };
  }
}

async function applyPixelRedaction(dataUrl, visualRegions, textBoxes) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const MAX_WIDTH = 1280;
      let scale = 1;
      if (img.width > MAX_WIDTH) scale = MAX_WIDTH / img.width;

      const canvas = document.createElement('canvas');
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext('2d');

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000000';

      visualRegions.forEach(obj => {
        const { xmin, ymin, xmax, ymax } = obj.box;
        const pad = (xmax - xmin) * 0.08; 
        ctx.fillRect(
          (xmin - pad) * scale,
          (ymin - pad) * scale,
          (xmax - xmin + pad * 2) * scale,
          (ymax - ymin + pad * 2) * scale
        );
      });

      textBoxes.forEach(bbox => {
        const width = bbox.x1 - bbox.x0;
        const height = bbox.y1 - bbox.y0;
        ctx.fillRect((bbox.x0 - 2) * scale, (bbox.y0 - 2) * scale, (width + 4) * scale, (height + 4) * scale);
      });

      resolve({
        dataUrl: canvas.toDataURL('image/jpeg', 0.6),
        faceCount: visualRegions.filter(r => r.label === "human face").length,
        docCount: visualRegions.filter(r => r.label !== "human face").length
      });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "ANALYZE_IMAGE") {
    (async () => {
      try {
        console.log("[Offscreen AI] Waiting for models to finish loading...");
        
        await ensureModels();

        const t = performance.now();
        const [visionResults, ocrResults] = await Promise.all([
          detector(message.imageData, REDACTION_TARGETS, { threshold: 0.15 })
           .then(r => { console.log("[TIMING] OWL-ViT ms:", Math.round(performance.now() - t)); return r; }),
          getOcrRedactionBoxes(message.imageData)
           .then(r => { console.log("[TIMING] OCR ms:", Math.round(performance.now() - t)); return r; })
        ]);

        const redactionResult = await applyPixelRedaction(message.imageData, visionResults, ocrResults.textBoxes);

        const finalCategories = {};
        
        Object.keys(ocrResults.ocrCounts).forEach(cat => {
          finalCategories[cat] = { count: ocrResults.ocrCounts[cat], sources: ["ocr"] };
        });

        if (redactionResult.faceCount > 0) {
          finalCategories["face"] = { count: redactionResult.faceCount, sources: ["vision"] };
        }
        if (redactionResult.docCount > 0) {
          finalCategories["id_document"] = { count: redactionResult.docCount, sources: ["vision"] };
        }

        sendResponse({
          status: "success",
          faceCount: redactionResult.faceCount,
          docCount: redactionResult.docCount,
          ocrBoxCount: ocrResults.textBoxes.length,
          categories: finalCategories,
          caughtTextLogs: ocrResults.caughtTextLogs,
          ocrError: ocrResults.error || null,
          redactedImage: redactionResult.dataUrl
        });
      } catch (error) {
        console.error("🔥 [CRITICAL VISION ERROR]", error);
        sendResponse({ status: "error", error: error.message });
      }
    })();
    return true;
  }
});