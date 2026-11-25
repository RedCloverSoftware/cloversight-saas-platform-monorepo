import { loadEnvFile } from '../src/env.mjs';
loadEnvFile();
import { assertDeployableAllowlist, loadDeploymentSettings, requiredDeploymentValues } from '../src/deployment/settings.mjs';

const command = process.argv[2] ?? 'show';
const settings = loadDeploymentSettings();
if (command === 'validate') {
  const missing = requiredDeploymentValues(settings);
  if (settings.isStaging) assertDeployableAllowlist(settings.allowlist);
  if (missing.length) throw new Error(`Missing deployment values: ${missing.join(', ')}`);
  console.log('Deployment settings are valid.');
} else if (command === 'shell') {
  const q = (value) => `'${String(value ?? '').replaceAll("'", "'\"'\"'")}'`;
  const values = {
    WW_STAGE: settings.stage, WW_STACK_NAME: settings.stackName, WW_BASE_DOMAIN: settings.baseDomain, WW_STAGE_BASE_DOMAIN: settings.stageBase,
    WW_PUBLIC_DOMAIN: settings.publicDomain, WW_CUSTOMER_DOMAIN: settings.customerDomain, WW_LEGACY_CUSTOMER_DOMAIN: settings.legacyCustomerDomain, WW_STEWARD_DOMAIN: settings.stewardDomain, WW_REPLY_DOMAIN: settings.replyDomain,
    WW_HOSTED_ZONE_ID: settings.route53HostedZoneId, WW_CERT_ARN: settings.cloudFrontCertificateArn, WW_ARTIFACT_BUCKET: settings.artifactBucket,
    WW_EXECUTION_ROLE_ARN: settings.cloudFormationExecutionRoleArn, WW_WORKER_IMAGE_URI: settings.workerImageUri,
    WW_CUSTOMER_COGNITO_PREFIX: settings.cognitoCustomerDomainPrefix, WW_CUSTOMER_COGNITO_MODE: settings.customerCognitoDomainMode, WW_CUSTOMER_COGNITO_DOMAIN: settings.customerAuthDomain, WW_CUSTOMER_COGNITO_CERT_ARN: settings.customerCognitoCertificateArn, WW_STEWARD_COGNITO_PREFIX: settings.cognitoStewardDomainPrefix,
    WW_COGNITO_EMAIL_DELIVERY: settings.cognitoEmailDelivery,
    WW_CUSTOMER_MFA: settings.customerMfa, WW_STEWARD_MFA: settings.stewardMfa, WW_SES_FROM: settings.sesFromAddress, WW_SES_RULE_SET: settings.sesRuleSetName,
    WW_ORIGIN_VERIFY_REVISION: settings.originVerifyRevision,
    WW_STAGING_CHATGPT_BROWSER_ENABLED: String(settings.stagingChatGptBrowserEnabled),
    WW_IPV4: settings.allowlist.ipv4.join(','), WW_IPV6: settings.allowlist.ipv6.join(','), WW_ENABLE_IPV4: String(settings.allowlist.ipv4.length > 0), WW_ENABLE_IPV6: String(settings.allowlist.ipv6.length > 0),
    WW_TECH_ALERTS: String(settings.technicalAlertsEnabled), WW_TECH_EMAIL: settings.technicalAlertEmail, WW_STAFF_EMAIL: settings.staffActionEmail, WW_STEWARD_OWNER_SUB: settings.stewardOwnerSub,
    WW_OPS_EMAIL: settings.opsAlertEmail, WW_BUDGET_EMAIL: settings.budgetAlertEmail, WW_SCOPED_BUDGET_ENABLED: String(settings.scopedBudgetEnabled), WW_SCOPED_BUDGET: settings.scopedMonthlyBudgetUsd, WW_RESOURCE_OWNER: settings.resourceOwner,
    WW_BUDGET: settings.monthlyBudgetUsd, WW_CHECK_CONCURRENCY: settings.reservedCheckConcurrency, WW_WORKER_CONCURRENCY: settings.workerReservedConcurrency,
    WW_CHECK_REGIONS: settings.availableCheckRegions.join(','), WW_REGIONAL_CAPTURE_CONCURRENCY: settings.regionalCaptureConcurrency,
    WW_CAPTURE_CONCURRENCY: settings.reservedCaptureConcurrency, WW_DISPATCH_BATCH_SIZE: settings.dispatchBatchSize,
    WW_CAPTURE_QUEUE_MAX_OUTSTANDING: settings.captureQueueMaxOutstanding, WW_CAPTURE_QUEUE_HEALTH_CACHE_SECONDS: settings.captureQueueHealthCacheSeconds,
    WW_CAPTURE_QUEUE_DEFERRAL_SECONDS: settings.captureQueueDeferralSeconds, WW_CHECK_QUEUE_MAX_OUTSTANDING: settings.checkQueueMaxOutstanding,
    WW_RETENTION_DAYS: settings.retentionDays, WW_CLOSURE_DAYS: settings.closureGraceDays, WW_STRIPE_3DS: settings.stripeRequestThreeDSecure, WW_TWILIO_ENABLED: String(settings.twilioEnabled),
    WW_STRIPE_PAYMENT_ORIGINS: settings.stripePaymentOrigins,
  };
  for (const [key,value] of Object.entries(values)) console.log(`export ${key}=${q(value)}`);
} else if (command === 'json') {
  console.log(JSON.stringify(settings, null, 2));
} else {
  console.log(JSON.stringify({
    stackName: settings.stackName, accountId: settings.accountId, region: settings.region,
    domains: { public: settings.publicDomain, customer: settings.customerDomain, legacyCustomer: settings.legacyCustomerDomain, customerAuth: settings.customerAuthDomain, steward: settings.stewardDomain, reply: settings.replyDomain },
    customerCognitoDomainMode: settings.customerCognitoDomainMode,
    cognitoEmailDelivery: settings.cognitoEmailDelivery,
    twilioEnabled: settings.twilioEnabled,
    stagingChatGptBrowserEnabled: settings.stagingChatGptBrowserEnabled,
    allowlist: settings.allowlist,
  }, null, 2));
}
