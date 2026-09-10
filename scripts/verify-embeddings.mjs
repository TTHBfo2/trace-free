/**
 * verify-embeddings.mjs — standalone regression check for the optional
 * semantic-cache embedding path (@huggingface/transformers), run OUTSIDE
 * Jest on purpose.
 *
 * Why this exists instead of another Jest test: Jest's
 * --experimental-vm-modules isolation breaks the ONNX runtime's
 * Float32Array identity check ("TypeError: A float32 tensor's data must
 * be type of function Float32Array()"), so tests/cache/SemanticCache.test.ts
 * silently falls through to the trigram fallback on every single run — it
 * proves the fallback path works, not that real embedding inference does.
 * This script proves the real path, in a plain Node process, exactly the
 * way a consumer's own app would run it (confirmed manually before this
 * script existed: 384-dim real Float32Array output, clearly separated
 * similarity scores — but those exact numbers vary by sentence pair and
 * are not asserted here as fixed benchmarks, only the separation is).
 *
 * Usage: node scripts/verify-embeddings.mjs
 * Exit code 0 = every assertion passed AND the process exited on its own
 *               (no process.exit() is called below — that absence is
 *               itself part of what this checks).
 * Exit code 1 = an assertion failed.
 * If this HANGS instead of exiting, that is a real finding, not a script
 * bug: it means the embedding runtime is holding an open handle in this
 * Node/package version. Wrap the invocation with a timeout in CI so a
 * hang shows up as a clear failure instead of a silent stall, e.g.:
 *   npx --yes shx true 2>/dev/null; timeout 60 node scripts/verify-embeddings.mjs
 * (or the platform equivalent — see package.json's "verify:embeddings" script).
 */

import { pipeline } from '@huggingface/transformers';

let failed = false;

function assert(cond, msg) {
  if (cond) {
    console.log(`ok: ${msg}`);
  } else {
    console.error(`FAIL: ${msg}`);
    failed = true;
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

console.log('Loading Xenova/all-MiniLM-L6-v2 via @huggingface/transformers (dtype: q8)...');
const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
const embed = async (text) => (await pipe(text, { pooling: 'mean', normalize: true })).data;

const capitalA = await embed('What is the capital of France?');
const capitalB = await embed('Tell me the capital city of France');
const unrelated = await embed('How do I bake a chocolate cake?');

assert(capitalA instanceof Float32Array, 'model output is a real Float32Array (not a plain array or typed-array lookalike)');
assert(capitalA.length === 384, `vector length is 384 (got ${capitalA.length})`);

const simRelated = cosine(capitalA, capitalB);
const simUnrelated = cosine(capitalA, unrelated);

// Not asserting exact similarity values on purpose — they depend on the
// specific sentence pair (a different prompt pair legitimately produced
// 0.842/0.086 in one manual run vs 0.92/0.13 in another) and should never
// be presented as universal benchmark numbers. Asserting a meaningful,
// stable separation instead — that is the actual property semantic
// caching depends on.
assert(
  simRelated > simUnrelated + 0.3,
  `related text scores materially higher than unrelated (related=${simRelated.toFixed(3)}, unrelated=${simUnrelated.toFixed(3)})`,
);

if (failed) {
  console.error('\nverify-embeddings: FAILED');
  process.exitCode = 1;
} else {
  console.log('\nverify-embeddings: all checks passed');
}

// No process.exit() here on purpose. If the embedding runtime left an open
// handle (a worker thread, an unclosed ONNX session, etc.), this process
// will hang here instead of exiting — that hang IS the signal. A clean
// pass requires Node's event loop to drain naturally.
