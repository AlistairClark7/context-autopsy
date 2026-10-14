// Buckets every piece of context into one category. Order matters: the first
// matching rule wins, so the more specific "plumbing" rules come before the
// generic "reading code" ones.

export const CATEGORIES = {
  overhead: { label: 'Fixed overhead', hint: 'system prompt, tool schemas, injected instructions & reminders' },
  conversation: { label: 'Conversation', hint: 'your prompts and the model\'s replies' },
  thinking: { label: 'Reasoning', hint: 'the model\'s thinking blocks' },
  code_read: { label: 'Reading code', hint: 'source files, search results, directory listings' },
  code_write: { label: 'Writing code', hint: 'edits, patches and new files' },
  build: { label: 'Build, test & run output', hint: 'installs, compilers, test runners, linters, dev servers' },
  env: { label: 'Environment & infrastructure', hint: 'docker, k8s, cloud CLIs, env vars, ports, infra config files' },
  git: { label: 'Git & version control', hint: 'git and gh commands' },
  web: { label: 'Web & docs lookups', hint: 'web search, fetched pages, curl' },
  browser: { label: 'Browser & UI checks', hint: 'driving a browser or screenshots to check the running app' },
  agents: { label: 'Subagents & coordination', hint: 'spawning, messaging and waiting on other agents' },
  other: { label: 'Other tool output', hint: 'MCP tools, browsers, misc shell' },
};

export const PLUMBING = ['build', 'env'];

