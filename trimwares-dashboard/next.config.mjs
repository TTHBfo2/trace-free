import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  // This dashboard lives as a subdirectory of the @trimwares/trace repo,
  // which has its own root package-lock.json. Turbopack's workspace-root
  // inference sees two lockfiles and guesses; pin it explicitly. Same fix
  // as Trace-Developer's dashboard (commit 17cdcb6 there).
  turbopack: {
    root: __dirname,
  },
};
export default nextConfig;
