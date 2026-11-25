// Release an installed production stack using its current parameters as the source of truth.
import fs from 'node:fs';
import { docsOnly, installationFingerprint, readMarker, writeMarker } from './release-state.mjs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { awsJson, readStack } from './aws-cli.mjs';
import { deploymentMode } from './deployment-control.mjs';
import { loadDeploymentSettings } from '../src/deployment/settings.mjs';

export const account = '807434077491';
export const region = 'us-east-1';
export const stackName = 'webwatch-prod';
export const roleName = 'cloversight-github-production';
const publicUrl = 'https://cloversight.app';

function entries(rows, key, value) {
  return Object.fromEntries(rows.map(row => [row[key], row[value]]));
}

export function installedStack(name, location, lookup = readStack) {
  const stack = lookup(name, location);
  if (!stack || deploymentMode(stack) !== 'rollback' ||
      !stack.StackId.startsWith(`arn:aws:cloudformation:${location}:${account}:stack/${name}/`)) {
    throw new Error(`Finish the existing ${name} installation in ${location} before enabling CI releases.`);
  }
  return stack;
}

export function productionContext(lookup = readStack) {
  const primary = installedStack(stackName, region, lookup);
  const p = entries(primary.Parameters, 'ParameterKey', 'ParameterValue');
  const outputs = entries(primary.Outputs, 'OutputKey', 'OutputValue');
  if (p.Stage !== 'prod' || outputs.PublicUrl !== publicUrl || p.PublicDomainName !== 'cloversight.app' ||
      p.EnableLookupIndex !== 'true' || p.EnableIdentityIndex !== 'true' ||
      !primary.RoleARN?.startsWith(`arn:aws:iam::${account}:role/`)) {
    throw new Error('Expected the initialized Cloversight production stack with its execution role and both indexes.');
  }
  const prefix = `${account}.dkr.ecr.${region}.amazonaws.com/`;
  if (!p.WorkerImageUri?.startsWith(prefix) || !/@sha256:[a-f0-9]{64}$/.test(p.WorkerImageUri)) {
    throw new Error('Expected an immutable production worker image in the primary registry.');
  }
  // Only inputs used by the existing validation, upload and preflight scripts.
  // CloudFormation preserves all installed non-artifact parameters on release.
  const env = {
    AWS_ACCOUNT_ID: account, AWS_REGION: region, AWS_DEFAULT_REGION: region,
    STAGE: 'prod', STACK_NAME: stackName, BASE_DOMAIN: p.PublicDomainName,
    WORKER_IMAGE_URI: p.WorkerImageUri, WORKER_ECR_REPOSITORY: p.WorkerImageUri.slice(prefix.length).split('@')[0],
    ARTIFACT_BUCKET: p.ArtifactBucketName, AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: primary.RoleARN,
    ROUTE53_HOSTED_ZONE_ID: p.HostedZoneId, CLOUDFRONT_CERTIFICATE_ARN: p.CloudFrontCertificateArn,
    COGNITO_CUSTOMER_DOMAIN_MODE: p.CustomerCognitoDomainMode || 'prefix', COGNITO_CUSTOMER_DOMAIN_PREFIX: p.CustomerCognitoDomainPrefix,
    COGNITO_CUSTOMER_CERTIFICATE_ARN: p.CustomerCognitoCertificateArn, COGNITO_STEWARD_DOMAIN_PREFIX: p.StewardCognitoDomainPrefix,
    COGNITO_EMAIL_DELIVERY: p.CognitoEmailDelivery || 'cognito',
    COGNITO_STEWARD_MFA: p.StewardMfa, COGNITO_CUSTOMER_MFA: p.CustomerMfa,
    TECHNICAL_ALERTS_ENABLED: p.TechnicalAlertsEnabled, TECHNICAL_ALERT_EMAIL: p.TechnicalAlertEmail,
    OPS_ALERT_EMAIL: p.OpsAlertEmail, BUDGET_ALERT_EMAIL: p.BudgetAlertEmail, RESOURCE_OWNER: p.ResourceOwner,
    SCOPED_BUDGET_ENABLED: p.EnableScopedBudget, COST_ALLOCATION_TAGS_ACTIVATED: p.EnableScopedBudget,
    SES_RECEIPT_RULE_SET_NAME: p.SesReceiptRuleSetName, REGIONAL_CHECK_REGIONS: p.AvailableCheckRegions,
    RESERVED_CHECK_CONCURRENCY: p.ReservedCheckConcurrency, CAPTURE_RESERVED_CONCURRENCY: p.ReservedCaptureConcurrency,
    WORKER_RESERVED_CONCURRENCY: p.WorkerReservedConcurrency,
    WEBWATCH_DEPLOYMENT_ROLE_ACTIVE: 'true', CLOVERSIGHT_EXISTING_RELEASE: '1',
  };
  const settings = loadDeploymentSettings(env);
  const stacks = [primary];
  for (const location of settings.availableCheckRegions.filter(r => r !== region)) {
    const regional = installedStack(`${stackName}-regional-${location}`, location, lookup);
    if (regional.RoleARN !== primary.RoleARN) throw new Error(`Unexpected execution role in ${location}.`);
    stacks.push(regional);
  }
  return { env, outputs, stacks, regions: settings.availableCheckRegions };
}

function run(command, args, env) {
  execFileSync(command, args, { env, stdio: 'inherit' });
}

