#!/usr/bin/env node
// Runs the dashboard's own eslint as part of `npm run lint`.
//
// The dashboard has a separate eslint config and was linted only by CI, so a
// JSX error in dashboard copy passed every local check AND the release gate,
// and failed only after pushing. CI installs the dashboard's dependencies in a
// step AFTER the root lint and lints it separately once they exist, so this
// must skip cleanly when they are absent — without turning a genuine lint
// failure into a pass, which a trailing `|| echo` did.
import { existsSync } from 'fs';
import { execSync } from 'child_process';

if (!existsSync('trimwares-dashboard/node_modules')) {
  console.log('lint:dashboard — skipped, trimwares-dashboard/node_modules not installed');
  process.exit(0);
}
// Throws on a non-zero exit, so a real lint error fails this script too.
execSync('npm --prefix trimwares-dashboard run lint', { stdio: 'inherit' });
