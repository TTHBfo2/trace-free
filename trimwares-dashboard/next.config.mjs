import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The version of the package this dashboard ships inside (the repo root's
// package.json), used as Next's build ID below.
const { version: PACKAGE_VERSION } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  // Deterministic build ID. By default Next generates a random ID per
  // build, which lands in ui/_next/static/<id>/ paths — so every
  // `npm run build:ui` (and therefore every prepublishOnly / release-gate
  // run) rewrote tracked files with nothing but the ID changed, dirtying
  // the worktree, and the ui/ that npm packed never matched the ui/ that
  // was committed. Chunk and font filenames are already content-hashed;
  // with the ID pinned to the package version, identical source produces
  // byte-identical ui/, so the committed build is exactly what ships.
  generateBuildId: async () => `trimwares-trace-${PACKAGE_VERSION}`,
  // This dashboard lives as a subdirectory of the @trimwares/trace repo,
  // which has its own root package-lock.json. Turbopack's workspace-root
  // inference sees two lockfiles and guesses; pin it explicitly. Same fix
  // as Trace-Developer's dashboard (commit 17cdcb6 there).
  turbopack: {
    root: __dirname,
  },
};
export default nextConfig;
