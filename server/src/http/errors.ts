import type { ErrorRequestHandler, Request } from "express";
import { appLogger } from "../logging/appLogger.js";

/** An error that carries the HTTP status it should be reported with. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Route params as a checked string. Express 5's types allow any param to be
 * `string | string[]` (wildcard params capture arrays); none of our routes use
 * wildcards, but this keeps that assumption checked rather than cast away.
 */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new HttpError(400, `Missing route parameter "${name}".`);
  return value;
}

/**
 * Final JSON error handler. Express 5 forwards rejected promises from async
 * handlers here on its own, so async routes need no wrapper — just throw
 * (ideally an HttpError). HttpErrors keep their status, anything else is a
 * logged 500.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // http-errors style (e.g. express.json() rejecting a malformed body with 400).
  if (err?.expose === true && typeof err.status === "number") {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // Internal details (Docker/SQLite messages, paths) go to the log, not the client.
  appLogger.error({ err, method: req.method, url: req.originalUrl }, "unhandled request error");
  res.status(500).json({ error: "Internal server error." });
};
