/**
 * One-time admin provisioning:  npm run admin:create -- --email owner@example.com --name "Owner"
 * The password is read from the ADMIN_PASSWORD env var or typed at a hidden prompt — it is never
 * accepted as a command-line argument (which would land in shell history / process lists).
 * There is intentionally no HTTP endpoint that can create admins.
 */
import readline from 'node:readline';
import { closePool } from '../db/pool.js';
import { provisionAdmin } from '../services/auth.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = (rl as any)._writeToOutput;
    process.stdout.write(question);
    (rl as any)._writeToOutput = (s: string) => {
      if (s.includes('\n') || s.includes('\r')) w.call(rl, s);
    };
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a))));
}

async function main() {
  const email = arg('email') ?? process.env.ADMIN_EMAIL ?? (await promptLine('Admin email: '));
  const fullName = arg('name') ?? process.env.ADMIN_NAME ?? (await promptLine('Full name: '));
  const role = (arg('role') ?? 'admin') as 'admin' | 'staff';
  const password = process.env.ADMIN_PASSWORD ?? (await promptHidden('Password (min 12 chars): '));
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Invalid email address.');
  if (password.length < 12) throw new Error('Admin password must be at least 12 characters.');
  if (!['admin', 'staff'].includes(role)) throw new Error('Role must be admin or staff.');
  const user = await provisionAdmin({ email, fullName, password, role });
  console.log(`\n${role} account ready for ${user.email}. Sign in at /admin/login.`);
}

main()
  .catch((e) => {
    console.error(`Failed: ${e.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