const ENV_CMD = new RegExp(
  '\\b(' +
    [
      'docker', 'docker-compose', 'podman', 'colima', 'kubectl', 'k9s', 'helm', 'kustomize', 'minikube', 'k3d', 'argocd',
      'terraform', 'tofu', 'terragrunt', 'pulumi', 'cdk', 'cdktf', 'serverless', 'aws', 'gcloud', 'gsutil', 
      'flyctl', 'vercel', 'netlify', 'heroku', 'railway', 'wrangler', 'supabase', 'firebase', 'doctl',
      'ssh', 'scp', 'rsync', 'lsof', 'netstat', 'telnet', 'systemctl', 'launchctl', 'journalctl', 
      'brew', 'apt', 'apt-get', 'yum', 'dnf', 'apk', 'nvm', 'pyenv', 'rbenv', 'asdf', 'mise', 'direnv', 'volta', 'corepack',
      'printenv', 'psql', 'mysql', 'redis-cli', 'mongosh', 'sqlite3', 'ngrok', 'openssl', 'keytool', 'sudo',
      'chmod', 'chown', 'ulimit', 'mkcert', 'dig', 'nslookup', 'ping', 'traceroute', 'vault', 'sops', 'ansible', 'nix',
    ].join('|') +
    ')\\b(?![-.\\w]*\\.(?:ts|js|tsx|jsx|py|go|rs|md)\\b)',
);
const ENV_HINTS = /(^|[\s"'=/])(export\s+[A-Z_]+=|env\s*(\||$)|\.env(\.\w+)?\b|localhost:\d+|127\.0\.0\.1:\d+|0\.0\.0\.0:\d+|kill\s+-9|pkill|killall|ps\s+aux|DOCKER_|KUBECONFIG|AWS_PROFILE)/m;

const BUILD_CMD = new RegExp(
  '\\b(' +
    [
      'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'deno', 'pip', 'pip3', 'poetry', 'uv', 'uvx', 'pipenv', 'conda', 'cargo', 'rustc', 'rustup',
      'make', 'cmake', 'ninja', 'bazel', 'gradle', 'gradlew', 'mvn', 'tsc', 'jest', 'vitest', 'pytest', 'mocha', 'ava', 'playwright', 'cypress',
      'eslint', 'prettier', 'biome', 'ruff', 'mypy', 'pyright', 'black', 'flake8', 'pylint', 'clippy', 'dotnet', 'msbuild', 'nuget', 'bundle', 'rake', 'rspec',
      'mix', 'xcodebuild', 'swift', 'moon', 'turbo', 'nx', 'lerna', 'webpack', 'vite', 'esbuild', 'rollup', 'tox', 'nox', 'composer', 'phpunit',
      'golangci-lint', 'gofmt', 'node', 'python', 'python3', 'ruby', 'java', 'javac', 'gcc', 'clang', 'next', 'nuxt', 'expo', 'flutter', 'dart',
    ].join('|') +
    ')\\b',
);
const GO_BUILD = /\bgo\s+(build|test|mod|run|vet|install|get|generate)\b/;

const GIT_CMD = /\b(git|gh|glab|hub)\s/;
const READ_CMD = /\b(cat|sed|head|tail|less|more|grep|rg|ag|ack|find|fd|ls|tree|wc|awk|jq|yq|bat|stat|file|diff|cut|sort|uniq|xxd|nl)\b/;
const WEB_CMD = /\b(curl|wget|http|httpie|xh)\b/;

// Config files whose contents are about *running* the app rather than the app itself.
const INFRA_PATH = new RegExp(
  [
    '(^|/)Dockerfile[^/]*$', '(^|/)\\.?docker-compose[^/]*\\.ya?ml$', '(^|/)compose\\.ya?ml$', '(^|/)\\.dockerignore$',
    '\\.tf$', '\\.tfvars$', '\\.hcl$', '(^|/)\\.env(\\.[\\w.-]+)?$', '(^|/)\\.envrc$',
    '(^|/)(k8s|kubernetes|helm|charts|manifests|deploy|deployment|infra|infrastructure|terraform|ops|\\.github/workflows|\\.circleci|\\.gitlab)(/|$)',
    '(^|/)(Procfile|fly\\.toml|vercel\\.json|netlify\\.toml|render\\.yaml|app\\.yaml|serverless\\.ya?ml|cdk\\.json|Pulumi\\.ya?ml|skaffold\\.ya?ml|Tiltfile|nginx\\.conf|Caddyfile)$',
    '(^|/)\\.gitlab-ci\\.yml$', '(^|/)\\.?(nvmrc|node-version|python-version|tool-versions)$', '(^|/)(ssh|\\.ssh|\\.aws|\\.kube)/',
  ].join('|'),
  'i',
);
const GENERATED_PATH = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|(^|\/)(node_modules|dist|build|\.next|out|target|vendor|__pycache__|coverage)\/|\.min\.(js|css)$|\.map$/i;

export function isInfraPath(p) {
  return !!p && INFRA_PATH.test(p);
}
export function isGeneratedPath(p) {
  return !!p && GENERATED_PATH.test(p);
}

// Pull file paths out of a shell command so "cat .env" counts as env, not code.
function pathsInCommand(cmd) {
  return (cmd.match(/[\w./~-]*[\w-]+(\.[\w-]+)+|[\w./~-]*\/[\w.-]+/g) || []).slice(0, 20);
}

export function classifyCommand(cmd) {
  if (!cmd) return { category: 'other', sub: 'shell' };
  const c = String(cmd);
  const paths = pathsInCommand(c);
  const generated = paths.some(isGeneratedPath);
  if (ENV_CMD.test(c) || ENV_HINTS.test(c) || (READ_CMD.test(c) && paths.some(isInfraPath))) {
    const keyword = firstMatch(c, ENV_CMD) || firstMatch(c, READ_CMD);
    return { category: 'env', sub: firstMatch(c, ENV_CMD) || 'env vars & config', keyword, generated };
  }
  if (GO_BUILD.test(c) || BUILD_CMD.test(c)) {
    const keyword = GO_BUILD.test(c) ? 'go' : firstMatch(c, BUILD_CMD);
    return { category: 'build', sub: keyword, keyword, generated };
  }
  if (GIT_CMD.test(c)) return { category: 'git', sub: firstMatch(c, /\b(git|gh|glab|hub)\s/), keyword: firstMatch(c, /\b(git|gh|glab|hub)\s/), generated };
  if (WEB_CMD.test(c)) return { category: 'web', sub: 'curl', keyword: firstMatch(c, WEB_CMD), generated };
  if (READ_CMD.test(c)) return { category: 'code_read', sub: 'shell read', keyword: firstMatch(c, READ_CMD), generated };
  return { category: 'other', sub: 'shell', generated };
}

// Some agents (e.g. Codex's code-mode `exec`) wrap shell commands in a JS
// snippet. Classify only the string literals so identifiers don't match.
function jsStrings(src) {
  if (!/\b(await|const|let|var|tools\.|=>)\b|\bfunction\b/.test(src)) return src;
  const lits = [];
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = re.exec(src))) if (m[2].trim()) lits.push(m[2]);
  return lits.length ? lits.join('\n') : src;
}

