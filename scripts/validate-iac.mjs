import { workerBase } from './worker-base.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const templateFile = 'infra/cloudformation/webwatch.yaml';
const python = await fs.access('.local/iac-venv/bin/python').then(() => '.local/iac-venv/bin/python', () => 'python3');
const template = await fs.readFile(templateFile, 'utf8');
const requiredTemplateTokens = [
  'AWSTemplateFormatVersion', 'AWS::DynamoDB::Table', 'AWS::S3::Bucket', 'AWS::SQS::Queue',
  'AWS::Cognito::UserPool', 'AWS::Lambda::Function',
  'AWS::CloudFront::Distribution', 'AWS::WAFv2::WebACL', 'AWS::WAFv2::IPSet',
  'AWS::Budgets::Budget', 'AWS::IAM::Role', 'AWS::Logs::LogGroup', 'AWS::SES::ReceiptRule',
  'RetentionDays', 'ApiRole', 'WorkerRole', 'ReportRole', 'DispatcherRole', 'CaptureFunction', 'InboundEmailFunction',
  'StripeWebhookRoute', 'TwilioInboundRoute', 'CheckStatusRoute', 'ReportsRoute', 'TeamProxyRoute', 'ActionLogRoute', 'CustomerUserPool', 'StewardUserPool',
  'ReportFunction', 'ReportQueue', 'ReportDeadLetterQueue', 'ReportErrorAlarm', 'ReportDlqAlarm',
  'CaptureQueue', 'CaptureDeadLetterQueue', 'CaptureResultQueue', 'CaptureResultDeadLetterQueue', 'CaptureDlqAlarm', 'CaptureResultDlqAlarm',
  'IdentityIndex', 'CAPTURE_QUEUE_NAME', 'CAPTURE_RESULT_QUEUE_URL', 'ReportBatchItemFailures',
];
const missingTokens = requiredTemplateTokens.filter((value) => !template.includes(value));
if (missingTokens.length) throw new Error(`IaC template missing: ${missingTokens.join(', ')}`);

const requiredFiles = [
  'infra/bootstrap/access.yaml', 'infra/runtime/package.json', 'infra/cloudformation/regional-capture.yaml', 'infra/scripts/deploy-regional-captures.sh',
  'infra/docker/browser-worker/Dockerfile', 'infra/docker/browser-worker/package.json',
  'scripts/aws-deploy-preflight.mjs', 'scripts/worker-image-source-hash.mjs', 'scripts/verify-worker-image-contract.mjs',
  'src/aws/runtime.mjs', 'src/aws/handler.mjs', 'src/aws/worker.mjs', 'src/aws/dispatcher.mjs',
  'src/aws/capture-handler.mjs', 'src/aws/inbound-email-handler.mjs', 'src/aws/twilio-webhooks.mjs', 'src/aws/cognito-directory.mjs',
  'src/aws/report-handler.mjs', 'src/aws/regional-capture-worker.mjs', 'src/aws/regional-capture-dispatcher.mjs', 'src/monitoring/regional-coordinator.mjs',
  'src/storage/dynamo-store.mjs', 'src/storage/s3-assets.mjs',
  'src/security/ssrf.mjs', 'src/security/egress-proxy.mjs',
  'config/staging-ip-allowlist.txt',
];
for (const file of requiredFiles) await fs.access(file);

const regionalTemplateFile = 'infra/cloudformation/regional-capture.yaml';
const regionalTemplate = await fs.readFile(regionalTemplateFile, 'utf8');
for (const token of ['CaptureBucket', 'CaptureQueue', 'CaptureDeadLetterQueue', 'RegionalCaptureFunction', 'RegionalCaptureEventSource', 'ReportBatchItemFailures', 'CentralResultQueueUrl', 'CentralResultQueueArn']) {
  if (!regionalTemplate.includes(token)) throw new Error(`Regional capture template missing: ${token}`);
}

const bootstrapTemplate = await fs.readFile('infra/bootstrap/access.yaml', 'utf8');
for (const action of ['route53:ChangeResourceRecordSets', 'route53:GetChange', 'route53:GetHostedZone', 'route53:ListResourceRecordSets']) {
  if (!bootstrapTemplate.includes(`- ${action}`)) throw new Error(`Bootstrap CloudFormation execution role is missing ${action}.`);
}
for (const action of ['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms', 'cloudwatch:ListTagsForResource', 'cloudwatch:TagResource', 'cloudwatch:UntagResource']) {
  if (!bootstrapTemplate.includes(`- ${action}`)) throw new Error(`Bootstrap CloudFormation execution role is missing ${action}.`);
}
for (const action of ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListAttachedRolePolicies', 'iam:ListRolePolicies']) {
  if (!bootstrapTemplate.includes(`- ${action}`)) throw new Error(`Bootstrap CloudFormation execution role is missing ${action} for IAM role drift inspection.`);
}
const deploymentRoleTemplate = bootstrapTemplate.split('  DeploymentRole:', 2)[1] ?? '';
for (const action of ['cloudfront:ListFunctions', 'cloudfront:ListCachePolicies', 'cloudfront:ListOriginRequestPolicies', 'cloudfront:ListResponseHeadersPolicies', 'cloudfront:ListOriginAccessControls', 'servicequotas:ListServiceQuotas', 'route53:GetHostedZone', 'route53:ListResourceRecordSets', 'cognito-idp:DescribeUserPoolDomain', 'cloudformation:ListStackResources']) {
  if (!deploymentRoleTemplate.includes(action)) throw new Error(`Bootstrap deployment role is missing ${action} for deployment preflight.`);
}
for (const action of ['ecr:CreateRepository', 'ecr:DescribeRepositories', 'ecr:PutLifecyclePolicy']) {
  if (!deploymentRoleTemplate.includes(`- ${action}`)) throw new Error(`Bootstrap deployment role is missing ${action} for regional image deployment.`);
}
if (!/Sid:\s*InspectDeploymentCertificate[\s\S]*?Action:\s*acm:DescribeCertificate[\s\S]*?Resource:\s*!Sub\s+'arn:\$\{AWS::Partition\}:acm:us-east-1:\$\{AWS::AccountId\}:certificate\/\*'/.test(deploymentRoleTemplate)) {
  throw new Error('Bootstrap deployment role is missing certificate-scoped acm:DescribeCertificate for CloudFront preflight.');
}
if (!/(?:Action:\s*cloudfront:ListDistributions|\-\s+cloudfront:ListDistributions\b)/.test(deploymentRoleTemplate)) {
  throw new Error('Bootstrap deployment role is missing cloudfront:ListDistributions for CloudFront preflight.');
}
if (!/Action:\s*dynamodb:DescribeTable/.test(deploymentRoleTemplate)) {
  throw new Error('Bootstrap deployment role is missing dynamodb:DescribeTable for staged GSI deployment.');
}
if (!bootstrapTemplate.includes('AWS::SES::ReceiptRuleSet') || !bootstrapTemplate.includes('SharedSesReceiptRuleSet')) throw new Error('Bootstrap stack must own the shared regional SES receipt-rule set.');

