import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runRunner, runnerErrorMessage } from '../bootstrap/runner.js';

// Do not load the audited repository's .env. CI variables are the only inputs.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRunner().then((result) => {
    if ('notificationStatus' in result && result.notificationStatus === 'failed') process.exitCode = 1;
  }).catch((error) => {
    console.error(`Review failed: ${runnerErrorMessage(error, process.env)}`);
    process.exitCode = 1;
  });
}
