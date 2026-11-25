import fs from 'node:fs';
import path from 'node:path';
import { CHECK_REGIONS, normalizeCheckRegions } from '../domain/regions.mjs';

const DEFAULT_BASE_DOMAIN = 'cloversight.app';
const DEFAULT_REGION = 'us-east-1';
const MFA_VALUES = new Set(['OFF', 'OPTIONAL', 'ON']);
const COGNITO_DOMAIN_MODES = new Set(['prefix', 'none', 'custom', 'custom-with-prefix']);
const DOC_IPV4 = ['192.0.2.', '198.51.100.', '203.0.113.'];

function expandIpv6Cidr(value, lineNumber) {
  const [address, prefix] = value.toLowerCase().split('/');
  if ((address.match(/::/g) ?? []).length > 1) throw new Error(`Invalid IPv6 CIDR on line ${lineNumber}.`);
  const compressed = address.includes('::');
  const [leftText, rightText = ''] = address.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const provided = left.length + right.length;
  if ((!compressed && provided !== 8) || (compressed && provided >= 8) || [...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/.test(word))) {
    throw new Error(`Invalid IPv6 CIDR on line ${lineNumber}.`);
  }
  const words = compressed ? [...left, ...Array(8 - provided).fill('0'), ...right] : left;
  return `${words.map((word) => word.padStart(4, '0')).join(':')}/${prefix}`;
}

export function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Expected a boolean value, received ${value}.`);
}

function numberSetting(name, value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function integerSetting(name, value, fallback, minimum, maximum) {
  const number = numberSetting(name, value == null || value === '' ? undefined : value, fallback, minimum, maximum);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer.`);
  return number;
}

function paymentOriginsSetting(value) {
  const origins = String(value || '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    let url;
    try { url = new URL(item); } catch { throw new Error('STRIPE_PAYMENT_ORIGINS must contain comma-separated exact HTTPS origins.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('STRIPE_PAYMENT_ORIGINS must contain exact HTTPS origins without credentials, paths, queries, or fragments.');
    }
    return url.origin;
  });
  const normalized = [...new Set(origins)].join(',');
  if (normalized.length > 512) throw new Error('STRIPE_PAYMENT_ORIGINS must be at most 512 characters after normalization.');
  return normalized;
}

function mfaSetting(name, value, fallback = 'OFF') {
  const normalized = String(value || fallback).trim().toUpperCase();
  if (!MFA_VALUES.has(normalized)) throw new Error(`${name} must be OFF, OPTIONAL, or ON.`);
  return normalized;
}

function emailSetting(name, value) {
  const normalized = String(value || '').trim();
  if (normalized && (normalized.length > 254 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(normalized))) {
    throw new Error(`${name} must be one email address, without display names or a recipient list.`);
  }
  return normalized;
}

export function deriveDomains({ stage = 'staging', baseDomain = DEFAULT_BASE_DOMAIN } = {}) {
  const cleanStage = String(stage).trim().toLowerCase();
  const cleanBase = String(baseDomain).trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(cleanBase)) throw new Error('BASE_DOMAIN must be a valid DNS name.');
  const normalizedStage = cleanStage === 'production' ? 'prod' : cleanStage;
  if (!['staging', 'beta', 'prod'].includes(normalizedStage)) throw new Error('STAGE must be staging, beta, or prod.');
  const isStaging = normalizedStage === 'staging';
  const isBeta = normalizedStage === 'beta';
  const isProduction = normalizedStage === 'prod';
  const stageBase = isStaging ? `staging.${cleanBase}` : cleanBase;
  return {
    baseDomain: cleanBase,
    stage: normalizedStage,
    isStaging,
    isBeta,
    isProduction,
    stageBase,
    publicDomain: stageBase,
    customerDomain: stageBase,
    legacyCustomerDomain: `login.${stageBase}`,
    customerAuthDomain: `auth.${stageBase}`,
    stewardDomain: `stewards.${stageBase}`,
    replyDomain: `reply.${stageBase}`,
    customerCallbackUrl: `https://${stageBase}/app/`,
    stewardCallbackUrl: `https://stewards.${stageBase}/`,
  };
}