const parser = String.raw`
import sys, yaml, math
import xml.etree.ElementTree as ET
from yaml.constructor import ConstructorError
class CfnLoader(yaml.SafeLoader): pass

def construct_intrinsic(loader, tag_suffix, node):
    if isinstance(node, yaml.ScalarNode): return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode): return loader.construct_sequence(node)
    return loader.construct_mapping(node)

def construct_mapping_without_duplicates(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ConstructorError('while constructing a mapping', node.start_mark, f'duplicate key: {key}', key_node.start_mark)
        result[key] = loader.construct_object(value_node, deep=deep)
    return result

CfnLoader.add_multi_constructor('!', construct_intrinsic)
CfnLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping_without_duplicates)
with open(sys.argv[1], 'r', encoding='utf-8') as stream:
    value = yaml.load(stream, Loader=CfnLoader)
assert isinstance(value, dict)
resources = value.get('Resources', {})
assert isinstance(resources, dict) and len(resources) >= 80
edge_functions = ('PublicUrlRewriteFunction', 'CustomerSpaRewriteFunction', 'CustomerLegacyRedirectFunction', 'StewardSpaRewriteFunction')
for index, name in enumerate(edge_functions):
    function = resources.get(name, {})
    assert function.get('Type') == 'AWS::CloudFront::Function', f'{name} must remain a CloudFront function.'
    if index:
        dependencies = function.get('DependsOn', [])
        if isinstance(dependencies, str): dependencies = [dependencies]
        assert edge_functions[index - 1] in dependencies, f'{name} must serialize CloudFront function provisioning.'
    code = function.get('Properties', {}).get('FunctionCode', '')
    # Reserve enough space for the longest legal hostname in the one substituted function.
    code = code.replace('$' + '{PublicDomainName}', 'a' * 253)
    assert len(code.encode('utf-8')) <= 10240, f'{name} exceeds the CloudFront function size limit.'
# Cognito accepts a narrower SVG vocabulary than a browser. Keep our embedded
# outlined logos within this deliberately small supported subset; the web SVGs
# may retain their accessibility attributes. See docs/branding.md.
branding_names = ('CustomerManagedLoginBranding', 'CustomerCustomManagedLoginBranding', 'StewardManagedLoginBranding')
svg_namespace = '{http://www.w3.org/2000/svg}'
svg_attributes = {
    'svg': {'width', 'height', 'viewBox'},
    'path': {'d', 'fill', 'fill-rule'},
    'title': set(),
    'desc': set(),
}
for resource_name in branding_names:
    branding = resources.get(resource_name, {})
    assert branding.get('Type') == 'AWS::Cognito::ManagedLoginBranding', f'{resource_name} must retain managed login branding.'
    assets = branding.get('Properties', {}).get('Assets', [])
    expected_assets = {(category, mode) for category in ('FORM_LOGO', 'FAVICON_SVG') for mode in ('LIGHT', 'DARK')}
    assert len(assets) == 4 and {(asset.get('Category'), asset.get('ColorMode')) for asset in assets} == expected_assets, f'{resource_name} must provide light/dark logos and favicons.'
    for asset in assets:
        label = f"{resource_name}/{asset['Category']}/{asset['ColorMode']}"
        assert asset.get('Extension') == 'SVG', f'{label} must use SVG outlines.'
        source = asset.get('Bytes')
        assert isinstance(source, str) and '<!DOCTYPE' not in source.upper() and '<!ENTITY' not in source.upper(), f'{label} must contain an inline SVG without entities.'
        root = ET.fromstring(source)
        assert root.tag == svg_namespace + 'svg', f'{label} has an invalid SVG root.'
        try:
            width, height = (float(root.attrib[key]) for key in ('width', 'height'))
            viewbox = [float(part) for part in root.attrib['viewBox'].replace(',', ' ').split()]
        except (KeyError, ValueError) as error:
            raise AssertionError(f'{label} has missing or invalid SVG dimensions.') from error
        assert all(math.isfinite(number) and number > 0 for number in (width, height)), f'{label} requires finite positive SVG dimensions.'
        assert len(viewbox) == 4 and all(math.isfinite(number) for number in viewbox) and viewbox[2] > 0 and viewbox[3] > 0, f'{label} has invalid viewBox dimensions.'
        assert math.isclose(width / height, viewbox[2] / viewbox[3], rel_tol=1e-9), f'{label} viewport and viewBox aspect ratios must match.'
        if asset['Category'] == 'FORM_LOGO':
            # Enforced by Cognito asset validation (observed 2026-11-17).
            assert 1 <= width / height <= 4, f'{label} logo width:height ratio must be between 1:1 and 4:1.'
        else:
            assert width == height, f'{label} must remain a square favicon.'
        for element in root.iter():
            tag = element.tag.removeprefix(svg_namespace)
            assert element.tag.startswith(svg_namespace) and tag in svg_attributes, f'{label} uses an unsupported SVG element: {element.tag}'
            unsupported = set(element.attrib) - svg_attributes[tag]
            assert not unsupported, f'{label} uses unsupported SVG attribute(s): {sorted(unsupported)}'
for resource_name in ('CustomerUserPool', 'StewardUserPool'):
    assert resources.get(resource_name, {}).get('Properties', {}).get('DeletionProtection') == ['IsProd', 'ACTIVE', 'INACTIVE'], f'{resource_name} must keep deletion protection active in production.'
# WEBWATCH_LAMBDA_RESERVED_ENV_GUARD
reserved_lambda_env_keys = {
    '_HANDLER', '_X_AMZN_TRACE_ID',
    'AWS_DEFAULT_REGION', 'AWS_REGION', 'AWS_EXECUTION_ENV',
    'AWS_LAMBDA_FUNCTION_NAME', 'AWS_LAMBDA_FUNCTION_MEMORY_SIZE', 'AWS_LAMBDA_FUNCTION_VERSION',
    'AWS_LAMBDA_INITIALIZATION_TYPE', 'AWS_LAMBDA_LOG_GROUP_NAME', 'AWS_LAMBDA_LOG_STREAM_NAME',
    'AWS_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_LAMBDA_RUNTIME_API', 'LAMBDA_TASK_ROOT', 'LAMBDA_RUNTIME_DIR',
    'AWS_LAMBDA_MAX_CONCURRENCY', 'AWS_LAMBDA_METADATA_API', 'AWS_LAMBDA_METADATA_TOKEN',
}
for resource_name, resource in resources.items():
    if not isinstance(resource, dict) or resource.get('Type') != 'AWS::Lambda::Function':
        continue
    properties = resource.get('Properties') or {}
    environment = properties.get('Environment') or {}
    variables = environment.get('Variables') or {}
    if isinstance(variables, dict):
        conflicts = sorted(reserved_lambda_env_keys.intersection(variables.keys()))
        assert not conflicts, f"{resource_name} configures Lambda-reserved environment variable(s): {', '.join(conflicts)}"
parameters = value.get('Parameters', {})
assert parameters.get('Stage', {}).get('AllowedValues') == ['staging', 'beta', 'prod'], 'Stage must keep staging, beta, and prod as first-class values.'
for parameter_name in ('CustomerMfa', 'StewardMfa'):
    parameter = parameters.get(parameter_name, {})
    assert parameter.get('AllowedValues') == ['OFF', 'OPTIONAL', 'ON'], f'{parameter_name} AllowedValues must remain literal strings OFF/OPTIONAL/ON; quote YAML ON/OFF values.'
    assert parameter.get('Default') == 'OFF', f'{parameter_name} default must remain the literal string OFF.'
assert parameters.get('ReservedCheckConcurrency', {}).get('MinValue') == 2, 'SQS MaximumConcurrency cannot be configured below 2.'
assert parameters.get('WorkerReservedConcurrency', {}).get('Default') == 4 and parameters.get('WorkerReservedConcurrency', {}).get('MinValue') == 4, 'The shared worker must reserve two result-aggregation slots beyond the default two check slots.'
for parameter_name in ('EnableLookupIndex', 'EnableIdentityIndex'):
    parameter = parameters.get(parameter_name, {})
    assert parameter.get('AllowedValues') == ['true', 'false'] and parameter.get('Default') == 'true', f'{parameter_name} must default on and remain available for one-GSI-at-a-time upgrades.'
assert parameters.get('TwilioEnabled', {}).get('AllowedValues') == ['true', 'false'] and parameters.get('TwilioEnabled', {}).get('Default') == 'false', 'Twilio must be an explicit opt-in deployment capability.'
assert 'OriginVerifyRevision' in parameters, 'OriginVerifyRevision must remain available to force dynamic secret re-resolution.'
assert parameters.get('StagingIpv6Addresses', {}).get('Default') == '2001:0db8:0000:0000:0000:0000:0000:0001/128', 'The disabled IPv6 placeholder must match AWS WAF canonical expansion to avoid false drift.'
check_status_route = resources.get('CheckStatusRoute', {}).get('Properties', {})
assert check_status_route.get('RouteKey') == 'GET /api/checks/{jobId}' and check_status_route.get('AuthorizationType') == 'JWT' and check_status_route.get('AuthorizerId') == 'CustomerAuthorizer', 'Persisted Check Now polling requires its authenticated API Gateway route.'
for route_name in ('TwilioInboundRoute', 'TwilioStatusRoute'):
    assert resources.get(route_name, {}).get('Condition') == 'EnableTwilio', f'{route_name} must not exist while Twilio is disabled.'
for function_name in ('ApiFunction', 'WorkerFunction', 'BillingFunction'):
    variables = resources.get(function_name, {}).get('Properties', {}).get('Environment', {}).get('Variables', {})
    assert variables.get('SMS_PROVIDER') == ['EnableTwilio', 'twilio', 'disabled'], f'{function_name} must derive SMS_PROVIDER from EnableTwilio.'
    assert variables.get('TWILIO_SECRET_ARN') == ['EnableTwilio', 'TwilioSecret', 'AWS::NoValue'], f'{function_name} must omit the Twilio secret binding when disabled.'
api_log_destination = resources.get('ApiStage', {}).get('Properties', {}).get('AccessLogSettings', {}).get('DestinationArn')
assert api_log_destination == {'Fn::Select': [0, {'Fn::Split': [':*', 'ApiAccessLog.Arn']}]}, 'API access-log destination must remove the LogGroup Arn wildcard suffix that API Gateway does not persist.'
assert resources.get('ApiStage', {}).get('DependsOn') == 'TeamProxyRoute', 'The stage must wait for the team route before applying route-specific throttling.'
stateful_resources = ('DataKey', 'CoreTable', 'IdempotencyTable', 'ClosedAccountsTable', 'SnapshotBucket', 'InboundMailBucket', 'PublicWebBucket', 'CustomerWebBucket', 'StewardWebBucket', 'StripeSecret', 'TwilioSecret', 'ResponseSecret', 'OriginVerifySecret', 'CustomerUserPool', 'StewardUserPool')
for resource_name in stateful_resources:
    resource = resources.get(resource_name, {})
    assert resource.get('DeletionPolicy') == 'RetainExceptOnCreate', f'{resource_name} must use RetainExceptOnCreate so failed initial creates do not orphan stateful resources.'
static_cache = resources.get('StaticCachePolicy', {}).get('Properties', {}).get('CachePolicyConfig', {})
api_cache = resources.get('ApiNoCachePolicy', {}).get('Properties', {}).get('CachePolicyConfig', {})
api_origin = resources.get('ApiOriginRequestPolicy', {}).get('Properties', {}).get('OriginRequestPolicyConfig', {})
assert static_cache.get('DefaultTTL') == 86400 and static_cache.get('MaxTTL') == 31536000, 'StaticCachePolicy TTLs changed unexpectedly.'
assert api_cache.get('DefaultTTL') == 0 and api_cache.get('MinTTL') == 0 and api_cache.get('MaxTTL') == 1, 'ApiNoCachePolicy must retain its Authorization-forwarding TTL configuration.'
api_key = api_cache.get('ParametersInCacheKeyAndForwardedToOrigin', {})
assert api_key.get('EnableAcceptEncodingGzip') is False and api_key.get('EnableAcceptEncodingBrotli') is False, 'ApiNoCachePolicy must disable Accept-Encoding normalization for API responses.'
assert api_origin.get('CookiesConfig', {}).get('CookieBehavior') == 'all', 'API origin policy must forward cookies.'
assert api_origin.get('QueryStringsConfig', {}).get('QueryStringBehavior') == 'all', 'API origin policy must forward query strings.'
headers = api_origin.get('HeadersConfig', {})
assert headers.get('HeaderBehavior') == 'whitelist', 'API origin policy must forward only declared browser headers; Authorization is forwarded by the cache policy.'
queue_timeouts = {'CheckQueue': 3600, 'BillingQueue': 1800, 'CaptureQueue': 1200, 'CaptureResultQueue': 3660, 'ReportQueue': 1800}
for queue_name, expected_visibility in queue_timeouts.items():
    queue = resources.get(queue_name, {}).get('Properties', {})
    assert queue.get('VisibilityTimeout') == expected_visibility, f'{queue_name} visibility must remain six times its consumer Lambda timeout.'
    assert queue.get('RedrivePolicy', {}).get('maxReceiveCount') == 5, f'{queue_name} maxReceiveCount must remain at least 5.'
assert resources.get('WorkerFunction', {}).get('Properties', {}).get('Timeout') == 600, 'WorkerFunction requires ten minutes for capture evaluation and notification persistence.'
assert resources.get('BillingFunction', {}).get('Properties', {}).get('Timeout') == 300, 'BillingFunction timeout changed unexpectedly.'
capture_function = resources.get('CaptureFunction', {}).get('Properties', {})
assert capture_function.get('Timeout') == 180, 'CaptureFunction timeout changed unexpectedly.'
assert capture_function.get('ImageConfig', {}).get('Command') == ['src/aws/regional-capture-worker.handler'], 'Primary capture must use the durable regional queue worker.'
primary_capture_statements = resources.get('CaptureRole', {}).get('Properties', {}).get('Policies', [{}])[0].get('PolicyDocument', {}).get('Statement', [])
assert any(statement.get('Action') == 's3:GetObject' and '/baselines/*' in str(statement.get('Resource')) for statement in primary_capture_statements), 'Primary capture workers must read the durable hot-baseline prefix.'
for mapping_name in ('CaptureEventSource', 'CaptureResultEventSource'):
    mapping = resources.get(mapping_name, {}).get('Properties', {})
    assert mapping.get('FunctionResponseTypes') == ['ReportBatchItemFailures'], f'{mapping_name} must report partial SQS batch failures.'
assert resources.get('CaptureResultEventSource', {}).get('Properties', {}).get('MaximumBatchingWindowInSeconds') == 2, 'Capture result batching window changed unexpectedly.'
assert resources.get('CaptureResultEventSource', {}).get('Properties', {}).get('ScalingConfig', {}).get('MaximumConcurrency') == 2, 'Capture result aggregation must retain two bounded concurrency slots on the shared worker.'
core_indexes = resources.get('CoreTable', {}).get('Properties', {}).get('GlobalSecondaryIndexes', [])
conditional_indexes = [index[1] if isinstance(index, list) and len(index) > 1 and isinstance(index[1], dict) else index for index in core_indexes]
assert any(index.get('IndexName') == 'LookupIndex' for index in conditional_indexes if isinstance(index, dict)), 'CoreTable must expose the conditionally staged LookupIndex.'
assert any(index.get('IndexName') == 'IdentityIndex' for index in conditional_indexes if isinstance(index, dict)), 'CoreTable must expose the conditionally staged IdentityIndex.'
snapshot_lifecycle = resources.get('SnapshotBucket', {}).get('Properties', {}).get('LifecycleConfiguration', {})
assert snapshot_lifecycle.get('TransitionDefaultMinimumObjectSize') == 'all_storage_classes_128K', 'SnapshotBucket must explicitly keep sub-128 KB objects out of lifecycle transitions.'
assert resources.get('ReportQueue', {}).get('Properties', {}).get('VisibilityTimeout') == 1800, 'ReportQueue visibility must remain six times its report Lambda runtime.'
assert resources.get('ReportQueue', {}).get('Properties', {}).get('RedrivePolicy', {}).get('maxReceiveCount') == 5, 'ReportQueue must allow at least five receives before dead-lettering.'
report_function = resources.get('ReportFunction', {}).get('Properties', {})
assert report_function.get('Timeout') == 300, 'ReportFunction timeout changed unexpectedly.'
assert report_function.get('Handler') == 'src/aws/report-handler.handler', 'ReportFunction must use the report-only queue handler.'
assert report_function.get('Role') == 'ReportRole.Arn', 'ReportFunction must use its dedicated least-privilege role.'
report_variables = report_function.get('Environment', {}).get('Variables', {})
for forbidden in ('STRIPE_SECRET_ARN', 'TWILIO_SECRET_ARN', 'RESPONSE_SECRET_ARN', 'EMAIL_PROVIDER', 'SMS_PROVIDER', 'CAPTURE_FUNCTION_NAME'):
    assert forbidden not in report_variables, f'ReportFunction must not receive {forbidden}.'
for pool_name in ('CustomerUserPool', 'StewardUserPool'):
    enabled = resources.get(pool_name, {}).get('Properties', {}).get('EnabledMfas')
    assert isinstance(enabled, list) and 'AWS::NoValue' in enabled, f'{pool_name} must omit EnabledMfas when MFA is OFF.'
assert resources.get('BillingFunction', {}).get('Properties', {}).get('ReservedConcurrentExecutions') == 1, 'BillingFunction must serialize billing work with reserved concurrency 1.'
billing_mapping = resources.get('BillingEventSource', {}).get('Properties', {})
assert billing_mapping.get('FunctionName') == 'BillingFunction' and 'ScalingConfig' not in billing_mapping, 'BillingEventSource must target the dedicated serialized billing Lambda without invalid MaximumConcurrency=1.'
assert not any(name.startswith('OpenAi') for name in resources), 'Obsolete browser range-sync resources must not be restored.'
browser_parameter = parameters.get('EnableStagingChatGptBrowser', {})
assert browser_parameter.get('AllowedValues') == ['true', 'false'] and browser_parameter.get('Default') == 'true', 'The requested ChatGPT staging exception must default on and remain switchable.'
assert value.get('Conditions', {}).get('EnableStagingChatGptAccess') == ['IsStaging', ['EnableStagingChatGptBrowser', 'true']], 'Browser exceptions must require both staging and the enabled parameter.'
browser_rule_sets = []
for acl_name in ('EdgeWebAcl', 'RegionalWebAcl'):
    acl = resources.get(acl_name, {})
    properties = acl.get('Properties', {})
    assert acl.get('Condition') == 'IsStaging' and properties.get('DefaultAction') == {'Block': {}}, f'{acl_name} must remain staging-only and default-deny.'
    rules = properties.get('Rules', [])
    declared_rule = next((item for item in rules if isinstance(item, dict) and item.get('Name') == 'AllowDeclaredAddresses'), {})
    assert declared_rule.get('Priority') == 0 and declared_rule.get('Action') == {'Allow': {}}, f'{acl_name} must retain its declared-IP allow rule.'
    assert len(rules) == 3, f'{acl_name} must contain only the IP rule and two switchable ChatGPT exceptions.'
    browser_rules = []
    for branch, name, priority in zip(rules[1:], ('AllowChatGptUserAgent', 'AllowChatGptBrowserHeaders'), (1, 2)):
        assert isinstance(branch, list) and len(branch) == 3 and branch[0] == 'EnableStagingChatGptAccess' and branch[2] == 'AWS::NoValue', f'{acl_name} browser rules must disappear when disabled.'
        rule = branch[1]
        assert rule.get('Name') == name and rule.get('Priority') == priority and rule.get('Action') == {'Allow': {}}, f'{acl_name} has an unexpected browser exception.'
        browser_rules.append(rule)
    user_agent = browser_rules[0]['Statement']['RegexMatchStatement']
    assert user_agent['FieldToMatch'] == {'SingleHeader': {'Name': 'user-agent'}} and user_agent['RegexString'] == '(^|[ (;])chatgpt(-user|-agent)?/[0-9]', f'{acl_name} must match bounded ChatGPT product tokens without pinning browser or product versions.'
    signed_headers = browser_rules[1]['Statement']['AndStatement']['Statements']
    assert [item['RegexMatchStatement']['FieldToMatch']['SingleHeader']['Name'] for item in signed_headers] == ['signature-agent', 'signature-input', 'signature'], f'{acl_name} must require all three browser signature headers.'
    browser_rule_sets.append(browser_rules)
assert browser_rule_sets[0] == browser_rule_sets[1], 'Edge and Cognito browser exceptions must stay identical.'
assert 'SesReceiptRuleSet' not in resources, 'Environment stacks must not own competing SES receipt-rule sets.'
ses_identity = resources.get('SesDomainIdentity', {}).get('Properties', {})
assert ses_identity.get('DkimSigningAttributes', {}).get('NextSigningKeyLength') == 'RSA_2048_BIT', 'SES Easy DKIM must explicitly use RSA 2048.'
for distribution_name in ('PublicDistribution', 'CustomerDistribution', 'StewardDistribution'):
    config = resources.get(distribution_name, {}).get('Properties', {}).get('DistributionConfig', {})
    assert config.get('IPV6Enabled') == ['EnableViewerIpv6', True, False], f'{distribution_name} IPv6 must follow the shared viewer IPv6 condition.'
    default_behavior = config.get('DefaultCacheBehavior', {})
    assert default_behavior.get('CachePolicyId') == 'StaticCachePolicy', f'{distribution_name} must reference the stack-owned StaticCachePolicy.'
    for behavior in config.get('CacheBehaviors', []):
        if behavior.get('TargetOriginId') == 'ApiOrigin':
            assert behavior.get('CachePolicyId') == 'ApiNoCachePolicy', f'{distribution_name} API behavior must reference ApiNoCachePolicy.'
            assert behavior.get('OriginRequestPolicyId') == 'ApiOriginRequestPolicy', f'{distribution_name} API behavior must reference ApiOriginRequestPolicy.'
customer_default = resources.get('CustomerDistribution', {}).get('Properties', {}).get('DistributionConfig', {}).get('DefaultCacheBehavior', {})
customer_functions = customer_default.get('FunctionAssociations', []) or []
assert any(item.get('EventType') == 'viewer-request' and item.get('FunctionARN') == 'CustomerLegacyRedirectFunction.FunctionARN' for item in customer_functions), 'CustomerDistribution must permanently redirect the legacy login hostname.'
public_behaviors = resources.get('PublicDistribution', {}).get('Properties', {}).get('DistributionConfig', {}).get('CacheBehaviors', [])
customer_app = next((item for item in public_behaviors if item.get('PathPattern') == '/app*'), {})
assert customer_app.get('TargetOriginId') == 'CustomerS3', 'The canonical /app path must use the customer application bucket.'
assert any(item.get('EventType') == 'viewer-request' and item.get('FunctionARN') == 'CustomerSpaRewriteFunction.FunctionARN' for item in customer_app.get('FunctionAssociations', [])), 'The canonical /app path must rewrite SPA deep links.'
unsubscribe_behavior = next((item for item in public_behaviors if item.get('PathPattern') == '/unsubscribe/*'), {})
assert unsubscribe_behavior.get('TargetOriginId') == 'ApiOrigin', 'Public unsubscribe links must route to the API origin.'
assert unsubscribe_behavior.get('CachePolicyId') == 'ApiNoCachePolicy', 'Public unsubscribe responses must use the no-cache API policy.'
assert resources.get('UnsubscribePageRoute', {}).get('Properties', {}).get('AuthorizationType') == 'NONE', 'Signed unsubscribe links must be available without Cognito authentication.'
assert resources.get('CustomerUserPoolDomain', {}).get('Condition') == 'UseCustomerPrefixDomain', 'The legacy Cognito prefix domain must be selectable for safe migration.'
assert resources.get('CustomerUserPoolCustomDomain', {}).get('Condition') == 'UseCustomerCustomDomain', 'The Cognito custom domain must be selectable for new and existing customer pools.'
assert resources['CustomerManagedLoginBranding']['Condition'] == 'UseCustomerPrefixDomain'
assert resources['CustomerCustomManagedLoginBranding']['Condition'] == 'UseCustomOnlyBranding'
for pool in ('CustomerUserPool', 'StewardUserPool'):
    mode, sender, fallback = resources[pool]['Properties']['EmailConfiguration']
    assert mode == 'UseCognitoSes' and fallback == 'AWS::NoValue'
    assert sender['EmailSendingAccount'] == 'DEVELOPER' and sender['SourceArn'].endswith(':identity/$' + '{SesDomainIdentity}')
    assert sender['From'] == 'Cloversight <no-reply@$' + '{StageBaseDomain}>'
ops_policy = resources.get('OpsTopicPolicy', {}).get('Properties', {}).get('PolicyDocument', {}).get('Statement', [])
admin = next((item for item in ops_policy if item.get('Sid') == 'AccountAdministration'), {})
actions = admin.get('Action', [])
assert isinstance(actions, list) and 'sns:*' not in actions, 'SNS topic policies must use explicit topic-policy actions; sns:* is rejected by SNS.'
required_sns_actions = {'sns:GetTopicAttributes','sns:SetTopicAttributes','sns:AddPermission','sns:RemovePermission','sns:DeleteTopic','sns:Subscribe','sns:ListSubscriptionsByTopic','sns:Publish'}
assert required_sns_actions.issubset(set(actions)), 'OpsTopicPolicy AccountAdministration is missing required explicit SNS topic actions.'
cloudwatch_publish = next((item for item in ops_policy if item.get('Sid') == 'CloudWatchAlarmPublish'), {})
assert cloudwatch_publish.get('Condition', {}).get('ArnLike', {}).get('aws:SourceArn'), 'CloudWatch SNS publish permission must be constrained by aws:SourceArn.'
# CLOVERSIGHT 0.3.27 semantic CloudFront API authorization forwarding validation
api_cache_config = resources.get('ApiNoCachePolicy', {}).get('Properties', {}).get('CachePolicyConfig', {})
assert api_cache_config.get('DefaultTTL') == 0 and api_cache_config.get('MaxTTL') == 1 and api_cache_config.get('MinTTL') == 0, 'ApiNoCachePolicy must use MinTTL=0, DefaultTTL=0, MaxTTL=1 so Authorization can be carried while origin no-store prevents caching.'
api_cache_params = api_cache_config.get('ParametersInCacheKeyAndForwardedToOrigin', {})
api_cache_headers_config = api_cache_params.get('HeadersConfig', {})
api_cache_headers = api_cache_headers_config.get('Headers', [])
assert api_cache_headers_config.get('HeaderBehavior') == 'whitelist', 'ApiNoCachePolicy must whitelist cache-key headers.'
assert isinstance(api_cache_headers, list) and set(api_cache_headers) == {'Authorization'}, 'ApiNoCachePolicy must carry only Authorization as a cache-key header.'
assert api_cache_params.get('CookiesConfig', {}).get('CookieBehavior') == 'none', 'ApiNoCachePolicy must not vary the cache key by cookies.'
assert api_cache_params.get('QueryStringsConfig', {}).get('QueryStringBehavior') == 'none', 'ApiNoCachePolicy must not vary the cache key by query strings.'
assert len(str(api_cache_config.get('Comment', ''))) <= 128, 'ApiNoCachePolicy Comment must be <= 128 characters.'
api_origin_config = resources.get('ApiOriginRequestPolicy', {}).get('Properties', {}).get('OriginRequestPolicyConfig', {})
assert len(str(api_origin_config.get('Comment', ''))) <= 128, 'ApiOriginRequestPolicy Comment must be <= 128 characters.'
api_headers_config = api_origin_config.get('HeadersConfig', {})
api_headers = api_headers_config.get('Headers', [])
assert api_headers_config.get('HeaderBehavior') == 'whitelist', 'ApiOriginRequestPolicy must use whitelist header behavior.'
assert isinstance(api_headers, list), 'ApiOriginRequestPolicy whitelist headers must be a list.'
required_api_headers = {'Accept','Accept-Language','Content-Type','Origin','Access-Control-Request-Headers','Access-Control-Request-Method','If-Match','If-None-Match'}
assert required_api_headers.issubset(set(api_headers)), 'ApiOriginRequestPolicy is missing required browser/CORS headers.'
assert not {'Authorization','Host','X-WebWatch-Origin'}.intersection(api_headers), 'Authorization, Host, and X-WebWatch-Origin must not be in ApiOriginRequestPolicy.'
assert api_origin_config.get('CookiesConfig', {}).get('CookieBehavior') == 'all', 'ApiOriginRequestPolicy must forward cookies.'
assert api_origin_config.get('QueryStringsConfig', {}).get('QueryStringBehavior') == 'all', 'ApiOriginRequestPolicy must forward query strings.'
api_behavior_count = 0
for distribution_name in ('PublicDistribution', 'StewardDistribution'):
    distribution = resources.get(distribution_name, {}).get('Properties', {}).get('DistributionConfig', {})
    for behavior in distribution.get('CacheBehaviors', []) or []:
        if behavior.get('TargetOriginId') != 'ApiOrigin':
            continue
        api_behavior_count += 1
        assert behavior.get('CachePolicyId') == 'ApiNoCachePolicy', f'{distribution_name} ApiOrigin behavior must use ApiNoCachePolicy.'
        assert behavior.get('OriginRequestPolicyId') == 'ApiOriginRequestPolicy', f'{distribution_name} ApiOrigin behavior must use ApiOriginRequestPolicy.'
assert api_behavior_count >= 3, 'Expected public customer-app and steward ApiOrigin cache behaviors.'
# Production-hardening invariants: fail CI if privilege/transport/capacity drifts.
assert capture_function.get('ReservedConcurrentExecutions') == 'ReservedCaptureConcurrency'
assert resources['CaptureEventSource']['Properties']['ScalingConfig']['MaximumConcurrency'] == 'ReservedCaptureConcurrency'
assert capture_function['Environment']['Variables']['CAPTURE_QUEUE_URL'] == 'CaptureQueue'
assert resources['DispatcherFunction']['Properties']['Environment']['Variables']['DISPATCH_BATCH_SIZE'] == 'DispatchBatchSize'
for bucket in ('SnapshotBucket', 'InboundMailBucket', 'PublicWebBucket', 'CustomerWebBucket', 'StewardWebBucket'):
    policy = resources[bucket + 'Policy']['Properties']['PolicyDocument']['Statement']
    assert any(row.get('Effect') == 'Deny' and row.get('Condition', {}).get('Bool', {}).get('aws:SecureTransport') == 'false' for row in policy), f'{bucket} needs an explicit transport denial.'
assert len(resources['QueueTransportPolicy']['Properties']['Queues']) == 10
transport = resources['QueueTransportPolicy']['Properties']
queue_names = {name for name, resource in resources.items() if resource.get('Type') == 'AWS::SQS::Queue'}
assert set(transport['Queues']) == queue_names and len(transport['Queues']) == len(queue_names), 'QueueTransportPolicy must cover every queue and DLQ exactly once.'
statements = transport['PolicyDocument']['Statement']
assert len(statements) == 1, 'QueueTransportPolicy must contain only the transport denial.'
denial = statements[0]
assert denial.get('Resource') == '*', 'A shared SQS transport denial must use a single Resource string, not a resource array.'
assert denial.get('Effect') == 'Deny' and denial.get('Principal') == '*' and denial.get('Action') == 'sqs:*', 'QueueTransportPolicy must deny insecure transport without granting access.'
assert denial.get('Condition') == {'Bool': {'aws:SecureTransport': 'false', 'aws:PrincipalIsAWSService': 'false'}}, 'QueueTransportPolicy must preserve its HTTPS requirement and AWS service exemption.'
assert any(row.get('Action') == ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'] and row.get('Condition', {}).get('StringEquals', {}).get('kms:ViaService') for row in primary_capture_statements), 'Browser KMS access must be bound to S3.'
assert 'CheckQueueAgeAlarm' in resources and 'CaptureResultQueueAgeAlarm' in resources
print(f'CloudFormation YAML parsed without duplicate keys: {len(resources)} resources.')
`;
const parsed = spawnSync(python, ['-c', parser, templateFile], { encoding: 'utf8' });
if (parsed.status === 0) process.stdout.write(parsed.stdout);
else {
  process.stderr.write(parsed.stderr ?? 'Python 3 and PyYAML are required to parse the CloudFormation template.\n');
  process.exit(parsed.status ?? 1);
}

