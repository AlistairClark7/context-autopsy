import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// VS Code and its forks all keep extension data under <config>/<App>/User/globalStorage.
const APPS = ['Code', 'Code - Insiders', 'Code - OSS', 'VSCodium', 'Cursor', 'Windsurf', 'Trae', 'Kiro', 'Positron'];
// Remote / WSL / SSH servers keep their own copy.
const SERVERS = ['.vscode-server', '.vscode-server-insiders', '.cursor-server', '.windsurf-server'];

function configRoots() {
  const home = homedir();
  if (process.platform === 'darwin') return [join(home, 'Library', 'Application Support')];
  if (process.platform === 'win32') return [process.env.APPDATA || join(home, 'AppData', 'Roaming')];
  return [process.env.XDG_CONFIG_HOME || join(home, '.config')];
}

/** Every existing <editor>/User/globalStorage directory, with the editor's name. */
export function globalStorageDirs() {
  const out = [];
  for (const root of configRoots()) {
    for (const app of APPS) {
      const dir = join(root, app, 'User', 'globalStorage');
      if (existsSync(dir)) out.push({ app, dir });
    }
  }
  for (const server of SERVERS) {
    const dir = join(homedir(), server, 'data', 'User', 'globalStorage');
    if (existsSync(dir)) out.push({ app: server, dir });
  }
  return out;
}