function firstMatch(s, re) {
  const m = s.match(re);
  return m ? m[1] : null;
}

const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls', 'notebookread', 'view', 'read_file', 'list_dir', 'search', 'codebase_search', 'file_search']);
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'str_replace_editor', 'create_file', 'edit_file']);
const SHELL_TOOLS = new Set(['bash', 'exec', 'exec_command', 'shell', 'local_shell', 'run_terminal_cmd', 'powershell', 'container.exec']);
const SHELL_IO_TOOLS = new Set(['bashoutput', 'write_stdin', 'monitor', 'killshell', 'wait']);
const WEB_TOOLS = new Set(['webfetch', 'websearch', 'web_search', 'fetch']);
const AGENT_TOOLS = new Set(['task', 'agent', 'sendmessage', 'send_message', 'spawn_agent', 'wait_agent', 'list_agents', 'followup_task', 'interrupt_agent', 'listagents', 'taskstop', 'workflow']);
const BOOKKEEPING_TOOLS = new Set(['todowrite', 'update_plan', 'toolsearch', 'skill', 'exitplanmode', 'enterplanmode', 'askuserquestion', 'request_user_input', 'request_user_input_async', 'sleep', 'schedulewakeup']);

/**
 * Classify a tool call. `input` is the raw input object or string.
 * Returns { category, sub, path?, command?, generated? }.
 */
export function classifyTool(name, input, namespace) {
  const n = String(name || '').toLowerCase();
  const ns = String(namespace || '').toLowerCase();
  const inp = input && typeof input === 'object' ? input : {};
  const path = inp.file_path || inp.path || inp.notebook_path || inp.target_file || null;

  if (SHELL_TOOLS.has(n)) {
    let command = typeof input === 'string' ? input : inp.command || inp.cmd || inp.code || '';
    if (Array.isArray(command)) command = command.join(' ');
    command = jsStrings(String(command));
    return { ...classifyCommand(command), command };
  }
  if (ns === 'web' || WEB_TOOLS.has(n)) return { category: 'web', sub: n };
  if (ns === 'collaboration' || AGENT_TOOLS.has(n)) return { category: 'agents', sub: n };
  if (BOOKKEEPING_TOOLS.has(n)) return { category: 'overhead', sub: 'agent bookkeeping' };
  if (READ_TOOLS.has(n)) {
    if (isInfraPath(path)) return { category: 'env', sub: 'infra config read', path };
    return { category: 'code_read', sub: n === 'read' || n === 'read_file' || n === 'view' ? 'file read' : 'search', path, generated: isGeneratedPath(path) };
  }
  if (WRITE_TOOLS.has(n)) {
    let p = path;
    if (!p && typeof input === 'string') p = (input.match(/\*\*\* (?:Update|Add) File: (.+)/) || [])[1];
    if (isInfraPath(p)) return { category: 'env', sub: 'infra config write', path: p };
    return { category: 'code_write', sub: n, path: p };
  }
  if (SHELL_IO_TOOLS.has(n)) return { category: 'build', sub: 'process output' };
  if (/playwright|browser|chrome|puppeteer|computer|cua|screenshot/.test(n + ' ' + ns)) return { category: 'browser', sub: ns.replace(/^mcp__/, '') || n, label: 'browser' };
  if (n.startsWith('mcp__') || ns.startsWith('mcp')) return { category: 'other', sub: 'mcp' };
  return { category: 'other', sub: n || 'tool' };
}

// Rough, model-agnostic token estimate. Calibrated per session against the
// real usage numbers when the transcript has them (see analyze.js).
export function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(s.length / 3.8);
}

const ERROR_TEXT = /(exit(ed)? (with )?(code|status)[: ]+[1-9]\d*|Process exited with code [1-9]|command not found|No such file or directory|Traceback \(most recent call last\)|npm ERR!|ERR_PNPM|error\[E\d+\]|FAILED|panicked at|Segmentation fault|Permission denied|EADDRINUSE|ECONNREFUSED|Cannot find module)/;
export function looksLikeError(text) {
  if (!text) return false;
  return ERROR_TEXT.test(String(text).slice(0, 4000)) || ERROR_TEXT.test(String(text).slice(-2000));
}
