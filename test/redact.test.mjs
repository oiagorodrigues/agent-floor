import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASK, redact, redactDeep } from '../server/redact.mjs';
import { startServer } from '../server/index.mjs';

// Fake secrets are assembled at runtime so secret scanners don't flag this file.
const run = 'A1b2'.repeat(9);
const ghp = `ghp_${run}`;
const gho = `gho_${run}`;
const pat = `github_pat_${run}_${run}`;
const openai = `sk-${run}xY`;
const anthropic = `sk-ant-api03-${run}-${run}`;
const xoxb = `xoxb-123456789012-${run}`;
const xoxp = `xoxp-1234-5678-${run}`;
const akia = `AKIA${'IOSFODNN7EXAMPLE'}`;
const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0In0', 'c2lnbmF0dXJlLXZhbHVl'].join('.');

const redacted = [
  ['ghp_ token', `push with ${ghp} now`, `push with ${MASK} now`],
  ['gho_ token', `using ${gho}`, `using ${MASK}`],
  ['github_pat_ token', pat, MASK],
  ['sk- key', `key ${openai}`, `key ${MASK}`],
  ['sk-ant- key', anthropic, MASK],
  ['sk-proj- key', `sk-proj-${run}`, MASK],
  ['xoxb- token', xoxb, MASK],
  ['xoxp- token', xoxp, MASK],
  ['AWS access key id', `aws id ${akia}`, `aws id ${MASK}`],
  ['JWT', `cookie ${jwt}`, `cookie ${MASK}`],
  ['Authorization Bearer', 'curl -H "Authorization: Bearer abc.def" https://api.example.com', `curl -H "Authorization: Bearer ${MASK}" https://api.example.com`],
  ['Authorization Basic', 'Authorization: Basic dXNlcjpwYXNz', `Authorization: Basic ${MASK}`],
  ['Proxy-Authorization', 'Proxy-Authorization: Basic dXNlcjpwYXNz', `Proxy-Authorization: Basic ${MASK}`],
  ['Authorization in JSON', '{"Authorization": "Bearer xyz"}', `{"Authorization": "Bearer ${MASK}"}`],
  ['Authorization token scheme', `authorization: token ${ghp}`, `authorization: token ${MASK}`],
  ['Authorization raw token', 'Authorization: abcdef0123456789abcdef', `Authorization: ${MASK}`],
  ['bare Bearer token', 'send Bearer abcdef0123456789abcdef', `send Bearer ${MASK}`],
  ['curl -u', 'curl -u admin:s3cret https://example.com', `curl -u admin:${MASK} https://example.com`],
  ['curl --user', 'curl --user admin:s3cret https://example.com', `curl --user admin:${MASK} https://example.com`],
  ['curl --user=', 'curl -s -X POST --user=bob:hunter2 https://example.com', `curl -s -X POST --user=bob:${MASK} https://example.com`],
  ['curl -uuser:pass', 'curl -uadmin:pw https://example.com', `curl -uadmin:${MASK} https://example.com`],
  ['curl -u quoted', 'curl -u "admin:pa ss" https://example.com', `curl -u "admin:${MASK}" https://example.com`],
  ['URL userinfo', 'git clone https://user:pass@github.com/o/r.git', `git clone https://user:${MASK}@github.com/o/r.git`],
  ['database URL userinfo', 'postgres://app:Sup3r@localhost:5432/db', `postgres://app:${MASK}@localhost:5432/db`],
  ['password=', 'password=hunter2', `password=${MASK}`],
  ['env password', 'DB_PASSWORD=abc npm start', `DB_PASSWORD=${MASK} npm start`],
  ['passwd:', 'passwd: hunter22', `passwd: ${MASK}`],
  ['env token', 'export GITHUB_TOKEN=abcd', `export GITHUB_TOKEN=${MASK}`],
  ['JSON token', '{"token": "abc123"}', `{"token": "${MASK}"}`],
  ['single-quoted secret', "secret='x y z'", `secret='${MASK}'`],
  ['api_key:', 'api_key: xyz123', `api_key: ${MASK}`],
  ['apikey=', 'apikey=xyz', `apikey=${MASK}`],
  ['access_key=', 'access_key=Q', `access_key=${MASK}`],
  ['AWS secret access key', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI', `AWS_SECRET_ACCESS_KEY=${MASK}`],
  ['client_secret=', 'client_secret=zzz', `client_secret=${MASK}`],
  ['x-api-key header', 'x-api-key: k3y12345', `x-api-key: ${MASK}`],
  ['npm auth token', 'npm config set //registry.npmjs.org/:_authToken=abc', `npm config set //registry.npmjs.org/:_authToken=${MASK}`],
  ['query string token', 'GET /cb?access_token=abc&x=1', `GET /cb?access_token=${MASK}&x=1`],
  ['secret inside a labelled value', `GITHUB_TOKEN=${ghp}`, `GITHUB_TOKEN=${MASK}`],
];

const untouched = [
  ['short git SHA', 'a1b2c3d'],
  ['full git SHA', 'git show 4b825dc642cb6eb9a060e54bf8d69288fbee4904'],
  ['UUID', 'session 550e8400-e29b-41d4-a716-446655440000'],
  ['file path', 'Editing src/world/Building.ts'],
  ['home path', '/Users/x/.claude/projects/a/b.jsonl'],
  ['npm run', 'npm run build'],
  ['npm install with semver', 'npm install --save-dev typescript@7.0.2'],
  ['git push -u', 'git push -u origin feat/secret-redaction'],
  ['git commit about keys', 'git commit -m "fix key handling"'],
  ['docker run -u uid:gid', 'docker run -u 1000:1000 -v /a:/b node:20'],
  ['docker build tag', 'docker build -t app:1.2.3 .'],
  ['semver prerelease', 'v1.2.3-rc.1'],
  ['webpack hash', 'main.4f3a9c1b2d8e7f6a.js'],
  ['Vite asset name', 'index-hSWZ1M3F.js'],
  ['Vite css asset', 'assets/vendor-BxK9fQ2p.css'],
  ['long chunk hash', 'chunk-5f8e2c1a9b3d7e6f4a2c.js'],
  ['base64-ish id', 'dGhpcyBpcyBub3QgYSBzZWNyZXQgYXQgYWxs'],
  ['six four-letter words', 'will need more time with this'],
  ['monkey', 'monkey business'],
  ['keyboard', 'keyboard shortcuts'],
  ['keys.ts', 'Editing keys.ts'],
  ['--key-file path', 'openssl req --key-file path/key.pem'],
  ['URL without credentials', 'https://github.com/oiagorodrigues/agent-floor'],
  ['URL with port and @ in path', 'https://example.com:8080/a@b'],
  ['ssh git remote', 'git@github.com:org/repo.git'],
  ['sentence about tokens', 'The tests pass and the token refresh works'],
  ['prose after token:', 'Fix token: expiry check'],
  ['TypeScript type', 'token: string'],
  ['word after password:', 'password: Password'],
  ['prose after authorization:', 'authorization: role checks'],
  ['bearer in prose', 'Bearer bonds rally'],
  ['max_tokens', 'max_tokens=1024'],
  ['token_type', 'token_type=bearer'],
  ['secret_name', 'secret_name=prod'],
  ['GitHub Actions secrets', 'secrets: inherit'],
  ['shell variable', 'password=$DB_PASS'],
  ['command substitution', 'TOKEN=$(cat ~/.agent-floor/token)'],
  ['Actions expression', 'secret: ${{ secrets.X }}'],
  ['comparison', 'token == null'],
  ['arrow', 'token => x'],
  ['empty value', 'password=""'],
  ['PWD', 'PWD=/Users/x OLDPWD=/tmp'],
  ['branch starting with sk-', 'git checkout sk-123-add-login-flow'],
  ['word ending in sk-', 'task-abcdefghijklmnopqrstuvwxyz'],
  ['curl user agent', 'curl --user-agent "Mozilla/5.0" https://example.com'],
  ['Portuguese', 'Adicionando validação de senha no formulário de cadastro'],
  ['Portuguese with colon', 'Revisão: corrigir o fluxo de autenticação'],
];

for (const [name, input, expected] of redacted) {
  test(`redacts ${name}`, () => assert.equal(redact(input), expected));
}

for (const [name, input] of untouched) {
  test(`leaves ${name} alone`, () => assert.equal(redact(input), input));
}

test('redaction is idempotent', () => {
  for (const [, , expected] of redacted) assert.equal(redact(expected), expected);
});

test('redactDeep masks nested strings and keeps keys and other values', () => {
  const out = redactDeep({ password: 'plain', list: [`using ${ghp}`, 3, null], nested: { ok: true, text: 'token=abc' } });
  assert.deepEqual(out, { password: 'plain', list: [`using ${MASK}`, 3, null], nested: { ok: true, text: `token=${MASK}` } });
});

test('worst-case inputs finish quickly', () => {
  const size = 64 * 1024;
  for (const unit of ['sk-', 'curl -u ', 'token:', 'https://a:', 'authorization: ', 'a-']) {
    const start = performance.now();
    redact(unit.repeat(Math.ceil(size / unit.length)));
    assert.ok(performance.now() - start < 1000, `slow on repeated "${unit}"`);
  }
});

const TOKEN = 'test-token';

async function readEventFrame(base, post) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/stream`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  await post();
  try {
    for (;;) {
      const { value } = await reader.read();
      buffer += decoder.decode(value, { stream: true });
      const frame = buffer.split('\n\n').find((f) => f.startsWith('event: event'));
      if (frame) return frame;
    }
  } finally {
    ctrl.abort();
  }
}

test('the server masks every text field before it stores or broadcasts the event', async () => {
  const floor = await startServer({ port: 0, log: () => {}, token: TOKEN });
  const base = `http://127.0.0.1:${floor.server.address().port}`;
  const post = (events) =>
    fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(events),
    });
  try {
    const event = {
      type: 'message',
      agent: { id: 'bot-1', name: `n ${ghp}`, role: `r ${xoxb}`, source: 'cli' },
      team: { name: `t ${akia}` },
      account: 'password=hunter2',
      activity: `${'x'.repeat(270)} ${ghp}`,
      tool: `tool ${openai}`,
      text: `curl -u admin:s3cret https://user:pass@example.com`,
      task: `export GITHUB_TOKEN=${gho}`,
      to: 'bot-2',
    };
    const frame = await readEventFrame(base, () => post(event));
    await post({ type: 'tool', agent: 'bot-1', subagent: { key: jwt, type: `reviewer ${anthropic}` }, activity: 'Reading' });
    const state = await (await fetch(`${base}/state`)).text();

    const secrets = ['ghp_', ghp, gho, xoxb, akia, openai, anthropic, jwt, 'hunter2', 's3cret', ':pass@', run.slice(0, 12)];
    for (const [where, text] of [['broadcast', frame], ['state', state]]) {
      for (const secret of secrets) assert.ok(!text.includes(secret), `${where} leaks ${secret}`);
      assert.ok(text.includes(MASK), `${where} has no mask`);
    }
    const agent = JSON.parse(state).agents['bot-1'];
    assert.equal(agent.name, `n ${MASK}`);
    assert.equal(agent.role, `r ${MASK}`);
    assert.equal(JSON.parse(state).teams[agent.team].name, `t ${MASK}`);
  } finally {
    await floor.close();
  }
});
