-- The stack tags a tool declares are matched against the tags a project is
-- detected with, so both sides have to speak the same words. ESLint shipped
-- with "js" and "ts", which nothing ever detects, leaving it looking
-- inapplicable to every TypeScript project that does not also use React.
--
-- Only the untouched built-in row is corrected: a stack the user edited is
-- their answer, not ours.
UPDATE tools
   SET stack = '["node","typescript","react"]'
 WHERE id = 'eslint'
   AND builtin = 1
   AND stack = '["js","ts","react"]';
