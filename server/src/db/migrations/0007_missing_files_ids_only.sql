-- CurseForge's API terms forbid saving API data. Files an install waits for
-- used to be stored with their mod names, page links and checksums; keep only
-- what the installer needs (file id and file name) — the rest is looked up
-- live from CurseForge when shown or when an upload is checked.
UPDATE instance
SET missing_files = (
  SELECT json_group_array(json_object('fileId', json_extract(value, '$.fileId'), 'fileName', json_extract(value, '$.fileName')))
  FROM json_each(instance.missing_files)
)
WHERE missing_files IS NOT NULL;
