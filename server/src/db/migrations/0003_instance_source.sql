-- Where an instance's server files came from: 'ftb' (installed by itzg from
-- the FTB catalog via TYPE=FTBA) or 'import' (an existing server's files
-- copied into its volume). Imported instances run with the itzg TYPE/version
-- env stored in server_env (JSON object) instead of the FTB ids, which are 0.
ALTER TABLE instance ADD COLUMN source TEXT NOT NULL DEFAULT 'ftb' CHECK (source IN ('ftb', 'import'));
ALTER TABLE instance ADD COLUMN server_env TEXT;
