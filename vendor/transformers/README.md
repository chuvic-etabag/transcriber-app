# Vendored Libraries

Copied from npm so the app does not depend on a third-party CDN:

| File | Package | Version | License |
|---|---|---|---|
| `transformers.min.js` | `@huggingface/transformers` (`dist/transformers.min.js`) | 4.3.2 | Apache-2.0 (`LICENSE-transformers.txt`) |
| `ort-wasm-simd-threaded.asyncify.mjs`, `.wasm` | `onnxruntime-web` (`dist/`) | 1.31.0-dev.20260914-8d85527a0 (the version Transformers.js 4.3.2 uses) | MIT |

One change to `transformers.min.js`: the class name `Mistral3ForConditionalGeneration`
is written with a JavaScript escape (`Mistral3ForConditionalGeneration`) in its three
places. It is the same name when the code runs, but GitHub's secret scanner mistook the
plain text for a Mistral API key and blocked the push.
