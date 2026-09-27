import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { env } from "../config/env.js";

fs.mkdirSync(env.LOGS_DIR, { recursive: true });

export const appLogger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    // pino-http logs full request/response headers; without this every
    // request writes the caller's live session cookie into logs/app.log (a
    // deliberately browsable host file), where anyone who can read it can
    // replay it and act as that user.
    redact: {
      paths: [
        "req.headers.cookie",
        "req.headers.authorization",
        'req.headers["proxy-authorization"]',
        'res.headers["set-cookie"]',
      ],
      censor: "[redacted]",
    },
  },
  pino.transport({
    targets: [
      {
        target: "pino/file",
        options: { destination: path.join(env.LOGS_DIR, "app.log"), mkdir: true },
        level: "info",
      },
      {
        target: "pino-pretty",
        options: { colorize: true },
        level: "info",
      },
    ],
  })
);