export function parseIpAllowlist(text) {
  const ipv4 = [];
  const ipv6 = [];
  for (const [index, raw] of String(text).split(/\r?\n/).entries()) {
    const value = raw.replace(/\s+#.*$/, '').trim();
    if (!value || value.startsWith('#')) continue;
    if (!value.includes('/')) throw new Error(`IP allow-list line ${index + 1} must be CIDR notation.`);
    if (value.includes(':')) {
      if (!/^[0-9a-fA-F:]+\/(?:\d|[1-9]\d|1[01]\d|12[0-8])$/.test(value)) throw new Error(`Invalid IPv6 CIDR on line ${index + 1}.`);
      ipv6.push(expandIpv6Cidr(value, index + 1));
    } else {
      const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/);
      if (!match || match.slice(1, 5).some((part) => Number(part) > 255)) throw new Error(`Invalid IPv4 CIDR on line ${index + 1}.`);
      ipv4.push(value);
    }
  }
  return { ipv4: [...new Set(ipv4)], ipv6: [...new Set(ipv6)] };
}

export function readIpAllowlist(filePath) {
  const absolute = path.resolve(filePath);
  const parsed = parseIpAllowlist(fs.readFileSync(absolute, 'utf8'));
  if (!parsed.ipv4.length && !parsed.ipv6.length) throw new Error(`No CIDRs were found in ${absolute}.`);
  return parsed;
}

export function isDocumentationCidr(cidr) {
  const normalized = String(cidr).toLowerCase();
  return DOC_IPV4.some((prefix) => normalized.startsWith(prefix)) || normalized.startsWith('2001:db8:') || normalized.startsWith('2001:0db8:') || normalized === '2001:db8::/32';
}

export function assertDeployableAllowlist(allowlist) {
  const all = [...(allowlist?.ipv4 ?? []), ...(allowlist?.ipv6 ?? [])];
  if (!all.length) throw new Error('Staging requires at least one IPv4 or IPv6 CIDR.');
  const documentation = all.filter(isDocumentationCidr);
  if (documentation.length) throw new Error(`Replace documentation-only CIDRs before deployment: ${documentation.join(', ')}`);
  return allowlist;
}

function defaultCognitoPrefix(accountId, stage, portal) {
  if (!accountId) return '';
  return `webwatch-${accountId.slice(-8)}-${stage}-${portal}`.slice(0, 63).replace(/-+$/g, '');
}

