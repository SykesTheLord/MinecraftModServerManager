-- Optional time-of-day window for automatic modpack updates: only install
-- between update_window_start and update_window_end ("HH:MM", may cross
-- midnight) in update_window_tz (IANA zone, e.g. "Europe/London"). NULL = any time.
ALTER TABLE instance ADD COLUMN update_window_start TEXT;
ALTER TABLE instance ADD COLUMN update_window_end TEXT;
ALTER TABLE instance ADD COLUMN update_window_tz TEXT;
