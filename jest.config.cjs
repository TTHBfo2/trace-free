/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: [
    '<rootDir>/tests/**/*.test.ts',
    '<rootDir>/src/**/*.test.ts'
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.cjs'],
  collectCoverage: false,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts'
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json', useESM: true }]
  },
  transformIgnorePatterns: ['node_modules/(?!(@tthbfo2)/)'],
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 10000,
  verbose: true,
  // forceExit is required: @xenova/transformers loads an ONNX WASM runtime
  // that keeps a worker thread alive after SemanticCache tests complete.
  // The runtime has no public shutdown API, so Jest cannot exit on its own.
  forceExit: true
};
