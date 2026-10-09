// pm2 ecosystem config — manages all FinVerify OS services
// Usage: pm2 start ecosystem.config.js
//        pm2 save && pm2 startup   (auto-start on reboot)
//        pm2 monit                 (live dashboard)

const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "finverify-api",
      script: "node",
      args: "--enable-source-maps dist/index.mjs",
      cwd: "./backend/api",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      restart_delay: 2000,
      max_restarts: 20,
      env: {
        NODE_ENV: "production",
        PORT: "8080",
        CORS_ORIGIN: "http://localhost:21950",
      },
      error_file: "./logs/api-error.log",
      out_file: "./logs/api-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "finverify-python",
      script: process.env.PYTHON_BIN || "python",
      args: "-m uvicorn app.main:app --host 0.0.0.0 --port 8091",
      cwd: "./backend/worker",
      instances: 1,
      interpreter: "none",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      restart_delay: 3000,
      max_restarts: 20,
      error_file: "./logs/python-error.log",
      out_file: "./logs/python-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "finverify-go",
      script: path.join(__dirname, "backend/gateway", process.platform === "win32" ? "api-go.exe" : "api-go"),
      cwd: "./backend/gateway",
      instances: 1,
      interpreter: "none",
      autorestart: true,
      watch: false,
      max_memory_restart: "128M",
      restart_delay: 2000,
      max_restarts: 20,
      error_file: "./logs/go-error.log",
      out_file: "./logs/go-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "finverify-frontend",
      script: "pnpm",
      args: "--filter @workspace/finverify-os run dev",
      cwd: __dirname,
      instances: 1,
      interpreter: "none",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      restart_delay: 3000,
      max_restarts: 10,
      env: {
        NODE_ENV: "development",
        PORT: "21950",
      },
      error_file: "./logs/frontend-error.log",
      out_file: "./logs/frontend-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
