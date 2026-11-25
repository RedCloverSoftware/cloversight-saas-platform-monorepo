import { awsJson, readStack, stackResources } from './aws-cli.mjs';

const region = process.env.AWS_REGION || 'us-east-1';
const certificateArn = required('WW_CERT_ARN');
const stackName = required('WW_STACK_NAME');
const aliases = [required('WW_PUBLIC_DOMAIN'), required('WW_LEGACY_CUSTOMER_DOMAIN'), required('WW_STEWARD_DOMAIN')].map((value) => value.toLowerCase());
const domainMode = required('WW_CUSTOMER_COGNITO_MODE');
const customerCustomDomain = ['custom', 'custom-with-prefix'].includes(domainMode) ? required('WW_CUSTOMER_COGNITO_DOMAIN').toLowerCase() : null;
const customerCertificateArn = customerCustomDomain ? required('WW_CUSTOMER_COGNITO_CERT_ARN') : null;
const workerImageUri = required('WW_WORKER_IMAGE_URI');

const arnParts = certificateArn.split(':');
if (arnParts.length < 6 || arnParts[2] !== 'acm' || arnParts[3] !== 'us-east-1') {
  throw new Error('CloudFront viewer certificate must be an ACM certificate in us-east-1.');
}

const certificate = awsJson(['acm', 'describe-certificate', '--certificate-arn', certificateArn]).Certificate;
if (!certificate) throw new Error('ACM did not return certificate details.');
if (certificate.Status !== 'ISSUED') throw new Error(`CloudFront ACM certificate status is ${certificate.Status || 'unknown'}; expected ISSUED.`);
const expiresAt = new Date(certificate.NotAfter);
if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new Error('CloudFront ACM certificate is expired or has an invalid NotAfter value.');

const sans = (certificate.SubjectAlternativeNames ?? []).map((value) => String(value).toLowerCase());
const uncovered = aliases.filter((alias) => !sans.some((san) => dnsNameCovers(san, alias)));
if (uncovered.length) throw new Error(`CloudFront ACM certificate does not cover: ${uncovered.join(', ')}.`);
if (customerCustomDomain) assertCertificate(customerCertificateArn, customerCustomDomain, 'Cognito custom-domain');

const workerImage = parseWorkerImage(workerImageUri);
if (workerImage.region !== region) throw new Error(`Worker ECR image is in ${workerImage.region}; expected ${region}.`);
if (process.env.AWS_ACCOUNT_ID && workerImage.accountId !== process.env.AWS_ACCOUNT_ID) throw new Error(`Worker ECR image belongs to AWS account ${workerImage.accountId}; expected ${process.env.AWS_ACCOUNT_ID}.`);
const imageDetails = awsJson(['ecr', 'describe-images', '--repository-name', workerImage.repository, '--image-ids', `imageDigest=${workerImage.digest}`]).imageDetails?.[0];
const allowedManifestTypes = new Set(['application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json']);
if (!allowedManifestTypes.has(imageDetails?.imageManifestMediaType)) {
  throw new Error(`Worker ECR image media type ${imageDetails?.imageManifestMediaType || 'unknown'} is not a Lambda-compatible single-image manifest. Rebuild it with npm run aws:build-worker.`);
}

