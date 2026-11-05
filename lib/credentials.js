import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { CREDENTIAL_GROUPS } from './applications.js';
import { CREDENTIALS_FILE, USERS_CSV_DIR } from './config.js';
import { parseCsv } from './csvSchema.js';

// The logins REST and SOAP runs authenticate with, saved under Configuration.
//
// Groups marked `fileBacked` (all of them today) read their users straight from
// a CSV in webapp\credentials\ (git-ignored): LOGIN_USERNAME and LOGIN_PASSWORD
// columns, optional Role/Application columns. The file is the source of truth;
// the app never rewrites it and never returns a password from it.
//
// Other groups would use the older store: webapp\.credentials.json (git-ignored).
// The username is kept as plain text; the PASSWORD is encrypted with Windows
// DPAPI (CurrentUser), so the file is useless on another machine or under
// another Windows account. It is decrypted only at the moment a run starts, to
// hand it to the existing JMeter flow as LOGIN_PASSWORD, and it is never
// returned by any API. Each save there also rewrites the group's users CSV from
// the store (a derived copy that necessarily holds plain-text passwords,
// because JMeter cannot read DPAPI).
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
 * Writes `users` (LOGIN_USERNAME,LOGIN_PASSWORD - the header the JMeter
 * scripts already read) to `file`. Fully quoted, so a password containing
 * commas or quotes survives; written to a temporary file first so a run
 * reading it never sees a half-written file. Returns the file's absolute path.
 */
async function writeUsersCsvFile(file, users) {
  const lines = ['LOGIN_USERNAME,LOGIN_PASSWORD', ...users.map((u) => `${csvField(u.username)},${csvField(u.password)}`)];
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, `${lines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temp, file);
  return file;
}

/** Writes a group's full set of logins to its persistent users CSV (webapp\credentials\<group>.csv). */
export async function writeUsersCsv(group, users) {
  return writeUsersCsvFile(path.join(USERS_CSV_DIR, group.usersCsv), users);
}

/**
 * Writes the Number-of-Users-limited login list for one run into that run's
 * own directory (test-runs\<runId>\run-users.csv), so LOGIN_USERS_CSV for
 * this run only ever contains the users actually selected in the UI - the
 * group's persistent CSV (and Configuration's view of it) is untouched.
 */
export async function writeRunUsersCsv(runDir, users) {
  return writeUsersCsvFile(path.join(runDir, 'run-users.csv'), users);
}

/**
 * A file-backed group's users, read from its CSV in credentials\ (a header row
 * with LOGIN_USERNAME and LOGIN_PASSWORD, optional Role). Rows missing either
 * value are skipped. Returns [{ username, password, role }]; [] if no file.
 */
async function readFileUsers(group) {
  let text;
  try {
    text = await fsp.readFile(path.join(USERS_CSV_DIR, group.usersCsv), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const [header = [], ...rows] = parseCsv(text.replace(/^﻿/, ''));
  const col = (name) => header.findIndex((h) => h.trim().toUpperCase() === name);
  const u = col('LOGIN_USERNAME');
  const p = col('LOGIN_PASSWORD');
  const r = col('ROLE');
  if (u === -1 || p === -1) {
    throw new Error(`${group.usersCsv} needs LOGIN_USERNAME and LOGIN_PASSWORD columns.`);
  }
  return rows
    .map((row) => ({
      username: (row[u] ?? '').trim(),
      password: row[p] ?? '',
      role: r === -1 ? '' : (row[r] ?? '').trim(),
    }))
    .filter((x) => x.username && x.password);
}

async function fileGroupView(group) {
  let users = [];
  let fileError = null;
  try {
    users = await readFileUsers(group);
  } catch (err) {
    fileError = err.message;
  }
  const stat = await fsp.stat(path.join(USERS_CSV_DIR, group.usersCsv)).catch(() => null);
  return {
    id: group.id,
    label: group.label,
    applications: group.applications,
    usedFor: group.usedFor,
    usersCsv: group.usersCsv,
    fileBacked: true,
    fileError,
    // Username and role only - a password is never returned.
    users: users.map((x) => ({ username: x.username, role: x.role })),
    username: users[0]?.username ?? '',
    configured: users.length > 0,
    updatedAt: stat ? stat.mtime.toISOString() : null,
  };
}

/** Every credential group with its username and whether a password is saved - never the password. */
export async function listCredentialGroups() {
  const store = await readStore();
  return Promise.all(
    CREDENTIAL_GROUPS.map((group) =>
      group.fileBacked ? fileGroupView(group) : publicGroup(group, store.groups[group.id])
    )
  );
}

/**
 * Saves one group's logins: `users` is [{ username, password }] in order (user
 * 1 first). An empty password keeps the one already saved at that position, so
 * a username can be changed on its own. The group's users CSV is rewritten
 * from the result. Returns the group's public view. File-backed groups are
 * edited as files and cannot be saved this way.
 */
export function saveCredentials(groupId, users) {
  return exclusive(async () => {
    const group = CREDENTIAL_GROUPS.find((g) => g.id === groupId);
    if (!group) throw new Error('Unknown credential group.');
    if (group.fileBacked) throw new Error(`${group.usersCsv} is edited as a file, not from the app.`);

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
  const fileGroup = CREDENTIAL_GROUPS.find((g) => g.id === groupId && g.fileBacked);
  if (fileGroup) {
    try {
      const users = await readFileUsers(fileGroup);
      if (!users.length) return { ok: false, reason: 'missing' };
      return { ok: true, username: users[0].username, password: users[0].password, users };
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }

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
