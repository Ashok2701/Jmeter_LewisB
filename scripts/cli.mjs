// Shared helpers for the user-management CLI scripts (create-user, delete-user).

import readline from 'node:readline';

export { loadDotEnv } from './env.mjs';

// One shared reader (so piped input works too). While `muted`, typed characters
// are not echoed - used for the password prompts.
let muted = false;
export const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY),
});
rl._writeToOutput = (text) => {
  if (!muted) process.stdout.write(text);
};
const lines = rl[Symbol.asyncIterator]();
rl.on('SIGINT', () => {
  process.stdout.write('\nCancelled.\n');
  process.exit(1);
});

export async function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  muted = hidden;
  const { value, done } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  if (done) throw new Error('Input ended before all values were entered.');
  return value;
}
