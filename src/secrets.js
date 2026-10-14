import { createHash } from 'node:crypto';

// Detects credentials that passed through the model's context.
// Values are hashed for de-duplication and never stored or printed.

const RULES = [
  { type: 'AWS access key', re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g },
  { type: 'AWS secret key', re: /aws_?secret_?access_?key["'\s]*[:=]\s*["']?([A-Za-z0-9/+]{40})\b/gi },
  { type: 'GitHub token', re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { type: 'GitLab token', re: /\b(glpat-[A-Za-z0-9_-]{20,})\b/g },
  { type: 'Anthropic API key', re: /\b(sk-ant-[A-Za-z0-9_-]{30,})\b/g },
  { type: 'OpenAI API key', re: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,})\b/g, not: /^sk-ant-|^sk-(live|test)_/ },
  { type: 'Stripe key', re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g },
  { type: 'Slack token', re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/g },
  { type: 'Google API key', re: /\b(AIza[0-9A-Za-z_-]{35})\b/g },
  { type: 'npm token', re: /\b(npm_[A-Za-z0-9]{36})\b/g },
  { type: 'Private key', re: /(-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]{20,200})/g },
  { type: 'JWT', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g },
  { type: 'Database URL with password', re: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:/@"']+:([^\s@"'/]{6,})@[^\s"']+)/g, valueGroup: 2 },
  {
    type: 'Password / secret assignment',
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)[A-Z0-9_]*)\s*[=:]\s*["']?([A-Za-z0-9][^\s"'`$<>{}\\]{11,})/g,
    nameNot: /(_FILE|_PATH|_URL|_VERSION|_NAME|_ID|_ENABLED|_TTL|_EXPIRY|_HEADER|_LENGTH|_SIZE|_TYPE)$|^SECRETLESS|^NO_/,
    valueGroup: 2,
    generic: true,
  },
];

const PLACEHOLDER = /(x{4,}|\*{3,}|\.{3}|your[_-]|example|changeme|placeholder|dummy|redacted|<|>|\$\{|\{\{|test-?key|fake|sample|replace|todo|null|undefined|true|false)/i;

function looksRandom(v) {
  if (v.length < 12) return false;
  // Word-like dev passwords ("local-dev-pass", "postgres_password1") aren't interesting.
  if (/^[a-z]+([-_.][a-z]+)*\d{0,4}$/i.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  if (classes < 2) return false;
  return new Set(v).size >= Math.min(10, v.length / 2);
}

/** Returns [{ type, hash, generic }] for every credential-looking string in text. */
export function findSecrets(text) {
  if (!text || text.length < 16) return [];
  const out = [];
  const s = String(text);
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(s))) {
      const value = m[rule.valueGroup || 1];
      if (!value || PLACEHOLDER.test(value)) continue;
      if (rule.not && rule.not.test(value)) continue;
      if (rule.generic && (!looksRandom(value) || rule.nameNot.test(m[1]))) continue;
      const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
      if (!out.some((o) => o.hash === hash)) out.push({ type: rule.type, generic: !!rule.generic, hash });
    }
  }
  return out;
}
