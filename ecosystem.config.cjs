module.exports = {
  apps: [
    {
      name: 'budget-bot',
      script: 'dist/index.js',
      cwd: '/home/work/projects/budget-bot',
      node_args: '--env-file=.env',
      watch: false,
      // fork: with `instances` alone PM2 picks cluster mode, where the ESM entry and --env-file fail
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 5,
      min_uptime: 3000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
