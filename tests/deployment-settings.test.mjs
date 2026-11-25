import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDeploymentSettings, requiredDeploymentValues } from '../src/deployment/settings.mjs';

const productionEnv = {
  STAGE: 'prod',
  COGNITO_STEWARD_MFA: 'ON',
  TECHNICAL_ALERTS_ENABLED: 'true',
  TECHNICAL_ALERT_EMAIL: 'technical@example.com',
  OPS_ALERT_EMAIL: 'ops@example.com',
  BUDGET_ALERT_EMAIL: 'budget@example.com',
};

test('new production uses the custom host and SES while installed and staging choices remain explicit', (t) => {
  const prod = loadDeploymentSettings(productionEnv);
  assert.equal(prod.customerCognitoDomainMode, 'custom');
  assert.equal(prod.cognitoEmailDelivery, 'ses');
  assert.equal(prod.customerAuthDomain, 'auth.cloversight.app');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloversight-cognito-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const allowlist = path.join(directory, 'allowlist');
  fs.writeFileSync(allowlist, '192.0.2.1/32\n');
  const staging = loadDeploymentSettings({ STAGE: 'staging', STAGING_IP_ALLOWLIST_FILE: allowlist });
  assert.equal(staging.customerCognitoDomainMode, 'prefix');
  assert.equal(staging.cognitoEmailDelivery, 'cognito');
  const upgrade = loadDeploymentSettings({ ...productionEnv, COGNITO_CUSTOMER_DOMAIN_MODE: 'custom-with-prefix', COGNITO_EMAIL_DELIVERY: 'cognito' });
  assert.equal(upgrade.cognitoEmailDelivery, 'cognito');
  assert.ok(requiredDeploymentValues(upgrade).includes('COGNITO_CUSTOMER_CERTIFICATE_ARN'));
  assert.throws(() => loadDeploymentSettings({ ...productionEnv, COGNITO_CUSTOMER_DOMAIN_MODE: 'custom-with-prefix', COGNITO_CUSTOMER_CERTIFICATE_ARN: 'arn:aws:acm:us-west-2:123456789012:certificate/x' }), /us-east-1/);
  assert.throws(() => loadDeploymentSettings({ ...productionEnv, COGNITO_EMAIL_DELIVERY: 'smtp' }), /COGNITO_EMAIL_DELIVERY/);
});

test('Twilio is disabled when all optional credentials are blank', () => {
  const settings = loadDeploymentSettings({ ...productionEnv, TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_FROM: '' });
  assert.equal(settings.twilioEnabled, false);
});

test('Twilio is enabled only when all three credentials are configured', () => {
  const settings = loadDeploymentSettings({ ...productionEnv, TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM: '+19025550123' });
  assert.equal(settings.twilioEnabled, true);
});

test('a partial Twilio configuration fails closed', () => {
  assert.throws(
    () => loadDeploymentSettings({ ...productionEnv, TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: '', TWILIO_FROM: '' }),
    /must either all be configured or all be blank/,
  );
});

test('worker concurrency reserves capacity for both check and result queues', () => {
  const settings = loadDeploymentSettings(productionEnv);
  assert.equal(settings.reservedCheckConcurrency, 2);
  assert.equal(settings.workerReservedConcurrency, 4);
  assert.throws(
    () => loadDeploymentSettings({ ...productionEnv, RESERVED_CHECK_CONCURRENCY: '3', WORKER_RESERVED_CONCURRENCY: '4' }),
    /must be at least RESERVED_CHECK_CONCURRENCY \+ 2/,
  );
});

test('the advertised Team plan cannot deploy with only one configured capture region', () => {
  assert.throws(
    () => loadDeploymentSettings({ ...productionEnv, REGIONAL_CHECK_REGIONS: 'us-east-1' }),
    /at least three supported AWS regions/,
  );
});