const currentStack = readStack(stackName, region);
const ownedResources = stackResources(currentStack, region);
const hasResource = id => ownedResources.some(item => item.LogicalResourceId === id && item.PhysicalResourceId);
if (domainMode === 'custom' && hasResource('CustomerManagedLoginBranding')) {
  throw new Error('Use custom-with-prefix to keep the existing app client branding while adding its custom hostname.');
}
if (['prefix', 'custom-with-prefix'].includes(domainMode) && hasResource('CustomerCustomManagedLoginBranding')) {
  throw new Error('This installation already uses custom-only branding. Keep its installed custom mode.');
}
for (const [logicalPool, domain] of [
  ...(['prefix', 'custom-with-prefix'].includes(domainMode) ? [['CustomerUserPool', required('WW_CUSTOMER_COGNITO_PREFIX')]] : []),
  ...(customerCustomDomain ? [['CustomerUserPool', customerCustomDomain]] : []),
  ['StewardUserPool', required('WW_STEWARD_COGNITO_PREFIX')],
]) {
  let description;
  try { description = awsJson(['cognito-idp', 'describe-user-pool-domain', '--domain', domain]).DomainDescription; }
  catch (error) {
    if (!/\(ResourceNotFoundException\)/.test(error.message)) throw error;
  }
  if (description?.UserPoolId && !ownedResources.some((item) => item.LogicalResourceId === logicalPool && item.PhysicalResourceId === description.UserPoolId)) {
    throw new Error(`Cognito login domain ${domain} belongs to another user pool. Choose an unused domain or reconcile ownership before deployment.`);
  }
}
const ownedDistributionIds = new Set(ownedResources.filter((item) => item.ResourceType === 'AWS::CloudFront::Distribution').map((item) => item.PhysicalResourceId).filter(Boolean));
const distributionList = awsJson(['cloudfront', 'list-distributions']).DistributionList?.Items ?? [];
const conflicts = [];
for (const distribution of distributionList) {
  const distributionAliases = distribution.Aliases?.Items ?? [];
  for (const alias of distributionAliases) {
    const normalized = String(alias).toLowerCase();
    if (aliases.includes(normalized) && !ownedDistributionIds.has(distribution.Id)) conflicts.push(`${normalized} -> ${distribution.Id}`);
  }
}
if (conflicts.length) throw new Error(`CloudFront aliases are already attached to another distribution in this AWS account: ${conflicts.join(', ')}.`);

// Validate account-specific prerequisites before CloudFormation creates anything.
const zoneId = required('WW_HOSTED_ZONE_ID');
const zone = awsJson(['route53', 'get-hosted-zone', '--id', zoneId]).HostedZone;
const zoneName = String(zone?.Name || '').replace(/\.$/, '').toLowerCase();
if (!zoneName || zone?.Config?.PrivateZone) throw new Error('HOSTED_ZONE_ID must refer to a public hosted zone.');
for (const hostname of [...aliases, required('WW_REPLY_DOMAIN'), ...(customerCustomDomain ? [customerCustomDomain] : [])]) {
  if (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) throw new Error(`Hosted zone ${zoneName} does not contain ${hostname}.`);
}
const records = awsJson(['route53', 'list-resource-record-sets', '--hosted-zone-id', zoneId]).ResourceRecordSets ?? [];
const existingDns = [
  ['PublicDnsA', aliases[0], 'A'], ['PublicDnsAaaa', aliases[0], 'AAAA'],
  ['CustomerDnsA', aliases[1], 'A'], ['CustomerDnsAaaa', aliases[1], 'AAAA'],
  ['StewardDnsA', aliases[2], 'A'], ['StewardDnsAaaa', aliases[2], 'AAAA'],
  ...(customerCustomDomain ? [
    ['CustomerCognitoDnsA', customerCustomDomain, 'A'],
    ['CustomerCognitoDnsAaaa', customerCustomDomain, 'AAAA'],
  ] : []),
  ['ReplyMxRecord', required('WW_REPLY_DOMAIN'), 'MX'],
  ['SesMailFromMx', `mail.${required('WW_STAGE_BASE_DOMAIN')}`, 'MX'],
  ['SesMailFromSpf', `mail.${required('WW_STAGE_BASE_DOMAIN')}`, 'TXT'],
  ['SesDmarcRecord', `_dmarc.${required('WW_STAGE_BASE_DOMAIN')}`, 'TXT'],
];
for (const [logical, hostname, type] of existingDns) {
  if (type === 'AAAA' && process.env.WW_STAGE === 'staging' && process.env.WW_ENABLE_IPV6 !== 'true') continue;
  if (ownedResources.some((item) => item.LogicalResourceId === logical && item.PhysicalResourceId)) continue;
  if (records.some((record) => record.Name.toLowerCase().replace(/\.$/, '') === hostname && [type, 'CNAME'].includes(record.Type))) {
    throw new Error(`Route 53 already has an unmanaged ${type}/CNAME record for ${hostname}. Reconcile ownership before deploying; no DNS records were changed.`);
  }
}
awsJson(['ses', 'describe-receipt-rule-set', '--rule-set-name', required('WW_SES_RULE_SET')]);
const identityName = required('WW_STAGE_BASE_DOMAIN');
const identity = awsJson(['ses', 'get-identity-verification-attributes', '--identities', identityName]).VerificationAttributes?.[identityName];
if (identity && !ownedResources.some((item) => item.LogicalResourceId === 'SesDomainIdentity' && item.PhysicalResourceId)) {
  throw new Error(`SES identity ${identityName} already exists outside this stack. Reconcile its CloudFormation ownership before deployment; do not delete a working identity.`);
}

