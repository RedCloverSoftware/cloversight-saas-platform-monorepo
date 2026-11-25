import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripeSecretConfig, verifyStripeCatalog } from '../scripts/stripe-secret-config.mjs';
import { PLANS } from '../src/domain/plans.mjs';

function environment(overrides = {}) {
  return { STAGE: 'prod', STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    ...Object.fromEntries(Object.keys(PLANS).map(id => [`STRIPE_PRICE_${id.toUpperCase()}`, `price_${id}`])), ...overrides };
}
function price(id, mode = 'test') {
  const plan = PLANS[id.replace('price_', '')];
  return { id, livemode: mode === 'live', active: true, type: 'recurring', billing_scheme: 'per_unit', unit_amount: plan.priceMinor,
    currency: 'usd', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } };
}
test('production defaults to live Stripe and explicitly supports test mode', () => {
  assert.equal(stripeSecretConfig(environment()).mode, 'test');
  assert.equal(stripeSecretConfig(environment({ STRIPE_MODE: '', STRIPE_SECRET_KEY: 'sk_live_fixture' })).mode, 'live');
  assert.throws(() => stripeSecretConfig(environment({ STRIPE_MODE: '' })), /sk_live_/);
  assert.throws(() => stripeSecretConfig(environment({ STRIPE_SECRET_KEY: 'sk_live_fixture' })), /sk_test_/);
});
test('restricted keys must match the selected mode and contain a key value', () => {
  for (const mode of ['test', 'live']) {
    const key = `rk_${mode}_fixture`;
    assert.equal(stripeSecretConfig(environment({ STRIPE_MODE: mode, STRIPE_SECRET_KEY: key })).secretKey, key);
    const opposite = mode === 'test' ? 'live' : 'test';
    for (const invalid of [`rk_${opposite}_fixture`, `rk_${mode}_`, `pk_${mode}_fixture`]) {
      assert.throws(() => stripeSecretConfig(environment({ STRIPE_MODE: mode, STRIPE_SECRET_KEY: invalid })), /STRIPE_SECRET_KEY/);
    }
  }
});
test('staging and beta remain test-only; malformed configuration never echoes credentials', () => {
  for (const STAGE of ['staging', 'beta']) {
    assert.equal(stripeSecretConfig(environment({ STAGE, STRIPE_MODE: '' })).mode, 'test');
    assert.throws(() => stripeSecretConfig(environment({ STAGE, STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_fixture' })), /require STRIPE_MODE=test/);
  }
  for (const override of [{ STRIPE_MODE: 'sandbox' }, { STAGE: 'typo' }, { STRIPE_SECRET_KEY: 'secretMustNotAppear' }, { STRIPE_WEBHOOK_SECRET: '' }, { STRIPE_PRICE_SCALE: '' }]) {
    assert.throws(() => stripeSecretConfig(environment(override)), error => !error.message.includes('secretMustNotAppear'));
  }
});
test('catalog validation reads all six Prices using the chosen key and mode', async () => {
  for (const mode of ['test', 'live']) {
    const config = stripeSecretConfig(environment({ STRIPE_MODE: mode, STRIPE_SECRET_KEY: `rk_${mode}_fixture` }));
    const ids = [];
    await verifyStripeCatalog(config, async (url, options) => {
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${config.secretKey}`);
      const id = url.split('/').at(-1); ids.push(id);
      return { ok: true, json: async () => price(id, mode) };
    });
    assert.deepEqual(ids.sort(), Object.values(config.priceIds).sort());
  }
});
test('mixed mode, archived, wrong amount/currency/cadence and usage-based Prices fail before upload', async () => {
  const config = stripeSecretConfig(environment());
  for (const change of [
    { livemode: true }, { active: false }, { unit_amount: 1 }, { currency: 'cad' }, { id: 'price_other' },
    { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } },
    { recurring: { interval: 'month', interval_count: 12, usage_type: 'licensed' } },
    { recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } },
    { transform_quantity: { divide_by: 10, round: 'down' } }, { billing_scheme: 'tiered' },
  ]) {
    await assert.rejects(verifyStripeCatalog(config, async url => ({ ok: true, json: async () => ({ ...price(url.split('/').at(-1)), ...change }) })), /No secret was uploaded/);
  }
});
test('provider errors and network failures are reported without raw error bodies or keys', async () => {
  const config = stripeSecretConfig(environment());
  for (const fetchImpl of [async () => { throw new Error(config.secretKey); }, async () => ({ ok: false, status: 403, text: async () => config.secretKey }), async () => ({ ok: true, json: async () => { throw new Error(config.webhookSecret); } })]) {
    await assert.rejects(verifyStripeCatalog(config, fetchImpl), error => !error.message.includes(config.secretKey) && !error.message.includes(config.webhookSecret));
  }
});

function runPush(script, overrides = {}, wrongPrice = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloversight-stripe-push-'));
  try {
    for (const name of [`infra/scripts/${script}`, 'infra/scripts/lib.sh', 'scripts/stripe-secret-config.mjs', 'src/domain/plans.mjs']) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.copyFileSync(name, path.join(root, name));
    }
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin/aws'), `#!/usr/bin/env node
import fs from 'node:fs';
const a=process.argv.slice(2), get=n=>a[a.indexOf(n)+1];
if(a.includes('get-caller-identity')) console.log(get('--query')==='Arn'?'arn:aws:sts::123456789012:assumed-role/webwatch-deployment/test':'123456789012');
else if(a.includes('describe-stacks')) console.log('arn:aws:secretsmanager:us-east-1:123456789012:secret:webwatch-prod-stripe-fixture');
else if(a.includes('put-secret-value')) { const bytes=fs.readFileSync(get('--secret-string').replace('file://',''));fs.writeFileSync(process.env.UPLOAD,bytes,{mode:0o600}); }
else throw new Error('Unexpected AWS operation');
`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'fetch-fixture.mjs'), `import { PLANS } from './src/domain/plans.mjs';
globalThis.fetch=async url=>{const id=url.split('/').at(-1),p=PLANS[id.replace('price_','')];return {ok:true,json:async()=>({id,active:true,livemode:process.env.WRONG_PRICE==='true',type:'recurring',billing_scheme:'per_unit',unit_amount:p.priceMinor,currency:'usd',recurring:{interval:'month',interval_count:1,usage_type:'licensed'}})}};`);
    const upload = path.join(root, 'uploaded.json');
    const result = spawnSync('bash', [`infra/scripts/${script}`], { cwd: root, encoding: 'utf8', env: {
      ...process.env, ...environment(overrides), PATH: `${root}/bin:${process.env.PATH}`, AWS_REGION: 'us-east-1', AWS_ACCOUNT_ID: '123456789012',
      STACK_NAME: 'webwatch-prod', WEBWATCH_DEPLOYMENT_ROLE_ACTIVE: 'true', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_FROM: '',
      NODE_OPTIONS: `--import=${path.join(root, 'fetch-fixture.mjs')}`, UPLOAD: upload, WRONG_PRICE: String(wrongPrice),
    } });
    return { ...result, uploaded: fs.existsSync(upload) ? JSON.parse(fs.readFileSync(upload)) : null };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('both secret-push entry points support explicit production test mode without Twilio', () => {
  for (const script of ['push-secrets.sh', 'push-stripe-secret.sh']) {
    const result = runPush(script); assert.equal(result.status, 0, result.stderr);
    assert.equal(result.uploaded.mode, 'test'); assert.equal(result.uploaded.secretKey, 'sk_test_fixture');
    assert.equal(Object.keys(result.uploaded.priceIds).length, 6);
    assert.doesNotMatch(result.stdout + result.stderr, /sk_test_fixture|whsec_fixture/);
  }
});
test('both secret-push entry points refuse default-prod test keys and wrong-mode Prices without uploading', () => {
  for (const script of ['push-secrets.sh', 'push-stripe-secret.sh']) {
    for (const [overrides, wrongPrice] of [[{ STRIPE_MODE: '' }, false], [{}, true]]) {
      const result = runPush(script, overrides, wrongPrice);
      assert.notEqual(result.status, 0); assert.equal(result.uploaded, null);
      assert.doesNotMatch(result.stdout + result.stderr, /sk_test_fixture|whsec_fixture/);
    }
  }
});
test('both secret-push entry points upload a restricted key without logging it', () => {
  for (const script of ['push-secrets.sh', 'push-stripe-secret.sh']) {
    const key = 'rk_test_fixture';
    const result = runPush(script, { STRIPE_SECRET_KEY: key });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.uploaded.secretKey, key);
    assert.doesNotMatch(result.stdout + result.stderr, /rk_test_fixture|whsec_fixture/);
  }
});
