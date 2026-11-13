// Masks secrets in event text before the floor stores or broadcasts it.
// Ported from kasket091/agent-floor server/redact.mjs (07e7eee), with narrower rules.
//
// The secret is replaced by MASK and the label around it (key name, auth scheme,
// user name, URL host) stays. The rules only match labelled values or known token
// prefixes, so ids, hashes and file names pass through untouched.

export const MASK = '[redacted]';

const SECRET_NAME = String.raw`(?:password|passwd|token|secret|api[_-]?key|access[_-]?key)`;

const quoted = (q) => `${q}${MASK}${q}`;

const RULES = [
  // Authorization: Bearer x / Basic x / token x, also in JSON or JS object form.
  [/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest|negotiate)\s+)[^\s"',;]+/gi, `$1${MASK}`],
  // Authorization: <raw token>. The length floor keeps prose like "authorization: role checks" intact.
  [/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)[\w.~+/-]{16,}=*/gi, `$1${MASK}`],
  [/\b(bearer\s+)[\w.~+/-]{16,}=*/gi, `$1${MASK}`],
  // scheme://user:pass@host. Scheme starts only at a token start, so long runs cannot backtrack quadratically.
  [/(?<![\w+.-])([a-z][a-z0-9+.-]{1,30}:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${MASK}@`],
  // curl -u user:pass, --user user:pass, -uuser:pass, -u "user:pass". Scoped to curl so `docker run -u 1000:1000` stays.
  [
    /(\bcurl\b[^\r\n|;&]{0,300}?\s(?:-u\s*|--user(?:\s+|=)))(?:"([^"\s:]+):[^"\r\n]*"|'([^'\s:]+):[^'\r\n]*'|([^\s:"'-][^\s:"']*):\S+)/g,
    (_, pre, dq, sq, user) => (dq ? `${pre}"${dq}:${MASK}"` : sq ? `${pre}'${sq}:${MASK}'` : `${pre}${user}:${MASK}`),
  ],
  // password=x, GITHUB_TOKEN=x, "api_key": "x", client_secret: x.
  // The name must end with the secret word, so max_tokens, token_type and --key-file stay.
  [
    new RegExp(
      String.raw`(?<![\w-])([\w-]{0,40}?${SECRET_NAME}["']?\s*([:=])\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|((?![=>$])[^\s"'&,;()<>{}\[\]]+))`,
      'gi',
    ),
    (match, pre, sep, dq, sq, bare) => {
      if (dq) return pre + quoted('"');
      if (sq) return pre + quoted("'");
      // Unquoted after a colon is often prose or a type ("token: string"), so it needs a digit to count.
      if (bare && (sep === '=' || (bare.length >= 6 && /\d/.test(bare)))) return pre + MASK;
      return match;
    },
  ],
  // Known token shapes.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, MASK],
  // sk-, sk-ant-, sk-proj-: needs a 20-char run without dashes, so a branch like sk-123-add-login stays.
  // The run is checked in the callback, because a lazy pattern for it backtracks quadratically on "sk-sk-sk-...".
  [/\bsk-[\w-]+/g, (token) => (/[A-Za-z0-9_]{20}/.test(token) ? MASK : token)],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g, MASK],
];

export function redact(text) {
  if (typeof text !== 'string') return text;
  return RULES.reduce((s, [re, to]) => s.replace(re, to), text);
}

/** Redacts every string inside a parsed JSON value. Keys are left as they are. */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}
