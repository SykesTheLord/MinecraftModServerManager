import session from "express-session";

// Sessions are kept in-memory: acceptable at this tool's scale (single
// process, a handful of admins), with the tradeoff that everyone is logged
// out if the manager restarts. Held as an explicit instance (rather than
// express-session's implicit default) so sessions can be revoked.
export const sessionStore = new session.MemoryStore();

/** Destroys every session belonging to a user, except (optionally) the caller's own. */
export function revokeUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sessionStore.all((err, sessions) => {
      if (err) return reject(err);
      const ids = Object.entries(sessions ?? {})
        .filter(([sid, data]) => sid !== exceptSessionId && (data as { userId?: string }).userId === userId)
        .map(([sid]) => sid);
      for (const sid of ids) sessionStore.destroy(sid);
      resolve();
    });
  });
}
