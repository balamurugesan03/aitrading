// PM2 (no Docker): npm run install:all && npm run build, then  pm2 start deploy/ecosystem.config.cjs && pm2 save
// Keep ONE instance: bots, rate limits and the WebSocket fan-out live in process memory.
module.exports = {
  apps: [{
    name: 'velocityx',
    cwd: __dirname + '/../server',
    script: 'src/index.js',
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production' }, // other settings come from server/.env
    kill_timeout: 30000, // matches the graceful-shutdown drain
    max_memory_restart: '1G',
    restart_delay: 5000,
    time: true,
  }],
};
