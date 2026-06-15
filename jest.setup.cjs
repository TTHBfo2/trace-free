// Global test setup
jest.setTimeout(10000);

// Tests use mock providers and must never write into the live dashboard's
// .trimwares/session.jsonl. Redirect SessionLog writes to an isolated dir
// (separate per worker so parallel test files don't collide).
process.env.TRIMWARES_LOG_DIR = `.trimwares-test-${process.env.JEST_WORKER_ID ?? '0'}`;
