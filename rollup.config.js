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
    external: ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'crypto', 'zlib', 'tiktoken', '@huggingface/transformers']
  },

  // CJS build — .cjs extension required when package.json has "type": "module"
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.cjs',
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
    external: ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'crypto', 'zlib', 'tiktoken', '@huggingface/transformers']
  }
];
