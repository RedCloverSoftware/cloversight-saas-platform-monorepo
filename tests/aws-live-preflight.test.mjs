import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const account = '123456789012';
const stackId = `arn:aws:cloudformation:us-east-1:${account}:stack/webwatch-prod/current`;
function responses() {
  return {
    'acm describe-certificate': { Certificate: { Status: 'ISSUED', NotAfter: '2099-01-01T00:00:00Z', SubjectAlternativeNames: ['cloversight.app', '*.cloversight.app'] } },
    'cognito-idp describe-user-pool-domain': { DomainDescription: {} },
    'ecr describe-images': { imageDetails: [{ imageManifestMediaType: 'application/vnd.docker.distribution.manifest.v2+json' }] },
    'cloudformation describe-stacks': { error: 'ValidationError: Stack with id webwatch-prod does not exist' },
    'cloudformation list-stack-resources': { StackResourceSummaries: [] },
    'cloudfront list-distributions': { DistributionList: { Items: [] } },
    'cloudfront list-functions': { FunctionList: { Items: [] } },
    'cloudfront list-cache-policies': { CachePolicyList: { Items: [] } },
    'cloudfront list-origin-request-policies': { OriginRequestPolicyList: { Items: [] } },
    'cloudfront list-response-headers-policies': { ResponseHeadersPolicyList: { Items: [] } },
    'cloudfront list-origin-access-controls': { OriginAccessControlList: { Items: [] } },
    'route53 get-hosted-zone': { HostedZone: { Name: 'cloversight.app.', Config: { PrivateZone: false } } },
    'route53 list-resource-record-sets': { ResourceRecordSets: [] },
    'ses describe-receipt-rule-set': { Rules: [] },
    'ses get-identity-verification-attributes': { VerificationAttributes: {} },
    'service-quotas list-service-quotas': { Quotas: [] },
  };
}
function run(data, env = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloversight-preflight-'));
  try {
    fs.writeFileSync(path.join(directory, 'responses.json'), JSON.stringify(data));
    fs.writeFileSync(path.join(directory, 'aws'), `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst a=process.argv.slice(2); const i=a.findIndex(x=>['acm','ecr','cloudformation','cloudfront','route53','ses','service-quotas','cognito-idp'].includes(x)); const key=a[i]+' '+a[i+1]; const data=JSON.parse(fs.readFileSync(process.env.AWS_FIXTURES)); if(!(key in data)) throw new Error('Unexpected call: '+key); const value=data[key+' '+a[a.indexOf('--domain')+1]] || data[key]; if(value.error){process.stderr.write(value.error);process.exit(1);} console.log(JSON.stringify(value));\n`, { mode: 0o755 });
    return spawnSync(process.execPath, ['scripts/aws-deploy-preflight.mjs'], { encoding: 'utf8', env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, AWS_FIXTURES: path.join(directory, 'responses.json'),
      AWS_ACCOUNT_ID: account, AWS_REGION: 'us-east-1', WW_CERT_ARN: `arn:aws:acm:us-east-1:${account}:certificate/test`,
      WW_STACK_NAME: 'webwatch-prod', WW_PUBLIC_DOMAIN: 'cloversight.app', WW_LEGACY_CUSTOMER_DOMAIN: 'login.cloversight.app', WW_STEWARD_DOMAIN: 'stewards.cloversight.app',
      WW_CUSTOMER_COGNITO_MODE: 'prefix', WW_CUSTOMER_COGNITO_PREFIX: 'cloversight-prod-customer', WW_STEWARD_COGNITO_PREFIX: 'cloversight-prod-steward', WW_WORKER_IMAGE_URI: `${account}.dkr.ecr.us-east-1.amazonaws.com/webwatch-browser-worker@sha256:${'a'.repeat(64)}`,
      WW_HOSTED_ZONE_ID: 'Z123456', WW_REPLY_DOMAIN: 'reply.cloversight.app', WW_SES_RULE_SET: 'webwatch-shared-inbound', WW_STAGE_BASE_DOMAIN: 'cloversight.app',
      WW_STAGE: 'prod', WW_OPS_EMAIL: '', WW_SCOPED_BUDGET_ENABLED: 'false', ...env,
    } });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
test('new-account prerequisites and available edge capacity pass', () => {
  const result = run(responses()); assert.equal(result.status, 0, result.stderr);
});
test('partial-stack distributions are recognized without completed-stack outputs', () => {
  const data = responses();
  data['cloudformation describe-stacks'] = { Stacks: [{ StackId: stackId, StackStatus: 'CREATE_FAILED' }] };
  data['cloudformation list-stack-resources'].StackResourceSummaries = [{ ResourceType: 'AWS::CloudFront::Distribution', LogicalResourceId: 'PublicDistribution', PhysicalResourceId: 'OWNED', ResourceStatus: 'CREATE_COMPLETE' }];
  data['cloudfront list-distributions'].DistributionList.Items = [{ Id: 'OWNED', Aliases: { Items: ['cloversight.app'] } }];
  const result = run(data); assert.equal(result.status, 0, result.stderr);
});
test('DNS, SES, function-name, capacity and permissions problems fail before deployment', () => {
  const cases = [
    [d => { d['cognito-idp describe-user-pool-domain'].DomainDescription = { UserPoolId: 'us-east-1_other' }; }, /belongs to another user pool/],
    [d => { d['route53 get-hosted-zone'].HostedZone.Config.PrivateZone = true; }, /public hosted zone/],
    [d => { d['route53 list-resource-record-sets'].ResourceRecordSets = [{ Name: 'cloversight.app.', Type: 'A' }]; }, /unmanaged A\/CNAME/],
    [d => { d['ses describe-receipt-rule-set'] = { error: 'RuleSetDoesNotExist' }; }, /RuleSetDoesNotExist/],
    [d => { d['ses get-identity-verification-attributes'].VerificationAttributes['cloversight.app'] = { VerificationStatus: 'Success' }; }, /outside this stack/],
    [d => { d['cloudfront list-functions'].FunctionList.Items = [{ Name: 'webwatch-prod-steward-spa-rewrite' }]; }, /exists outside this stack/],
    [d => { d['cloudfront list-functions'].FunctionList.Items = Array.from({ length: 100 }, (_, i) => ({ Name: `other-${i}` })); }, /exceeds 100/],
    [d => { d['service-quotas list-service-quotas'].Quotas = [{ QuotaName: 'Cache policies per account', Value: 1 }]; }, /exceeds 1/],
    [d => { d['cloudformation describe-stacks'] = { error: 'AccessDenied: not authorized' }; }, /AccessDenied/],
  ];
  for (const [change, message] of cases) {
    const data = responses(); change(data); const result = run(data);
    assert.notEqual(result.status, 0); assert.match(result.stderr, message);
  }
});

test('Cognito domains owned by a preserved pool and explicitly absent domains are accepted', () => {
  const data = responses();
  data['cloudformation describe-stacks'] = { Stacks: [{ StackId: stackId, StackStatus: 'CREATE_FAILED' }] };
  data['cloudformation list-stack-resources'].StackResourceSummaries = [{ ResourceType: 'AWS::Cognito::UserPool', LogicalResourceId: 'CustomerUserPool', PhysicalResourceId: 'us-east-1_owned', ResourceStatus: 'CREATE_COMPLETE' }];
  data['cognito-idp describe-user-pool-domain cloversight-prod-customer'] = { DomainDescription: { UserPoolId: 'us-east-1_owned' } };
  data['cognito-idp describe-user-pool-domain cloversight-prod-steward'] = { error: 'An error occurred (ResourceNotFoundException)' };
  const result = run(data); assert.equal(result.status, 0, result.stderr);
});

test('adding a branded host preserves existing branding and checks the prefix, certificate and auth DNS', () => {
  const env = { WW_CUSTOMER_COGNITO_MODE: 'custom-with-prefix', WW_CUSTOMER_COGNITO_DOMAIN: 'auth.cloversight.app', WW_CUSTOMER_COGNITO_CERT_ARN: `arn:aws:acm:us-east-1:${account}:certificate/test` };
  const data = responses();
  data['cloudformation describe-stacks'] = { Stacks: [{ StackId: stackId, StackStatus: 'UPDATE_COMPLETE' }] };
  data['cloudformation list-stack-resources'].StackResourceSummaries = [{ LogicalResourceId: 'CustomerManagedLoginBranding', PhysicalResourceId: 'style', ResourceStatus: 'CREATE_COMPLETE' }];
  assert.equal(run(data, env).status, 0);
  assert.match(run(data, { ...env, WW_CUSTOMER_COGNITO_MODE: 'custom' }).stderr, /custom-with-prefix/);
  data['route53 list-resource-record-sets'].ResourceRecordSets.push({ Name: 'auth.cloversight.app.', Type: 'CNAME' });
  assert.match(run(data, env).stderr, /unmanaged.*auth\.cloversight/);
  data['cognito-idp describe-user-pool-domain cloversight-prod-customer'] = { DomainDescription: { UserPoolId: 'other' } };
  assert.match(run(data, env).stderr, /belongs to another user pool/);
});
