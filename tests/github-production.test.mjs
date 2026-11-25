import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account, productionContext, region, stackName } from '../scripts/github-production.mjs';

const locations = [region, 'us-east-2', 'ca-central-1'];
function fixture(name, location) {
  const params = {
    PublicDomainName: 'cloversight.app', Stage: 'prod', AvailableCheckRegions: locations.join(','),
    EnableIdentityIndex: 'true', EnableLookupIndex: 'true', TechnicalAlertsEnabled: 'true',
    OpsAlertEmail: 'ops@example.org', BudgetAlertEmail: 'cost@example.org', TechnicalAlertEmail: 'tech@example.org',
    WorkerImageUri: `${account}.dkr.ecr.${region}.amazonaws.com/example@sha256:${'c'.repeat(64)}`,
    TwilioEnabled: 'true', StewardOwnerSub: 'owner-only', ReservedCaptureConcurrency: '72',
  };
  return {
    StackId: `arn:aws:cloudformation:${location}:${account}:stack/${name}/id`, StackStatus: 'UPDATE_COMPLETE',
    RoleARN: `arn:aws:iam::${account}:role/webwatch-cloudformation-execution`,
    Outputs: [{ OutputKey: 'PublicUrl', OutputValue: 'https://cloversight.app' }],
    Parameters: Object.entries(params).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
  };
}
test('release uses installed topology and current image, without importing provider settings', () => {
  const seen = [];
  const { env, stacks } = productionContext((name, location) => {
    seen.push([name, location]); return fixture(name, location);
  });
  assert.deepEqual(seen, locations.map(r => [r === region ? stackName : stackName + '-regional-' + r, r]));
  assert.equal(stacks.length, 3);
  assert.equal(env.WORKER_ECR_REPOSITORY, 'example');
  assert.equal(env.CAPTURE_RESERVED_CONCURRENCY, '72');
  assert.equal(env.CLOVERSIGHT_EXISTING_RELEASE, '1');
  assert.equal(env.COGNITO_CUSTOMER_DOMAIN_MODE, 'prefix');
  assert.equal(env.COGNITO_EMAIL_DELIVERY, 'cognito');
  assert.ok(!Object.keys(env).some(k => k.startsWith('TWILIO') || k.startsWith('STRIPE') || k === 'STEWARD_OWNER_SUB'));
});
test('CI reconstructs installed custom login and SES settings for later releases', () => {
  const { env } = productionContext((name, location) => {
    const stack = fixture(name, location);
    stack.Parameters.push({ ParameterKey: 'CustomerCognitoDomainMode', ParameterValue: 'custom-with-prefix' },
      { ParameterKey: 'CognitoEmailDelivery', ParameterValue: 'ses' });
    return stack;
  });
  assert.equal(env.COGNITO_CUSTOMER_DOMAIN_MODE, 'custom-with-prefix');
  assert.equal(env.COGNITO_EMAIL_DELIVERY, 'ses');
});
test('fail before release if a configured region is absent, unstable, or owned by a different account or execution role', () => {
  for (const change of [() => null, s => ({ ...s, StackStatus: 'UPDATE_IN_PROGRESS' }),
    s => ({ ...s, StackId: s.StackId.replace(account, '111111111111') }), s => ({ ...s, RoleARN: 'another-role' })]) {
    assert.throws(() => productionContext((name, location) => location === region ? fixture(name, location) : change(fixture(name, location))));
  }
});
test('a staging domain or unfinished migration cannot be treated as an installed production stack', () => {
  assert.throws(() => productionContext((name, location) => ({ ...fixture(name, location), Outputs: [] })), /initialized/);
  assert.throws(() => productionContext((name, location) => {
    const stack = fixture(name, location);
    stack.Parameters.find(p => p.ParameterKey === 'EnableIdentityIndex').ParameterValue = 'false';
    return stack;
  }), /initialized/);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('worker selection reuses a matching immutable image, rebuilds a changed release and stops on registry failure', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloversight-ci-worker-'));
  const script = path.resolve('infra/github/prepare-worker.sh');
  const write = (name, source) => fs.writeFileSync(path.join(tmp, name), source, { mode: 0o755 });
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.mkdirSync(path.join(tmp, 'infra/scripts'), { recursive: true });
    write('package.json', '{"version":"0.5.20"}');
    write('scripts/worker-image-source-hash.mjs', 'console.log("fixtureHash")');
    write('scripts/worker-base.mjs', 'console.log("base@sha256:reviewed")');
    write('aws', '#!/bin/sh\necho dummy');
    write('docker', `#!/bin/sh
case "$1" in
  login) cat >/dev/null ;;
  pull) exit "$PULL_STATUS" ;;
  image) case "$*" in *base.digest*) echo "$BASE_LABEL";; *source-sha256*) echo "$MARKER";; *) echo 0.5.20;; esac ;;
  *) exit 1 ;;
esac`);
    write('infra/scripts/build-worker-image.sh', 'echo "$WORKER_IMAGE_TAG" > built');
    const call = (MARKER, PULL_STATUS = '0', BASE_LABEL = 'sha256:reviewed') => spawnSync('bash', [script], { cwd: tmp, encoding: 'utf8',
      env: { ...process.env, PATH: tmp + ':' + process.env.PATH, MARKER, PULL_STATUS, BASE_LABEL, AWS_REGION: region,
        WORKER_IMAGE_URI: 'example/repo@sha256:' + 'a'.repeat(64), GITHUB_SHA: 'abc', GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '2' } });
    assert.equal(call('fixtureHash').status, 0);
    assert.match(fs.readFileSync(path.join(tmp, '.local/worker-image.env'), 'utf8'), /WORKER_IMAGE_SOURCE_SHA256=fixtureHash/);
    assert.ok(!fs.existsSync(path.join(tmp, 'built')));
    assert.notEqual(call('different', '1').status, 0);
    assert.ok(!fs.existsSync(path.join(tmp, 'built')));
    assert.equal(call('fixtureHash', '0', 'sha256:changed').status, 0);
    assert.ok(fs.existsSync(path.join(tmp, 'built')));
    fs.unlinkSync(path.join(tmp, 'built'));
    assert.equal(call('different').status, 0);
    assert.equal(fs.readFileSync(path.join(tmp, 'built'), 'utf8').trim(), 'gh-abc-12-2');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the production shell submits only the two release parameters and rejects a stale successful readback', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloversight-ci-primary-'));
  try {
    const file = (name, content) => fs.writeFileSync(path.join(tmp, name), content, { mode: 0o755 });
    fs.mkdirSync(path.join(tmp, 'infra/scripts'), { recursive: true });
    fs.copyFileSync('infra/scripts/deploy.sh', path.join(tmp, 'infra/scripts/deploy.sh'));
    file('infra/scripts/lib.sh', `load_webwatch_env(){ :; }; assert_region(){ :; }; ensure_deployment_role(){ :; }; invalidate_ci_release_baseline(){ :; }; require_command(){ :; }
aws_active(){ aws "$@"; }
deploy_cloudformation_checked(){
  while [[ $# -gt 0 && "$1" != --parameter-overrides ]]; do shift; done
  shift
  printf '%s\\n' "$@" > "$ROOT/sent"
}
`);
    file('infra/scripts/package-lambdas.sh', '#!/bin/sh\nexit 0');
    file('node', `#!/bin/sh
case "$*" in
  *deployment-settings.mjs*) exec "$REAL_NODE" "$PROJECT/scripts/deployment-settings.mjs" "$2" ;;
  *'deployment-control.mjs plan'*) echo '{"mode":"rollback","coreTableId":"core"}' ;;
  -e*) exec "$REAL_NODE" "$@" ;;
esac`);
    file('aws', `#!/bin/sh
case "$*" in
  *'dynamodb describe-table'*) echo 'LookupIndex IdentityIndex' ;;
  *'ParameterKey=='*RuntimeArtifactKey*) sed -n 's/^RuntimeArtifactKey=//p' sent ;;
  *'ParameterKey=='*WorkerImageUri*) echo "$OBSERVED_IMAGE" ;;
esac`);
    const { env } = productionContext(fixture);
    const run = installed => spawnSync('bash', ['infra/scripts/deploy.sh'], { cwd: tmp, encoding: 'utf8',
      env: { ...process.env, ...env, PATH: tmp + ':' + process.env.PATH, REAL_NODE: process.execPath, PROJECT: process.cwd(),
        ROUTE53_HOSTED_ZONE_ID: 'Z123456789', CLOUDFRONT_CERTIFICATE_ARN: `arn:aws:acm:${region}:${account}:certificate/test`,
        ARTIFACT_BUCKET: 'fixture-artifacts', OBSERVED_IMAGE: installed } });
    const valid = run(env.WORKER_IMAGE_URI);
    assert.equal(valid.status, 0, valid.stderr);
    const sent = fs.readFileSync(path.join(tmp, 'sent'), 'utf8').trim().split('\n');
    assert.equal(sent.length, 2);
    assert.match(sent[0], /^RuntimeArtifactKey=webwatch\/prod\/.+\/runtime.zip$/);
    assert.equal(sent[1], 'WorkerImageUri=' + env.WORKER_IMAGE_URI);
    assert.notEqual(run('stale').status, 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
