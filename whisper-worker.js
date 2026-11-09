/*
 * whisper-worker.js — Runs the Whisper speech model in a Web Worker through
 * Transformers.js, so the screen never freezes while it works.
 *
 * Started by file.js as a module worker. Messages in:
 *   { type: 'load', model, bytes }                  load (and on first use, download) a model
 *   { type: 'transcribe', id, audio, language }     audio: Float32Array, 16 kHz mono, <= 30 s
 *                                                   language: 'auto' | 'english' | 'tagalog'
 *   { type: 'cancel' }                              stop the current piece as soon as possible
 * Messages out:
 *   { type: 'download', loaded, total, progress }   first-time download progress (bytes, 0-100)
 *   { type: 'ready', model, fromCache }
 *   { type: 'result', id, text, language }          language: 'en' | 'tl'
 *   { type: 'cancelled', id }
 *   { type: 'error', id, code, message }            code: 'download' | 'memory' | 'other'
 *
 * The library and its WebAssembly files are in vendor/transformers/ (same
 * site, so nothing extra to trust); models come from huggingface.co and are
 * kept in the browser's cache, so they download only once.
 */
import {
  pipeline, env, LogitsProcessor, LogitsProcessorList, InterruptableStoppingCriteria, StoppingCriteriaList
} from './vendor/transformers/transformers.min.js';

const VENDOR = new URL('./vendor/transformers/', import.meta.url).href;
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = {
  mjs: VENDOR + 'ort-wasm-simd-threaded.asyncify.mjs',
  wasm: VENDOR + 'ort-wasm-simd-threaded.asyncify.wasm'
};
// GitHub Pages can't turn on the headers multi-threading needs; one thread works everywhere.
env.backends.onnx.wasm.numThreads = 1;

const ENGINE_URL = VENDOR + 'ort-wasm-simd-threaded.asyncify.wasm';
const ENGINE_BYTES = 26861777;

let asr = null;
let loadedModel = null;
let loading = null;
const stopper = new InterruptableStoppingCriteria();

function classify(err) {
  const text = String((err && (err.message || err.name)) || err || '');
  if ((err && err.name === 'RangeError') || /out of memory|allocation failed|allocate|oom|bad_alloc|memory/i.test(text)) {
    return 'memory';
  }
  if (/fetch|network|load failed|failed to download|status|offline|could not locate|404|50\d|ERR_/i.test(text)) {
    return 'download';
  }
  return 'other';
}

/**
 * Auto-Detect: Transformers.js would silently assume English, so we pick the
 * language ourselves. On the first step only the English and Filipino tokens
 * are allowed (the app's two languages); then "transcribe" and "no
 * timestamps" are forced, the same prompt Whisper uses when told a language.
 */
class LanguagePicker extends LogitsProcessor {
  constructor(config) {
    super();
    this.allowed = [config.lang_to_id['<|en|>'], config.lang_to_id['<|tl|>']];
    this.transcribe = config.task_to_id.transcribe;
    this.noTimestamps = config.no_timestamps_token_id;
    this.suppress = config.begin_suppress_tokens || [];
    this.chosen = null;
  }
  _call(inputIds, logits) {
    for (let i = 0; i < inputIds.length; i++) {
      const length = inputIds[i].length;
      const data = logits[i].data;
      if (length === 1) {
        let best = this.allowed[0];
        for (const id of this.allowed) if (data[id] > data[best]) best = id;
        data.fill(-Infinity);
        data[best] = 0;
        this.chosen = best;
      } else if (length === 2) {
        data.fill(-Infinity);
        data[this.transcribe] = 0;
      } else if (length === 3) {
        data.fill(-Infinity);
        data[this.noTimestamps] = 0;
      } else if (length === 4) {
        for (const id of this.suppress) data[id] = -Infinity;
      }
    }
    return logits;
  }
}

async function cacheHas(test) {
  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    return keys.some((r) => test(r.url));
  } catch (e) {
    return false;
  }
}
const isCached = (model) => cacheHas((url) => url.includes('/' + model + '/') && url.includes('decoder_model_merged'));
const engineCached = () => cacheHas((url) => url === ENGINE_URL);

