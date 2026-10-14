import { findClaudeFiles, parseClaude } from './claude.js';
import { findCodexFiles, parseCodex } from './codex.js';
import { findClineFiles, parseCline } from './cline.js';
import { findCursorFiles, parseCursor } from './cursor.js';
import { findOpenCodeFiles, parseOpenCode } from './opencode.js';
import { findClineSdkFiles, parseClineSdk, findDroidFiles, parseDroid, findAmpFiles, parseAmp } from './more.js';
import { findGooseFiles, parseGoose } from './goose.js';
import { findPiFiles, parsePi } from './pi.js';
import { findGeminiFiles, parseGemini } from './gemini.js';
import { findQwenFiles, parseQwen } from './qwen.js';

/**
 * Every supported agent. `find()` lists its transcripts on this machine as
 * [{ agent, file, mtime }] (sync or async); `parse(file)` turns one into a context event stream.
 */
export const SOURCES = [
  { id: 'claude', name: 'Claude Code', find: findClaudeFiles, parse: parseClaude },
  { id: 'codex', name: 'Codex', find: findCodexFiles, parse: parseCodex },
  { id: 'cursor', name: 'Cursor', find: findCursorFiles, parse: parseCursor },
  { id: 'opencode', name: 'OpenCode', find: () => findOpenCodeFiles('opencode'), parse: (f) => parseOpenCode(f, 'opencode') },
  { id: 'pi', name: 'Pi', find: findPiFiles, parse: parsePi },
  { id: 'gemini', name: 'Gemini CLI', find: findGeminiFiles, parse: parseGemini },
  { id: 'qwen', name: 'Qwen Code', find: findQwenFiles, parse: parseQwen },
  // Cline: legacy per-task folders plus the newer SDK session files.
  { id: 'cline', name: 'Cline', find: () => [...findClineFiles('cline'), ...findClineSdkFiles()], parse: (f) => (f.endsWith('.messages.json') ? parseClineSdk(f) : parseCline(f, 'cline')) },
  { id: 'roo', name: 'Roo Code', find: () => findClineFiles('roo'), parse: (f) => parseCline(f, 'roo') },
  // Kilo Code: ≤5.x used Roo's task folders; 7.x is an OpenCode fork.
  { id: 'kilo', name: 'Kilo Code', find: async () => [...findClineFiles('kilo'), ...(await findOpenCodeFiles('kilo'))], parse: (f) => (f.endsWith('api_conversation_history.json') ? parseCline(f, 'kilo') : parseOpenCode(f, 'kilo')) },
  { id: 'droid', name: 'Factory Droid', find: findDroidFiles, parse: parseDroid },
  { id: 'amp', name: 'Amp', find: findAmpFiles, parse: parseAmp },
  { id: 'goose', name: 'Goose', find: findGooseFiles, parse: parseGoose },
];

export const AGENT_NAME = Object.fromEntries(SOURCES.map((s) => [s.id, s.name]));

export function sourceFor(agent) {
  return SOURCES.find((s) => s.id === agent);
}

/** Guesses the agent for a file passed on the command line. */
export function detectAgent(file) {
  if (/\/\.codex\/|rollout-[^/]*\.jsonl$/.test(file)) return 'codex';
  if (/\/\.pi\/|\d{4}-\d\d-\d\dT[\d-]+Z_[^/]+\.jsonl$/.test(file)) return 'pi';
  if (/\/\.gemini\//.test(file)) return 'gemini';
  if (/\/\.qwen\//.test(file)) return 'qwen';
  if (/\.messages\.json$/.test(file)) return 'cline';
  if (/\/\.factory\//.test(file)) return 'droid';
  if (/\/T-[^/]+\.json$/.test(file)) return 'amp';
  if (/api_conversation_history\.json$/.test(file)) {
    if (file.includes('rooveterinaryinc.roo-cline')) return 'roo';
    if (file.includes('kilocode.kilo-code')) return 'kilo';
    return 'cline';
  }
  return 'claude';
}
