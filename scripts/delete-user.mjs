// Backend-only CLI:  npm run delete-user
//
// Deletes one user (and their sessions) from the database the DB_* settings
// point to - the same database `npm run create-user` writes to. Asks for the
// exact username and a typed confirmation first. No HTTP endpoint exists for this.

import { closePool, getDbConfig } from '../lib/db.js';
import { deleteUser, listUsers } from '../lib/authCore.js';
import { ask, loadDotEnv, rl } from './cli.mjs';

async function main() {
  loadDotEnv();

  const { host, port, database } = getDbConfig();
  console.log(`Database: ${database} on ${host}:${port}\n`);

  const users = await listUsers();
  if (users.length === 0) throw new Error('There are no users in this database.');
  console.log('Existing users: ' + users.map((u) => u.username + '').join(', ') + '\n');

  const username = (await ask('Username to delete: ')).trim();
  if (!username) throw new Error('Username must not be empty.');

  const answer = (await ask(`Type the username again to permanently delete "${username}": `)).trim();
  if (answer !== username) throw new Error('Confirmation did not match. No user was deleted.');

  if (!(await deleteUser(username))) throw new Error(`User "${username}" was not found. Nothing was deleted.`);
  console.log(`\nUser "${username}" deleted from ${database}`);
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
