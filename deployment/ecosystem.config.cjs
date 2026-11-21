const path = require('node:path');

const cwd = path.resolve(__dirname, '..');
module.exports = {
  apps: [
    { name: 'ttw-api', script: 'dist/apps/api/src/main.js' },
    { name: 'ttw-web', script: 'dist/apps/web/src/main.js' },
    { name: 'ttw-translation-worker', script: 'dist/apps/worker/src/main.js' }
  ].map(process => ({
    ...process, cwd, autorestart: true, exp_backoff_restart_delay: 500,
    kill_timeout: 35000, time: true, env: { NODE_ENV: 'production' }
  }))
};
