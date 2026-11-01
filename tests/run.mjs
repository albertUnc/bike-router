// Runs all checks in Node: `node tests/run.mjs`. Exits with code 1 if any check fails.
import { runChecks } from './checks.js';
import { runRouteChecks } from './checks-routes.js';
import { runRideChecks } from './checks-rides.js';
import { runStravaChecks } from './checks-strava.js';

const results = [...runChecks(), ...(await runRouteChecks()), ...runRideChecks(), ...(await runStravaChecks())];
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