export function loadDeploymentSettings(env = process.env) {
  const stage = env.STAGE || 'staging';
  const domains = deriveDomains({ stage, baseDomain: env.BASE_DOMAIN || DEFAULT_BASE_DOMAIN });
  const accountId = String(env.AWS_ACCOUNT_ID || '').trim();
  if (accountId && !/^\d{12}$/.test(accountId)) throw new Error('AWS_ACCOUNT_ID must be a 12-digit account ID.');
  const region = env.AWS_REGION || DEFAULT_REGION;
  if (region !== DEFAULT_REGION) throw new Error('This release is pinned to us-east-1 (N. Virginia) for the initial deployment.');
  const allowlistFile = env.STAGING_IP_ALLOWLIST_FILE || '.local/staging-ip-allowlist.txt';
  const dnsProvider = String(env.DNS_PROVIDER || 'route53').trim().toLowerCase();
  if (dnsProvider !== 'route53') throw new Error('DNS_PROVIDER must be route53 for this release.');
  const route53HostedZoneId = String(env.ROUTE53_HOSTED_ZONE_ID || '').trim().replace(/^\/hostedzone\//, '');
  if (route53HostedZoneId && !/^[A-Z0-9]{8,32}$/.test(route53HostedZoneId)) throw new Error('ROUTE53_HOSTED_ZONE_ID must be the hosted-zone ID, without /hostedzone/.');
  const certificateArn = env.CLOUDFRONT_CERTIFICATE_ARN || '';
  if (certificateArn && !certificateArn.startsWith(`arn:aws:acm:${region}:`)) throw new Error('CLOUDFRONT_CERTIFICATE_ARN must identify an ACM certificate in us-east-1.');
  if (certificateArn && accountId && !certificateArn.startsWith(`arn:aws:acm:${region}:${accountId}:certificate/`)) throw new Error('CLOUDFRONT_CERTIFICATE_ARN must belong to AWS_ACCOUNT_ID.');
  const workerImageUri = env.WORKER_IMAGE_URI || '';
  if (workerImageUri && !/@sha256:[a-f0-9]{64}$/.test(workerImageUri)) throw new Error('WORKER_IMAGE_URI must be immutable and end in @sha256:<64 lowercase hex characters>.');
  const twilioValues = [env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM].map((value) => String(value || '').trim());
  const twilioValueCount = twilioValues.filter(Boolean).length;
  if (twilioValueCount > 0 && twilioValueCount < twilioValues.length) throw new Error('Twilio is optional, but TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM must either all be configured or all be blank.');
  const twilioEnabled = twilioValueCount === twilioValues.length;
  const originVerifyRevision = String(env.ORIGIN_VERIFY_REVISION || '1').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(originVerifyRevision)) throw new Error('ORIGIN_VERIFY_REVISION must contain only letters, numbers, dot, underscore, or hyphen and be at most 64 characters.');
  const requestedCheckRegions = String(env.REGIONAL_CHECK_REGIONS || CHECK_REGIONS.map((item) => item.id).join(',')).split(',').map((value) => value.trim()).filter(Boolean);
  const availableCheckRegions = normalizeCheckRegions(requestedCheckRegions);
  const unsupportedCheckRegions = requestedCheckRegions.filter((value) => !CHECK_REGIONS.some((item) => item.id === value));
  if (unsupportedCheckRegions.length) throw new Error(`REGIONAL_CHECK_REGIONS contains unsupported regions: ${unsupportedCheckRegions.join(', ')}.`);
  if (!availableCheckRegions.includes(region)) throw new Error(`REGIONAL_CHECK_REGIONS must include the primary region ${region}.`);
  if (availableCheckRegions.length < 3) throw new Error('REGIONAL_CHECK_REGIONS must include at least three supported AWS regions to provide the Team plan regional monitoring entitlement. Deploy their regional capture stacks before enabling watcher checks.');
  const reservedCheckConcurrency = integerSetting('RESERVED_CHECK_CONCURRENCY', env.RESERVED_CHECK_CONCURRENCY, 2, 2, 25);
  const workerReservedConcurrency = integerSetting('WORKER_RESERVED_CONCURRENCY', env.WORKER_RESERVED_CONCURRENCY, 4, 4, 30);
  const reservedCaptureConcurrency = integerSetting('CAPTURE_RESERVED_CONCURRENCY', env.CAPTURE_RESERVED_CONCURRENCY, 64, 2, 500);
  // The worker consumes both check-dispatch and capture-result queues. Keep two
  // slots available for aggregation in addition to the configured check slots,
  // otherwise the event-source mappings can continuously throttle one another.
  if (workerReservedConcurrency < reservedCheckConcurrency + 2) {
    throw new Error('WORKER_RESERVED_CONCURRENCY must be at least RESERVED_CHECK_CONCURRENCY + 2.');
  }

  const customerCognitoDomainMode = String(env.COGNITO_CUSTOMER_DOMAIN_MODE || (domains.isProduction ? 'custom' : 'prefix')).trim().toLowerCase();
  if (!COGNITO_DOMAIN_MODES.has(customerCognitoDomainMode)) throw new Error('COGNITO_CUSTOMER_DOMAIN_MODE must be prefix, none, custom, or custom-with-prefix.');
  const customLogin = ['custom', 'custom-with-prefix'].includes(customerCognitoDomainMode);
  const cognitoEmailDelivery = String(env.COGNITO_EMAIL_DELIVERY || (domains.isProduction ? 'ses' : 'cognito')).trim().toLowerCase();
  if (!['cognito', 'ses'].includes(cognitoEmailDelivery)) throw new Error('COGNITO_EMAIL_DELIVERY must be cognito or ses.');
  const customerCognitoCertificateArn = env.COGNITO_CUSTOMER_CERTIFICATE_ARN || certificateArn;
  if (customLogin && customerCognitoCertificateArn && !customerCognitoCertificateArn.startsWith(`arn:aws:acm:${region}:`)) throw new Error('COGNITO_CUSTOMER_CERTIFICATE_ARN must identify an ACM certificate in us-east-1.');
  if (customLogin && customerCognitoCertificateArn && accountId && !customerCognitoCertificateArn.startsWith(`arn:aws:acm:${region}:${accountId}:certificate/`)) throw new Error('COGNITO_CUSTOMER_CERTIFICATE_ARN must belong to AWS_ACCOUNT_ID.');

  const stewardMfa = mfaSetting('COGNITO_STEWARD_MFA', env.COGNITO_STEWARD_MFA, domains.isProduction ? 'ON' : 'OFF');
  const technicalAlertsEnabled = parseBoolean(env.TECHNICAL_ALERTS_ENABLED, domains.isProduction);
  const technicalAlertEmail = emailSetting('TECHNICAL_ALERT_EMAIL', env.TECHNICAL_ALERT_EMAIL || '');
  const opsAlertEmail = emailSetting('OPS_ALERT_EMAIL', env.OPS_ALERT_EMAIL || (!domains.isProduction && technicalAlertsEnabled ? technicalAlertEmail : ''));
  const budgetAlertEmail = emailSetting('BUDGET_ALERT_EMAIL', env.BUDGET_ALERT_EMAIL || (!domains.isProduction && technicalAlertsEnabled ? technicalAlertEmail : ''));
  if (domains.isProduction) {
    if (stewardMfa !== 'ON') throw new Error('Production requires COGNITO_STEWARD_MFA=ON. Staging and beta retain their separately configured MFA policy.');
    if (!technicalAlertsEnabled) throw new Error('Production requires TECHNICAL_ALERTS_ENABLED=true.');
    if (!technicalAlertEmail || !opsAlertEmail || !budgetAlertEmail) throw new Error('Production requires explicit TECHNICAL_ALERT_EMAIL, OPS_ALERT_EMAIL, and BUDGET_ALERT_EMAIL destinations. Confirm SNS subscriptions before enabling customer work.');
  }
  if (technicalAlertsEnabled && !technicalAlertEmail) throw new Error('Set TECHNICAL_ALERT_EMAIL when enabling technical alerts.');
  const scopedBudgetEnabled = parseBoolean(env.SCOPED_BUDGET_ENABLED, false);
  const costAllocationTagsActivated = parseBoolean(env.COST_ALLOCATION_TAGS_ACTIVATED, false);
  if (scopedBudgetEnabled && !costAllocationTagsActivated) throw new Error('SCOPED_BUDGET_ENABLED requires COST_ALLOCATION_TAGS_ACTIVATED=true after activating Application and Stage in AWS Billing. AWS deployment preflight also checks their active status.');
  if (scopedBudgetEnabled && !budgetAlertEmail) throw new Error('SCOPED_BUDGET_ENABLED requires a BUDGET_ALERT_EMAIL destination.');
  const resourceOwner = String(env.RESOURCE_OWNER || 'CLOVERSIGHT').trim();
  if (!/^[A-Za-z0-9._@+-]{1,128}$/.test(resourceOwner)) throw new Error('RESOURCE_OWNER must contain 1-128 letters, numbers, dot, underscore, @, plus or hyphen.');

  return {
    ...domains,
    accountId,
    region,
    profile: env.AWS_PROFILE || '',
    stackName: env.STACK_NAME || `webwatch-${domains.stage}`,
    bootstrapStackName: env.BOOTSTRAP_STACK_NAME || 'webwatch-deployment-bootstrap',
    artifactBucket: env.ARTIFACT_BUCKET || '',
    dnsProvider,
    route53HostedZoneId,
    cloudFrontCertificateArn: certificateArn,
    deploymentPrincipalArn: env.AWS_DEPLOYMENT_PRINCIPAL_ARN || '',
    deploymentRoleArn: env.AWS_DEPLOYMENT_ROLE_ARN || '',
    cloudFormationExecutionRoleArn: env.AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN || '',
    workerRepository: env.WORKER_ECR_REPOSITORY || 'webwatch-browser-worker',
    workerImageTag: env.WORKER_IMAGE_TAG || 'lambda-chromium153-playwright-1.63.0-node22-r43',
    workerImageUri,
    availableCheckRegions,
    twilioEnabled,
    allowlistFile,
    stagingChatGptBrowserEnabled: domains.isStaging && parseBoolean(env.STAGING_CHATGPT_BROWSER_ENABLED, true),
    allowlist: domains.isStaging ? readIpAllowlist(allowlistFile) : { ipv4: [], ipv6: [] },
    cognitoCustomerDomainPrefix: env.COGNITO_CUSTOMER_DOMAIN_PREFIX || defaultCognitoPrefix(accountId, domains.stage, 'customers'),
    customerCognitoDomainMode,
    cognitoEmailDelivery,
    customerCognitoCertificateArn,
    cognitoStewardDomainPrefix: env.COGNITO_STEWARD_DOMAIN_PREFIX || defaultCognitoPrefix(accountId, domains.stage, 'stewards'),
    customerMfa: mfaSetting('COGNITO_CUSTOMER_MFA', env.COGNITO_CUSTOMER_MFA, 'OFF'),
    stewardMfa,
    sesRegion: env.SES_REGION || region,
    sesFromAddress: env.SES_FROM_ADDRESS || `alerts@${domains.stageBase}`,
    sesReplyDomain: env.SES_REPLY_DOMAIN || domains.replyDomain,
    sesRuleSetName: env.SES_RECEIPT_RULE_SET_NAME || 'webwatch-shared-inbound',
    originVerifyRevision,
    technicalAlertsEnabled,
    technicalAlertEmail,
    opsAlertEmail,
    budgetAlertEmail,
    scopedBudgetEnabled,
    costAllocationTagsActivated,
    scopedMonthlyBudgetUsd: numberSetting('SCOPED_MONTHLY_BUDGET_USD', env.SCOPED_MONTHLY_BUDGET_USD, domains.isProduction ? 100 : 25, 1, 100000),
    resourceOwner,
    reservedCaptureConcurrency,
    dispatchBatchSize: integerSetting('DISPATCH_BATCH_SIZE', env.DISPATCH_BATCH_SIZE, 500, 1, 1000),
    regionalCaptureConcurrency: integerSetting('REGIONAL_CAPTURE_CONCURRENCY', env.REGIONAL_CAPTURE_CONCURRENCY || undefined, reservedCaptureConcurrency, 2, 500),
    captureQueueMaxOutstanding: integerSetting('CAPTURE_QUEUE_MAX_OUTSTANDING', env.CAPTURE_QUEUE_MAX_OUTSTANDING, 256, 1, 1000),
    captureQueueHealthCacheSeconds: integerSetting('CAPTURE_QUEUE_HEALTH_CACHE_SECONDS', env.CAPTURE_QUEUE_HEALTH_CACHE_SECONDS, 10, 0, 60),
    captureQueueDeferralSeconds: integerSetting('CAPTURE_QUEUE_DEFERRAL_SECONDS', env.CAPTURE_QUEUE_DEFERRAL_SECONDS, 60, 15, 900),
    checkQueueMaxOutstanding: integerSetting('CHECK_QUEUE_MAX_OUTSTANDING', env.CHECK_QUEUE_MAX_OUTSTANDING, 500, 1, 1000),
    staffActionEmail: env.STAFF_ACTION_EMAIL || '',
    stewardOwnerSub: env.STEWARD_OWNER_SUB || '',
    monthlyBudgetUsd: numberSetting('MONTHLY_BUDGET_USD', env.MONTHLY_BUDGET_USD, domains.isProduction ? 100 : 25, 1, 100000),
    reservedCheckConcurrency,
    workerReservedConcurrency,
    retentionDays: numberSetting('SNAPSHOT_RETENTION_DAYS', env.SNAPSHOT_RETENTION_DAYS, 90, 1, 3650),
    closureGraceDays: numberSetting('ACCOUNT_CLOSURE_GRACE_DAYS', env.ACCOUNT_CLOSURE_GRACE_DAYS, 30, 1, 365),
    stripeRequestThreeDSecure: ['automatic', 'any'].includes(env.STRIPE_REQUEST_3DS) ? env.STRIPE_REQUEST_3DS : 'automatic',
    stripePaymentOrigins: paymentOriginsSetting(env.STRIPE_PAYMENT_ORIGINS),
  };
}

