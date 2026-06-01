import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';

export default [
  // ESM build
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.esm.js',
      format: 'esm',
      sourcemap: true,
      exports: 'named'
    },
    plugins: [
      resolve({ preferBuiltins: true }),
      typescript({
        tsconfig: './tsconfig.json',
        sourceMap: true,
        declaration: true,
        declarationDir: 'dist',
        rootDir: 'src'
      })
    ],
    external: ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'crypto', 'zlib']
  },

  // CJS build
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.js',
      format: 'cjs',
      sourcemap: true,
      exports: 'named'
    },
    plugins: [
      resolve({ preferBuiltins: true }),
      typescript({
        tsconfig: './tsconfig.json',
        sourceMap: true,
        declaration: false,
        declarationMap: false
      })
    ],
    external: ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'crypto', 'zlib']
  }
];