const regionalParser = String.raw`
import sys, yaml
from yaml.constructor import ConstructorError
class CfnLoader(yaml.SafeLoader): pass
def intrinsic(loader, tag_suffix, node):
    if isinstance(node, yaml.ScalarNode): return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode): return loader.construct_sequence(node)
    return loader.construct_mapping(node)
def mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result: raise ConstructorError('while constructing a mapping', node.start_mark, f'duplicate key: {key}', key_node.start_mark)
        result[key] = loader.construct_object(value_node, deep=deep)
    return result
CfnLoader.add_multi_constructor('!', intrinsic)
CfnLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
with open(sys.argv[1], 'r', encoding='utf-8') as stream: value = yaml.load(stream, Loader=CfnLoader)
resources = value.get('Resources', {})
transport = resources['QueueTransportPolicy']['Properties']
queue_names = {name for name, resource in resources.items() if resource.get('Type') == 'AWS::SQS::Queue'}
assert set(transport['Queues']) == queue_names and len(transport['Queues']) == len(queue_names), 'QueueTransportPolicy must cover every queue and DLQ exactly once.'
statements = transport['PolicyDocument']['Statement']
assert len(statements) == 1, 'QueueTransportPolicy must contain only the transport denial.'
denial = statements[0]
assert denial.get('Resource') == '*', 'A shared SQS transport denial must use a single Resource string, not a resource array.'
assert denial.get('Effect') == 'Deny' and denial.get('Principal') == '*' and denial.get('Action') == 'sqs:*', 'QueueTransportPolicy must deny insecure transport without granting access.'
assert denial.get('Condition') == {'Bool': {'aws:SecureTransport': 'false', 'aws:PrincipalIsAWSService': 'false'}}, 'QueueTransportPolicy must preserve its HTTPS requirement and AWS service exemption.'
queue = resources.get('CaptureQueue', {}).get('Properties', {})
assert queue.get('VisibilityTimeout') == 1200 and queue.get('RedrivePolicy', {}).get('maxReceiveCount') == 5
function = resources.get('RegionalCaptureFunction', {}).get('Properties', {})
assert function.get('Timeout') == 180
assert function.get('ImageConfig', {}).get('Command') == ['src/aws/regional-capture-worker.handler']
capture_statements = resources.get('RegionalCaptureRole', {}).get('Properties', {}).get('Policies', [{}])[0].get('PolicyDocument', {}).get('Statement', [])
assert any(statement.get('Action') == 's3:GetObject' and any('/baselines/*' in str(resource) for resource in ([statement.get('Resource')] if not isinstance(statement.get('Resource'), list) else statement.get('Resource'))) for statement in capture_statements), 'Regional capture workers must read the durable hot-baseline prefix.'
mapping_value = resources.get('RegionalCaptureEventSource', {}).get('Properties', {})
assert mapping_value.get('BatchSize') == 1 and mapping_value.get('FunctionResponseTypes') == ['ReportBatchItemFailures']
bucket = resources.get('CaptureBucket', {}).get('Properties', {})
rules = bucket.get('LifecycleConfiguration', {}).get('Rules', [])
assert bucket.get('LifecycleConfiguration', {}).get('TransitionDefaultMinimumObjectSize') == 'all_storage_classes_128K'
assert any(rule.get('Prefix') == 'capture-history/7/' and rule.get('ExpirationInDays') == 9 for rule in rules)
assert any(rule.get('Prefix') == 'capture-history/indefinite/' and len(rule.get('Transitions', [])) == 2 for rule in rules)
print(f'Regional CloudFormation YAML parsed without duplicate keys: {len(resources)} resources.')
`;
const parsedRegional = spawnSync(python, ['-c', regionalParser, regionalTemplateFile], { encoding: 'utf8' });
if (parsedRegional.status === 0) process.stdout.write(parsedRegional.stdout);
else {
  process.stderr.write(parsedRegional.stderr ?? 'Python 3 and PyYAML are required to parse the regional CloudFormation template.\n');
  process.exit(parsedRegional.status ?? 1);
}

