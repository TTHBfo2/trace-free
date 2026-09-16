#!/usr/bin/env node
/**
 * build.mjs — runs the exact same rollup.config.js as `rollup -c`, through
 * rollup's JS API, and exits explicitly when the bundles are written.
 *
 * Why not just `rollup -c`: intermittently (roughly 1 run in 2 when chained
 * after `npm test` in prepublishOnly, observed both inside and outside a
 * OneDrive-synced folder, with the identical toolchain that shipped
 * 1.5.0–1.5.3), the CLI prints "created dist/index.cjs" and then never
 * exits — something in the two @rollup/plugin-typescript instances leaves a
 * live handle behind and the process sits forever. From an interactive
 * terminal it happened to win the race; under `npm publish` a hung
 * prepublishOnly is a publish that never happens. The programmatic API
 * with an explicit process.exit(0) after bundle.close() sidesteps the race
 * entirely: the artifacts are on disk, so nothing is lost by exiting.
 *
 * Output is byte-identical to `rollup -c` — same config object, same
 * plugins, same write() calls.
 */
import { rollup } from 'rollup';
import configs from '../rollup.config.js';

const t0 = Date.now();
try {
  for (const cfg of configs) {
    const bundle = await rollup(cfg);
    const outputs = Array.isArray(cfg.output) ? cfg.output : [cfg.output];
    for (const out of outputs) {
      await bundle.write(out);
      console.log(`  created ${out.file} (${out.format})`);
    }
    await bundle.close();
  }
  console.log(`build: ${configs.length} bundle(s) written in ${Date.now() - t0}ms`);
  process.exit(0);
} catch (err) {
  console.error('build failed:', err);
  process.exit(1);
}
