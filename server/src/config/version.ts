import fs from "node:fs";

/** The manager's own version, from the server package.json (next to dist/ in the image, one level up in dev). */
export const APP_VERSION: string = (() => {
  for (const candidate of ["../../package.json", "../package.json"]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL(candidate, import.meta.url), "utf8")) as { name?: string; version?: string };
      if (pkg.version && pkg.name === "server") return pkg.version;
    } catch {
      // try the next location
    }
  }
  return "unknown";
})();
