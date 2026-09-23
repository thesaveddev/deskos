/**
 * Starts the same embedded Postgres the test suite uses, keeps it alive for
 * local dev servers, and writes the connection URL where the API config
 * expects it (/tmp/reydesk-test-db-url.json). Development helper only.
 */
import setup from './test/global-setup.js'

await setup()
console.log('[dev-db] embedded database ready')
setInterval(() => {}, 1 << 30)