const quotaResponse = awsJson(['service-quotas', 'list-service-quotas', '--service-code', 'cloudfront']);
const quotas = quotaResponse.Quotas ?? [];
const stage = required('WW_STAGE');
const edgeFamilies = [
  ['list-functions', 'FunctionList', [], 'AWS::CloudFront::Function', ['public-rewrite', 'customer-spa-rewrite', 'customer-legacy-redirect', 'steward-spa-rewrite'], '', /^(cloudfront )?functions per (aws )?account$/i, 100],
  ['list-cache-policies', 'CachePolicyList', ['--type', 'custom'], 'AWS::CloudFront::CachePolicy', ['static-cache', 'api-no-cache'], 'CachePolicy', /cache policies/i, 20],
  ['list-origin-request-policies', 'OriginRequestPolicyList', ['--type', 'custom'], 'AWS::CloudFront::OriginRequestPolicy', ['api-origin'], 'OriginRequestPolicy', /origin request policies/i, 20],
  ['list-response-headers-policies', 'ResponseHeadersPolicyList', ['--type', 'custom'], 'AWS::CloudFront::ResponseHeadersPolicy', ['portal-security', 'public-security'], 'ResponseHeadersPolicy', /response headers policies/i, 20],
  ['list-origin-access-controls', 'OriginAccessControlList', [], 'AWS::CloudFront::OriginAccessControl', ['s3-oac'], '', /^origin access controls/i, 100],
];
for (const [operation, key, extra, type, suffixes, wrapper, quotaPattern, documentedLimit] of edgeFamilies) {
  const entries = listEdgeItems(operation, key, extra).map((entry) => wrapper ? entry[wrapper] : entry);
  const expectedNames = suffixes.map((suffix) => `webwatch-${stage}-${suffix}`);
  let additions = 0;
  for (const name of expectedNames) {
    const existing = entries.find((entry) => (entry.Name || entry[`${wrapper}Config`]?.Name) === name);
    if (!existing) { additions += 1; continue; }
    const ids = [existing.Id, existing.Name, existing.FunctionMetadata?.FunctionARN].filter(Boolean);
    if (!ownedResources.some((resource) => resource.ResourceType === type && ids.includes(resource.PhysicalResourceId))) {
      throw new Error(`CloudFront ${type} named ${name} exists outside this stack. Inspect the existing resource before proceeding; it will not be adopted or deleted automatically.`);
    }
  }
  const quota = quotas.find((item) => quotaPattern.test(item.QuotaName || ''));
  const limit = quota?.Value ?? documentedLimit;
  if (entries.length + additions > limit) throw new Error(`CloudFront ${type} capacity: ${entries.length} existing + ${additions} required exceeds ${limit}${quota ? '' : ' (documented default; verify any account-specific increase)'}.`);
  console.log(`CloudFront capacity ${type}: ${entries.length} existing + ${additions} new / ${limit}.`);
}
const distributionQuota = quotas.find((item) => /^distributions per (aws )?account$/i.test(item.QuotaName || ''))?.Value ?? 500;
const newDistributions = 3 - ownedDistributionIds.size;
if (distributionList.length + Math.max(0, newDistributions) > distributionQuota) throw new Error('CloudFront distribution quota is insufficient for this stack.');