const shellFiles = [];
for (const shellDir of ['infra/scripts', 'infra/github', 'scripts']) {
  for (const name of (await fs.readdir(shellDir)).filter((name) => name.endsWith('.sh')).sort()) {
    const file = path.join(shellDir, name);
    shellFiles.push(file);
    const stat = await fs.stat(file);
    if ((stat.mode & 0o111) !== 0o111) throw new Error(`Shell script must be executable: ${file}`);
    const checked = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    if (checked.status !== 0) throw new Error(`Shell syntax failed for ${file}: ${checked.stderr}`);
  }
}
if (!shellFiles.length) throw new Error('No deployment/workflow scripts were found.');

const sourceRoots = ['src', 'infra', 'apps', 'extensions'];
const legacyLayerVariable = ['CHROMIUM', 'LAYER', 'ARN'].join('_');
for (const root of sourceRoots) {
  const stale = spawnSync('grep', ['-RIl', '--exclude-dir=dist', '--', legacyLayerVariable, root], { encoding: 'utf8' });
  if (stale.status === 0 && stale.stdout.trim()) throw new Error(`Legacy Chromium layer references remain:\n${stale.stdout}`);
}

const cloudFrontPolicyLiteral = /(?:CachePolicyId|OriginRequestPolicyId):\s*[0-9a-f]{8}-[0-9a-f-]{27,}/i;
const allowedManagedCloudFrontPolicyIds = new Set();
const unknownCloudFrontPolicyLiteral = [...template.matchAll(/(?:CachePolicyId|OriginRequestPolicyId):\s*['"]?([0-9a-fA-F-]{36})['"]?/g)].find(([, id]) => !allowedManagedCloudFrontPolicyIds.has(id.toLowerCase()));
if (unknownCloudFrontPolicyLiteral) throw new Error(`CloudFront distribution behaviors must reference stack-owned policy resources or approved AWS-managed policies, not hard-coded policy UUID ${unknownCloudFrontPolicyLiteral[1]}.`);

const dockerfile = await fs.readFile('infra/docker/browser-worker/Dockerfile', 'utf8');
workerBase(dockerfile);
for (const token of [ 'dnf install -y ca-certificates', 'WEBWATCH_SERVERLESS_CHROMIUM=1', 'WEBWATCH_CAPTURE_RELEASE', 'WEBWATCH_CAPTURE_SOURCE_SHA256', "import('playwright-core')", "import('@sparticuz/chromium')"]) {
  if (!dockerfile.includes(token)) throw new Error(`Browser worker Dockerfile is missing ${token}.`);
}
const workerPackage = JSON.parse(await fs.readFile('infra/docker/browser-worker/package.json', 'utf8'));
if (workerPackage.dependencies?.['playwright-core'] !== '1.63.0') throw new Error('Browser worker must pin Playwright Core 1.63.0 exactly.');
if (workerPackage.dependencies?.['@sparticuz/chromium'] !== '153.0.0') throw new Error('Browser worker must pin Lambda Chromium 153.0.0 exactly.');
const captureSource = await fs.readFile('src/monitoring/capture.mjs', 'utf8');
for (const token of ['launchPersistentContext', 'persistentContext: true', 'fs.mkdtemp(path.join(os.tmpdir(), `webwatch-pw-', 'browser profile cleanup', "id: 'desktop'", "id: 'tablet'", "id: 'mobile'", 'fullPage: true']) {
  if (!captureSource.includes(token)) throw new Error(`Lambda capture must use and clean the default persistent browser context; missing ${token}.`);
}
const workerBuildScript = await fs.readFile('infra/scripts/build-worker-image.sh', 'utf8');
for (const token of ['--platform linux/amd64', '--provenance=false', '--sbom=false', 'imageManifestMediaType', 'worker-image-source-hash.mjs', 'worker-image.contract.verified', 'WORKER_IMAGE_RELEASE_VERSION', 'WORKER_IMAGE_SOURCE_SHA256']) {
  if (!workerBuildScript.includes(token)) throw new Error(`Browser worker build script is missing ${token}.`);
}
const deployScript = await fs.readFile('infra/scripts/deploy.sh', 'utf8');
if (!deployScript.includes('verify-worker-image-contract.mjs')) throw new Error('AWS deployment must verify that the configured capture image was built from the current checkout.');
for (const token of ['EnableLookupIndex=${lookup_enabled}', 'EnableIdentityIndex=${identity_enabled}', 'dynamodb describe-table', 'add LookupIndex to the existing table']) {
  if (!deployScript.includes(token)) throw new Error(`AWS deployment is missing staged DynamoDB index handling: ${token}.`);
}
const s3Assets = await fs.readFile('src/storage/s3-assets.mjs', 'utf8');
for (const token of ['ListObjectVersionsCommand', 'DeleteMarkers', 'VersionId']) {
  if (!s3Assets.includes(token)) throw new Error(`Versioned S3 purge implementation is missing ${token}.`);
}
const runtimePackage = JSON.parse(await fs.readFile('infra/runtime/package.json', 'utf8'));
for (const [name, version] of Object.entries(runtimePackage.dependencies ?? {})) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Runtime dependency ${name} must use an exact version, received ${version}.`);
}
if (runtimePackage.dependencies?.pixelmatch !== '7.2.0' || runtimePackage.dependencies?.pngjs !== '7.0.0') {
  throw new Error('Lambda runtime must package the exact pure-JavaScript PNG comparison dependencies.');
}
const lambdaPackageScript = await fs.readFile('infra/scripts/package-lambdas.sh', 'utf8');
if (lambdaPackageScript.includes('openai-ip-range-sync-handler')) throw new Error('Lambda packaging must not retain the removed OpenAI IP range-sync handler.');
console.log(`IaC source validation passed (${shellFiles.length} shell scripts). AWS-side validation remains a Group B deployment prerequisite.`);