function smoke() {
  // Check the exact deployed bytes. A generic HTTP 200 might be a fallback or an old release.
  for (const [url, file] of [
    [publicUrl + '/', 'dist/public/index.html'],
    [publicUrl + '/pricing', 'dist/public/pricing.html'],
    [publicUrl + '/sitemap.xml', 'dist/public/sitemap.xml'],
    ...fs.readdirSync('dist/public/_astro').map(name => [publicUrl + '/_astro/' + name, 'dist/public/_astro/' + name]),
    [publicUrl + '/app/', 'apps/customer/index.html'],
    [publicUrl + '/runtime-config.json', '.local/customer-runtime-config.json'],
    ['https://stewards.cloversight.app/runtime-config.json', '.local/steward-runtime-config.json'],
    ['https://stewards.cloversight.app/', 'apps/steward/index.html'],
  ]) {
    const actual = execFileSync('curl', ['--fail', '--silent', '--show-error', '--compressed', '--retry', '3', '--max-time', '25', url]);
    if (!actual.equals(fs.readFileSync(file))) throw new Error(`Deployed content differs from the release at ${url}.`);
  }
  const health = execFileSync('curl', ['--fail', '--silent', '--show-error', '--retry', '3', '--max-time', '25', publicUrl + '/api/health']);
  if (JSON.parse(health).status !== 'healthy') throw new Error('Public API health check failed.');
}

export function release(operation) {
  if (!['inspect', 'deploy'].includes(operation)) throw new Error('Expected inspect or deploy.');
  if (fs.existsSync('.env') || process.env.AWS_PROFILE) throw new Error('Run from a clean runner checkout with OIDC credentials.');
  const identity = awsJson(['sts', 'get-caller-identity'], { region });
  if (identity.Account !== account || !identity.Arn.startsWith(`arn:aws:sts::${account}:assumed-role/${roleName}/`)) {
    throw new Error('Unexpected AWS release role or account.');
  }
  const context = productionContext();
  const env = { ...process.env, ...context.env };
  const revision = { sha: env.GITHUB_SHA, repositoryId: env.GITHUB_REPOSITORY_ID,
    fingerprint: installationFingerprint(context.stacks), event: env.GITHUB_EVENT_NAME };
  if (operation === 'deploy' && revision.event === 'push' && docsOnly(readMarker(env.ARTIFACT_BUCKET), revision)) {
    const message = 'Verification passed. Only engineering documentation changed since the last successful production release. AWS deployment skipped.';
    console.log(message);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, message + '\n');
    return;
  }
  run('node', ['scripts/deployment-settings.mjs', 'validate'], env);
  // Both inspect and deploy check the currently installed configuration before any writes.
  run('bash', ['-ec', 'eval "$(node scripts/deployment-settings.mjs shell)"\nnode scripts/aws-deploy-preflight.mjs\nnode scripts/check-lambda-capacity.mjs'], env);
  for (const stack of context.stacks.slice(1)) {
    const location = stack.StackId.split(':')[3];
    const parameters = entries(stack.Parameters, 'ParameterKey', 'ParameterValue');
    const registry = `${account}.dkr.ecr.${location}.amazonaws.com/${env.WORKER_ECR_REPOSITORY}@`;
    const uri = parameters.ImageUri || '';
    if (!uri.startsWith(registry) || !/^sha256:[a-f0-9]{64}$/.test(uri.slice(registry.length))) {
      throw new Error(`Unexpected installed image registry or digest in ${location}.`);
    }
    awsJson(['ecr', 'describe-images', '--repository-name', env.WORKER_ECR_REPOSITORY, '--image-ids', 'imageDigest=' + uri.slice(registry.length)], { region: location });
    run('node', ['scripts/check-lambda-capacity.mjs', '--regional', location], {
      ...env, WW_STAGE: 'prod', WW_CHECK_REGIONS: env.REGIONAL_CHECK_REGIONS,
      WW_REGIONAL_CAPTURE_CONCURRENCY: parameters.ReservedCaptureConcurrency,
    });
  }
  console.log('Installed production stacks:', context.stacks.map(stack => stack.StackId).join(', '));
  if (operation === 'inspect') return;
  if (!/^[0-9a-f]{40}$/.test(revision.sha) || !/^\d+$/.test(revision.repositoryId)) throw new Error('Missing GitHub release identity.');
  writeMarker(env.ARTIFACT_BUCKET, { ...revision, state: 'deploying' });
  run('bash', ['infra/github/prepare-worker.sh'], env);
  const contract = fs.readFileSync('.local/worker-image.env', 'utf8');
  const uri = /^WORKER_IMAGE_URI=(.+)$/m.exec(contract)?.[1];
  if (!uri || uri.split('@')[0] !== env.WORKER_IMAGE_URI.split('@')[0] || !/@sha256:[a-f0-9]{64}$/.test(uri)) {
    throw new Error('Invalid release worker digest.');
  }
  env.WORKER_IMAGE_URI = uri;
  for (const script of ['deploy', 'deploy-regional-captures', 'deploy-web']) run('bash', [`infra/scripts/${script}.sh`], env);
  smoke();
  writeMarker(env.ARTIFACT_BUCKET, { ...revision, fingerprint: installationFingerprint(productionContext().stacks), state: 'succeeded' });
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Released \`${process.env.GITHUB_SHA}\` to \`${stackName}\` using \`${uri}\`. Three portals, pricing, sitemap, compiled assets and API health passed.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) release(process.argv[2]);