if (process.env.WW_SCOPED_BUDGET_ENABLED === 'true') {
  const response = awsJson(['ce', 'list-cost-allocation-tags', '--tag-keys', 'Application', 'Stage', '--status', 'Active', '--type', 'UserDefined']);
  const activeKeys = new Set((response.CostAllocationTags || []).filter((item) => item.Status === 'Active').map((item) => item.TagKey));
  const inactive = ['Application', 'Stage'].filter((key) => !activeKeys.has(key));
  if (inactive.length) throw new Error(`Scoped budget allocation tags are not active in AWS Billing: ${inactive.join(', ')}. Activate them with billing-admin access and wait for their status before enabling SCOPED_BUDGET_ENABLED.`);
}

// Read-only rollout diagnostic. New stacks and changed destinations first need
// their subscription created by CloudFormation; confirmation happens by email.
// Pending subscriptions are never described as verified delivery.
if (process.env.WW_STAGE === 'prod' && process.env.WW_OPS_EMAIL) {
  const stack = awsJson(['cloudformation', 'describe-stacks', '--stack-name', stackName], { missingStackIsNull: true });
  const topic = stack?.Stacks?.[0]?.Outputs?.find((item) => item.OutputKey === 'OpsTopicArn')?.OutputValue;
  if (topic) {
    const subscriptions = awsJson(['sns', 'list-subscriptions-by-topic', '--topic-arn', topic]).Subscriptions || [];
    const confirmed = subscriptions.some((item) => item.Protocol === 'email' && String(item.Endpoint).toLowerCase() === process.env.WW_OPS_EMAIL.toLowerCase() && /^arn:/.test(item.SubscriptionArn || ''));
    if (!confirmed) console.warn('Operational SNS recipient is not confirmed on the existing primary topic. Confirm the CloudFormation-created subscription and verify every Region before admitting production customer work.');
  } else {
    console.warn('First deployment creates a pending operational SNS subscription. Confirm it and every regional subscription before admitting production customer work.');
  }
}

console.log(`AWS deployment preflight passed: ACM certificate is ISSUED through ${expiresAt.toISOString()}, required hostnames are covered, worker image is a single-image manifest, and no same-account alias conflicts were found.`);

function assertCertificate(arn, hostname, label) {
  const response = awsJson(['acm', 'describe-certificate', '--certificate-arn', arn]).Certificate;
  if (!response) throw new Error(`ACM did not return the ${label} certificate.`);
  if (response.Status !== 'ISSUED') throw new Error(`${label} ACM certificate status is ${response.Status || 'unknown'}; expected ISSUED.`);
  if (!Number.isFinite(Date.parse(response.NotAfter)) || Date.parse(response.NotAfter) <= Date.now()) throw new Error(`${label} ACM certificate has expired or lacks a valid expiry.`);
  const names = (response.SubjectAlternativeNames ?? []).map((value) => String(value).toLowerCase());
  if (!names.some((name) => dnsNameCovers(name, hostname))) throw new Error(`${label} ACM certificate does not cover ${hostname}.`);
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing preflight environment value ${name}.`);
  return value;
}

function parseWorkerImage(uri) {
  const match = uri.match(/^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/(.+)@(sha256:[a-f0-9]{64})$/);
  if (!match) throw new Error('WORKER_IMAGE_URI must be a digest-pinned ECR URI in the active AWS account/region.');
  return { accountId: match[1], region: match[2], repository: match[3], digest: match[4] };
}

function dnsNameCovers(san, hostname) {
  if (san === hostname) return true;
  if (!san.startsWith('*.')) return false;
  const suffix = san.slice(2);
  if (!hostname.endsWith(`.${suffix}`)) return false;
  const leftMost = hostname.slice(0, -(suffix.length + 1));
  return Boolean(leftMost) && !leftMost.includes('.');
}

function listEdgeItems(operation, key, extra) {
  const items = [];
  const seen = new Set();
  let marker;
  do {
    const result = awsJson(['cloudfront', operation, ...extra, '--no-paginate', ...(marker ? ['--marker', marker] : [])])[key] ?? {};
    items.push(...(result.Items ?? []));
    marker = result.NextMarker;
    if (marker && seen.has(marker)) throw new Error(`CloudFront ${operation} returned a repeated pagination marker.`);
    if (marker) seen.add(marker);
  } while (marker);
  return items;
}
