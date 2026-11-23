-- SonarQube built-in tool.
--
-- Unlike the other tools this one is orchestrated by sechub (see src/lib/sonar.ts):
-- the scanner only uploads, the server computes asynchronously and the findings
-- are pulled from the Web API. The command below is the scanner step — it's what
-- the run confirmation shows and what the audit trail stores; the host, token and
-- project key are injected at run time.
INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at) VALUES
 ('sonarqube','SonarQube','tool','docker','local','[]',
  'docker run --rm --network sechub-sonar -e SONAR_HOST_URL=<sonar> -e SONAR_TOKEN=*** -v "{path}:/usr/src" sonarsource/sonar-scanner-cli -Dsonar.projectKey=sechub-<project>',
  'sonarqube',1,1,
  'Bugs, code smells, vulnerabilities and security hotspots across 21 languages. sechub runs the SonarQube Community Build container for you (Docker required).',
  0,0);
