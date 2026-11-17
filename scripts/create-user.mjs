// Backend-only CLI:  npm run create-user
//
// The same command is used on every machine. Which database receives the user
// is decided solely by the DB_* settings in that machine's .env (or the process
// environment). There is no HTTP endpoint for this - it needs shell access.

import { closePool, getDbConfig } from '../lib/db.js';
import { createUser } from '../lib/authCore.js';
import { ask, loadDotEnv, rl } from './cli.mjs';

async function main() {
  loadDotEnv();

  const { host, port, database } = getDbConfig(); // throws a clear error if missing/invalid
  console.log(`Database: ${database} on ${host}:${port}\n`);

  const username = (await ask('Username: ')).trim();
  const password = await ask('Password: ', { hidden: true });
  const confirm = await ask('Confirm Password: ', { hidden: true });

  if (!username) throw new Error('Username must not be empty.');
  if (!password) throw new Error('Password must not be empty.');
  if (password !== confirm) throw new Error('Passwords do not match. No user was created.');

  const result = await createUser(username, password);
  if (!result.ok) throw new Error(result.error);

  console.log(`\nUser "${username}" created (id ${result.id}) in ${database}`);
}

main()
  .catch((err) => {
    console.error(`\nERROR: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    rl.close();
    await closePool();
  });
