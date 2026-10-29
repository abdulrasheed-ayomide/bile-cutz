// Runs in every test worker BEFORE application modules are imported.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:54329/bilecutz_test';
process.env.DATABASE_SSL = 'false';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.EMAIL_PROVIDER = 'dev-outbox';
process.env.STORAGE_PROVIDER = 'local';
process.env.PUBLIC_API_URL = 'http://localhost:4000';
process.env.CLEANUP_INTERVAL_HOURS = '0';