/**
 * The speech engine (ONNX Runtime, about 27 MB) is fetched here first, with
 * progress, and put where Transformers.js looks for it, so the first-time
 * download shows one honest total instead of stalling at the end.
 */
async function downloadEngine(report) {
  const response = await fetch(ENGINE_URL);
  if (!response.ok || !response.body) throw new Error('Failed to download the speech engine: ' + response.status);
  const reader = response.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    report(loaded);
  }
  try {
    const cache = await caches.open('transformers-cache');
    await cache.put(ENGINE_URL, new Response(new Blob(parts, { type: 'application/wasm' }),
      { headers: { 'content-type': 'application/wasm' } }));
  } catch (e) { /* storage full: Transformers.js will fetch it again itself */ }
}

async function load(model, modelBytes) {
  if (asr && loadedModel === model) return { fromCache: true };
  if (loading && loading.model === model) return loading.promise;
  const promise = (async () => {
    const fromCache = await isCached(model);
    const needEngine = !(await engineCached());
    const engineBytes = needEngine ? ENGINE_BYTES : 0;
    let modelTotal = fromCache ? 0 : (modelBytes || 0);
    const send = (loaded) => {
      const total = engineBytes + modelTotal;
      if (total) self.postMessage({ type: 'download', loaded, total, progress: Math.min(100, loaded / total * 100) });
    };
    if (needEngine) await downloadEngine((n) => send(Math.min(n, ENGINE_BYTES)));
    if (asr) {
      try { await asr.dispose(); } catch (e) { /* ignore */ }
      asr = null;
      loadedModel = null;
    }
    asr = await pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress_total' && !fromCache) {
          modelTotal = p.total;
          send(engineBytes + p.loaded);
        }
      }
    });
    loadedModel = model;
    return { fromCache };
  })();
  loading = { model, promise };
  try {
    return await promise;
  } finally {
    loading = null;
  }
}

/** Collapse Whisper's occasional loops ("thank you thank you thank you ..."). */
function tidy(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  for (let n = 1; n <= 8; n++) {
    const re = new RegExp('((?:\\S+\\s+){' + (n - 1) + '}\\S+)(?:\\s+\\1){3,}', 'gi');
    t = t.replace(re, '$1');
  }
  return t;
}

async function transcribe(msg) {
  stopper.reset();
  const config = asr.model.generation_config;
  const stopping = new StoppingCriteriaList();
  stopping.push(stopper);
  const options = { stopping_criteria: stopping, return_timestamps: false };
  let language = msg.language === 'tagalog' ? 'tl' : 'en';
  let picker = null;
  if (msg.language === 'auto') {
    picker = new LanguagePicker(config);
    const processors = new LogitsProcessorList();
    processors.push(picker);
    options.decoder_input_ids = [config.decoder_start_token_id];
    options.logits_processor = processors;
  } else {
    options.language = msg.language;
    options.task = 'transcribe';
  }
  const output = await asr(msg.audio, options);
  if (picker && picker.chosen !== null) {
    language = picker.chosen === config.lang_to_id['<|tl|>'] ? 'tl' : 'en';
  }
  return { text: tidy(output && output.text), language };
}

let queue = Promise.resolve();

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'cancel') {
    stopper.interrupt();
    return;
  }
  // One job at a time, in order.
  queue = queue.then(async () => {
    try {
      if (msg.type === 'load') {
        const info = await load(msg.model, msg.bytes);
        self.postMessage({ type: 'ready', model: msg.model, fromCache: info.fromCache });
      } else if (msg.type === 'transcribe') {
        if (!asr) throw new Error('Model not loaded');
        const result = await transcribe(msg);
        if (stopper.interrupted) self.postMessage({ type: 'cancelled', id: msg.id });
        else self.postMessage({ type: 'result', id: msg.id, text: result.text, language: result.language });
      }
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, code: classify(err), message: String((err && err.message) || err) });
    }
  });
};
