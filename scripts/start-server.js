import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, sep } from 'path';
import { platform } from 'process';

const requirementsPath = join(process.cwd(), 'api', 'requirements.txt');
const appPath          = join(process.cwd(), 'api', 'app.py');

// Prefer the project's own venv so we always use its pip, not the system one.
const isWin = platform === 'win32';
const venvPython = isWin
  ? join(process.cwd(), 'venv', 'Scripts', 'python.exe')
  : join(process.cwd(), 'venv', 'bin', 'python');

const fallbackCommands = ['python3', 'python', 'py'];

async function trySpawn(cmd, args) {
  return new Promise(resolve => {
    try {
      const p = spawn(cmd, args);
      p.on('exit', code => resolve(code === 0));
      p.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

async function findPython() {
  // 1. Use the project venv if it exists
  if (existsSync(venvPython)) {
    const ok = await trySpawn(venvPython, ['--version']);
    if (ok) {
      console.log(`[server] Using venv Python: ${venvPython}`);
      return venvPython;
    }
  }

  // 2. Fall back to any Python on PATH
  for (const cmd of fallbackCommands) {
    const ok = await trySpawn(cmd, ['--version']);
    if (ok) {
      console.log(`[server] Using system Python: ${cmd}`);
      return cmd;
    }
  }

  throw new Error(
    'Python not found.\n' +
    'Run:  python -m venv venv  &&  venv\\Scripts\\activate  &&  pip install -r api\\requirements.txt\n' +
    'then restart the server.'
  );
}

function spawnLogged(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`));
    p.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`));
    p.on('exit',  code => code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}`)));
    p.on('error', err  => reject(err));
  });
}

async function installRequirements(pythonCmd) {
  if (!existsSync(requirementsPath)) {
    throw new Error(`requirements.txt not found at ${requirementsPath}`);
  }

  // Upgrade pip first so it can handle modern packages (anthropic, sentence-transformers, etc.)
  console.log('[server] Upgrading pip...');
  await spawnLogged(pythonCmd, ['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip-upgrade')
    .catch(() => console.warn('[server] pip upgrade failed (non-fatal, continuing)'));

  console.log('[server] Installing backend dependencies...');
  await spawnLogged(
    pythonCmd,
    ['-m', 'pip', 'install', '-r', requirementsPath],
    'pip-install'
  );
}

async function startServer(pythonCmd) {
  if (!existsSync(appPath)) {
    throw new Error(`app.py not found at ${appPath}`);
  }

  console.log('[server] Starting Flask server...');
  const server = spawn(pythonCmd, [appPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  server.stdout.on('data', d => process.stdout.write(`[flask] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`[flask] ${d}`));

  server.on('exit', code => {
    if (code !== 0) {
      console.error(`[server] Flask exited with code ${code}`);
      process.exit(code);
    }
  });

  server.on('error', err => {
    console.error(`[server] Failed to start Flask: ${err.message}`);
    process.exit(1);
  });
}

async function main() {
  try {
    const pythonCmd = await findPython();
    await installRequirements(pythonCmd);
    await startServer(pythonCmd);
  } catch (err) {
    console.error(`[server] Fatal: ${err.message}`);
    process.exit(1);
  }
}

main();
