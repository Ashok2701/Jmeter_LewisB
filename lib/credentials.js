import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { CREDENTIAL_GROUPS } from './applications.js';
import { CREDENTIALS_FILE, USERS_CSV_DIR } from './config.js';

// The logins REST and SOAP runs authenticate with, saved under Configuration.
//
// Storage: webapp\.credentials.json (git-ignored). The username is kept as
// plain text; the PASSWORD is encrypted with Windows DPAPI (CurrentUser), so
// the file is useless on another machine or under another Windows account, and
// a copy of it - in a backup, a chat, a repository - does not reveal the
// password. It is decrypted only at the moment a run starts, to hand it to the
// existing JMeter flow as LOGIN_PASSWORD, and it is never returned by any API.
//
// A group holds one or more logins (multi-user runs). Each save also rewrites
// the group's users CSV (webapp\credentials\<group>.csv, git-ignored) from this
// store, and so does every run start, so the CSV JMeter reads can never drift
// from what Configuration shows. The CSV is a derived copy and necessarily
// holds passwords in plain text, because JMeter cannot read DPAPI.
//
// The password travels to and from PowerShell as base64 on stdin/stdout, never
// on a command line (which any process on the machine can read).

const ENTROPY = 'jmeter-webapp-credentials';

const PROTECT_SCRIPT =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
  `$e=[Security.Cryptography.ProtectedData]::Protect($b,[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'),[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  '[Convert]::ToBase64String($e)';

const UNPROTECT_SCRIPT =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
  `$d=[Security.Cryptography.ProtectedData]::Unprotect($b,[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'),[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  '[Convert]::ToBase64String($d)';

function powershell(script, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timed out'));
    }, 20000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Only PowerShell's own error text is ever surfaced - never the input.
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim().split(/\r?\n/)[0] || `PowerShell exited with code ${code}`));
    });
    child.stdin.end(stdinText);
  });
}

async function protect(plain) {
  return powershell(PROTECT_SCRIPT, Buffer.from(plain, 'utf8').toString('base64'));
}

async function unprotect(blob) {
  const base64 = await powershell(UNPROTECT_SCRIPT, blob);
  return Buffer.from(base64, 'base64').toString('utf8');
}

async function readStore() {
  try {
    const parsed = JSON.parse(await fsp.readFile(CREDENTIALS_FILE, 'utf8'));
    return parsed && typeof parsed.groups === 'object' && parsed.groups ? parsed : { version: 1, groups: {} };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, groups: {} };
    throw err;
  }
}

// Saves are serialised so two at once cannot overwrite each other's group.
let queue = Promise.resolve();
function exclusive(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

// A group's saved logins, oldest format included: before multi-user support a
// group was a single { username, password } and that is treated as user 1.
function storedUsers(saved) {
  if (!saved) return [];
  const list = Array.isArray(saved.users) ? saved.users : [saved];
  return list.filter((u) => u?.username && u?.password);
}

function publicGroup(group, saved) {
  const users = storedUsers(saved);
  return {
    id: group.id,
    label: group.label,
    applications: group.applications,
    usedFor: group.usedFor,
    usersCsv: group.usersCsv,
    // Usernames only - a password is never returned. `username` / `configured`
    // describe user 1, which is the login a single-user run uses.
    users: users.map((u) => ({ username: u.username })),
    username: users[0]?.username ?? '',
    configured: users.length > 0,
    updatedAt: saved?.updatedAt ?? null,
  };
}

const csvField = (value) => `"${String(value).replace(/"/g, '""')}"`;

/**
 * Writes a group's logins to its users CSV for JMeter (header
 * LOGIN_USERNAME,LOGIN_PASSWORD - the names the JMeter scripts already use).
 * Fully quoted, so a password containing commas or quotes survives; written to
 * a temporary file first so a run reading it never sees a half-written file.
 * Returns the file's absolute path.
 */
export async function writeUsersCsv(group, users) {
  const file = path.join(USERS_CSV_DIR, group.usersCsv);
  const lines = ['LOGIN_USERNAME,LOGIN_PASSWORD', ...users.map((u) => `${csvField(u.username)},${csvField(u.password)}`)];
  await fsp.mkdir(USERS_CSV_DIR, { recursive: true });
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, `${lines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temp, file);
  return file;
}

/** Every credential group with its username and whether a password is saved - never the password. */
export async function listCredentialGroups() {
  const store = await readStore();
  return CREDENTIAL_GROUPS.map((group) => publicGroup(group, store.groups[group.id]));
}

/**
 * Saves one group's logins: `users` is [{ username, password }] in order (user
 * 1 first). An empty password keeps the one already saved at that position, so
 * a username can be changed on its own. The group's users CSV is rewritten
 * from the result. Returns the group's public view.
 */
export function saveCredentials(groupId, users) {
  return exclusive(async () => {
    const group = CREDENTIAL_GROUPS.find((g) => g.id === groupId);
    if (!group) throw new Error('Unknown credential group.');

    const store = await readStore();
    const existing = storedUsers(store.groups[groupId]);
    const saved = [];
    for (const [i, user] of users.entries()) {
      const encrypted = user.password ? await protect(user.password) : existing[i]?.password;
      if (!encrypted) throw new Error(`A password is required for user ${i + 1}.`);
      saved.push({ username: user.username, password: encrypted });
    }

    store.groups[groupId] = { users: saved, updatedAt: new Date().toISOString() };

    // Written to a temporary file first, so a crash mid-write cannot leave a
    // half-written (and therefore unreadable) credentials file behind.
    const temp = `${CREDENTIALS_FILE}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(temp, CREDENTIALS_FILE);

    try {
      await writeUsersCsv(group, await decryptUsers(saved));
    } catch (err) {
      const e = new Error(err.message);
      e.userMessage = `The credentials were saved, but ${group.usersCsv} could not be updated: ${err.message}`;
      throw e;
    }
    return publicGroup(group, store.groups[groupId]);
  });
}

function decryptUsers(saved) {
  return Promise.all(
    saved.map(async (u) => ({ username: u.username, password: await unprotect(u.password) }))
  );
}

/**
 * The saved logins for a group, decrypted, for handing to a run. `username` /
 * `password` are user 1 (what a single-user run and the .bat files use);
 * `users` is every login, in order, for the users CSV.
 * { ok: true, username, password, users } | { ok: false, reason: 'missing' | 'unreadable' }
 */
export async function loadCredentials(groupId) {
  let saved;
  try {
    saved = storedUsers((await readStore()).groups[groupId]);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!saved.length) return { ok: false, reason: 'missing' };
  try {
    const users = await decryptUsers(saved);
    return { ok: true, username: users[0].username, password: users[0].password, users };
  } catch {
    // Saved by another Windows user or on another machine, or damaged.
    return { ok: false, reason: 'unreadable' };
  }
}