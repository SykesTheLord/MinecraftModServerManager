-- Imported servers can be linked to the modpack they are (FTB or CurseForge):
-- pack_link says which, the pack/version ids go in the existing ftb_* / cf_*
-- columns, linked_pack_name holds the pack's name for display, and
-- pack_version_name the version's. The server keeps running exactly what was
-- imported; the link lets it be checked for updates, and the first update
-- converts it (source becomes pack_link) to run the pack itself. NULL for
-- everything else.
ALTER TABLE instance ADD COLUMN pack_link TEXT CHECK (pack_link IN ('ftb', 'curseforge'));
ALTER TABLE instance ADD COLUMN linked_pack_name TEXT;
