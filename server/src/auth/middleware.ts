import type { NextFunction, Request, Response } from "express";
import { userRepo, type UserRow } from "../db/repositories/userRepo.js";
import { hasInstanceRole } from "./userService.js";
import type { InstanceRole } from "../db/repositories/instanceAccessRepo.js";
import { routeParam } from "../http/errors.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const userId = req.session.userId;
  const user = userId ? userRepo.findById(userId) : undefined;
  if (!user) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }
  req.user = user;
  next();
}

export function requireSuperadmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.global_role !== "superadmin") {
    res.status(403).json({ error: "Superadmin access required." });
    return;
  }
  next();
}

/** Reads :id from the route params as the instance id being acted on. */
export function requireInstanceRole(minRole: InstanceRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const instanceId = routeParam(req, "id");
    if (!req.user || !hasInstanceRole(req.user, instanceId, minRole)) {
      res.status(403).json({ error: "You do not have access to this instance." });
      return;
    }
    next();
  };
}
