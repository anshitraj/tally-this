import pino from "pino";
import { scrubValue } from "./scrub";

const isProduction = [process.env.NODE_ENV, process.env.APP_ENV].some(value => value?.trim().toLowerCase() === "production");

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  // Every logged value is scrubbed, so a database or provider error cannot print a connection string or key.
  formatters: {
    log: object => scrubValue(object) as Record<string, unknown>,
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