export function requiredDeploymentValues(settings) {
  const required = {
    AWS_ACCOUNT_ID: settings.accountId,
    ROUTE53_HOSTED_ZONE_ID: settings.route53HostedZoneId,
    CLOUDFRONT_CERTIFICATE_ARN: settings.cloudFrontCertificateArn,
    ARTIFACT_BUCKET: settings.artifactBucket,
    AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: settings.cloudFormationExecutionRoleArn,
    WORKER_IMAGE_URI: settings.workerImageUri,
    COGNITO_CUSTOMER_DOMAIN_PREFIX: ['prefix', 'custom-with-prefix'].includes(settings.customerCognitoDomainMode) ? settings.cognitoCustomerDomainPrefix : 'not-required',
    COGNITO_CUSTOMER_CERTIFICATE_ARN: ['custom', 'custom-with-prefix'].includes(settings.customerCognitoDomainMode) ? settings.customerCognitoCertificateArn : 'not-required',
    COGNITO_STEWARD_DOMAIN_PREFIX: settings.cognitoStewardDomainPrefix,
  };
  return Object.entries(required).filter(([, value]) => !String(value || '').trim()).map(([name]) => name);
}

export function cloudFormationList(values, safeFallback) {
  return values.length ? values.join(',') : safeFallback;
}
