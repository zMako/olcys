-- OŁCyŚ schema, part 18: where a case stands.

-- A case moves from being opened, through analysis, to a request sent to whoever knows the owner, an answer,
-- and closing. The analyst sets the status; the tool only records it and when it changed.
ALTER TABLE cases ADD COLUMN status text NOT NULL DEFAULT 'new';
ALTER TABLE cases ADD COLUMN status_at text;
-- Cases analysed before this column existed are past the first step.
UPDATE cases SET status = 'in_analysis' WHERE EXISTS (SELECT 1 FROM runs r WHERE r.case_id = cases.id);
