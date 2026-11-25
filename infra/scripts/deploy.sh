#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=lib.sh
source "$ROOT/infra/scripts/lib.sh"
load_webwatch_env
WEBWATCH_ORIGINAL_ARGS=("$@")
for tool in aws node npm zip python3; do require_command "$tool"; done
assert_region
ensure_deployment_role
(cd "$ROOT" && node scripts/deployment-settings.mjs validate)
eval "$(cd "$ROOT" && node scripts/deployment-settings.mjs shell)"
invalidate_ci_release_baseline
(cd "$ROOT" && node scripts/validate-iac.mjs && node scripts/validate-cfn-schema.mjs)
stack_plan="$(node "$ROOT/scripts/deployment-control.mjs" plan "$WW_STACK_NAME" "$AWS_REGION")"
failure_mode="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).mode)' "$stack_plan")"
existing_core_table="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).coreTableId)' "$stack_plan")"
printf 'CloudFormation failure handling: %s (new installations are preserved; completed-stack updates roll back).\n' "$failure_mode"
if [[ ${CLOVERSIGHT_EXISTING_RELEASE:-0} == 1 && "$failure_mode" != rollback ]]; then
  echo 'CI releases require an existing stable primary stack.' >&2; exit 12
fi
node "$ROOT/scripts/verify-worker-image-contract.mjs"
node "$ROOT/scripts/aws-deploy-preflight.mjs"
node "$ROOT/scripts/check-lambda-capacity.mjs"

"$ROOT/infra/scripts/package-lambdas.sh"
ARTIFACT_PREFIX="webwatch/${WW_STAGE}/$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_KEY="${ARTIFACT_PREFIX}/runtime.zip"
aws_active s3 cp "$ROOT/dist/lambda/runtime.zip" "s3://${WW_ARTIFACT_BUCKET}/${ARTIFACT_KEY}" --sse AES256 --only-show-errors
TEMPLATE_KEY="${ARTIFACT_PREFIX}/cloudformation/webwatch.yaml"
TEMPLATE_URL="https://${WW_ARTIFACT_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${TEMPLATE_KEY}"
aws_active s3 cp "$ROOT/infra/cloudformation/webwatch.yaml" "s3://${WW_ARTIFACT_BUCKET}/${TEMPLATE_KEY}" --sse AES256 --only-show-errors
aws_active cloudformation validate-template --template-url "$TEMPLATE_URL" >/dev/null

parameters=(
  "Stage=${WW_STAGE}" "BaseDomain=${WW_BASE_DOMAIN}" "StageBaseDomain=${WW_STAGE_BASE_DOMAIN}"
  "PublicDomainName=${WW_PUBLIC_DOMAIN}" "CustomerDomainName=${WW_LEGACY_CUSTOMER_DOMAIN}" "StewardDomainName=${WW_STEWARD_DOMAIN}" "ReplyDomainName=${WW_REPLY_DOMAIN}"
  "HostedZoneId=${WW_HOSTED_ZONE_ID}" "CloudFrontCertificateArn=${WW_CERT_ARN}" "ArtifactBucketName=${WW_ARTIFACT_BUCKET}"
  "RuntimeArtifactKey=${ARTIFACT_KEY}" "WorkerImageUri=${WW_WORKER_IMAGE_URI}"
  "AvailableCheckRegions=${WW_CHECK_REGIONS}"
  "CustomerCognitoDomainPrefix=${WW_CUSTOMER_COGNITO_PREFIX}" "CustomerCognitoDomainMode=${WW_CUSTOMER_COGNITO_MODE}" "CustomerCognitoCustomDomain=${WW_CUSTOMER_COGNITO_DOMAIN}" "CustomerCognitoCertificateArn=${WW_CUSTOMER_COGNITO_CERT_ARN}" "StewardCognitoDomainPrefix=${WW_STEWARD_COGNITO_PREFIX}"
  "CustomerMfa=${WW_CUSTOMER_MFA}" "StewardMfa=${WW_STEWARD_MFA}"
  "EnableStagingIpv4=${WW_ENABLE_IPV4}" "EnableStagingIpv6=${WW_ENABLE_IPV6}"
  "EnableStagingChatGptBrowser=${WW_STAGING_CHATGPT_BROWSER_ENABLED}"
  "StagingIpv4Addresses=${WW_IPV4:-192.0.2.1/32}" "StagingIpv6Addresses=${WW_IPV6:-2001:0db8:0000:0000:0000:0000:0000:0001/128}"
  "SesFromAddress=${WW_SES_FROM}" "SesReceiptRuleSetName=${WW_SES_RULE_SET}"
  "OriginVerifyRevision=${WW_ORIGIN_VERIFY_REVISION}"
  "TechnicalAlertsEnabled=${WW_TECH_ALERTS}" "TechnicalAlertEmail=${WW_TECH_EMAIL}" "StaffActionEmail=${WW_STAFF_EMAIL}" "StewardOwnerSub=${WW_STEWARD_OWNER_SUB}"
  "OpsAlertEmail=${WW_OPS_EMAIL}" "BudgetAlertEmail=${WW_BUDGET_EMAIL}" "EnableScopedBudget=${WW_SCOPED_BUDGET_ENABLED}" "ScopedMonthlyBudgetUsd=${WW_SCOPED_BUDGET}" "ResourceOwner=${WW_RESOURCE_OWNER}"
  "SnapshotRetentionDays=${WW_RETENTION_DAYS}" "AccountClosureGraceDays=${WW_CLOSURE_DAYS}"
  "MonthlyBudgetUsd=${WW_BUDGET}" "ReservedCheckConcurrency=${WW_CHECK_CONCURRENCY}" "WorkerReservedConcurrency=${WW_WORKER_CONCURRENCY}"
  "ReservedCaptureConcurrency=${WW_CAPTURE_CONCURRENCY}" "DispatchBatchSize=${WW_DISPATCH_BATCH_SIZE}"
  "CaptureQueueMaxOutstanding=${WW_CAPTURE_QUEUE_MAX_OUTSTANDING}" "CaptureQueueHealthCacheSeconds=${WW_CAPTURE_QUEUE_HEALTH_CACHE_SECONDS}"
  "CaptureQueueDeferralSeconds=${WW_CAPTURE_QUEUE_DEFERRAL_SECONDS}" "CheckQueueMaxOutstanding=${WW_CHECK_QUEUE_MAX_OUTSTANDING}"
  "StripeRequestThreeDSecure=${WW_STRIPE_3DS}" "TwilioEnabled=${WW_TWILIO_ENABLED}"
  "StripePaymentOrigins=${WW_STRIPE_PAYMENT_ORIGINS}"
)

deploy_stack_phase() {
  local lookup_enabled="$1" identity_enabled="$2" label="$3"
  local email_delivery="${4:-$WW_COGNITO_EMAIL_DELIVERY}"
  local -a overrides=("${parameters[@]}" "CognitoEmailDelivery=${email_delivery}" "EnableLookupIndex=${lookup_enabled}" "EnableIdentityIndex=${identity_enabled}")
  if [[ ${CLOVERSIGHT_EXISTING_RELEASE:-0} == 1 ]]; then
    overrides=("RuntimeArtifactKey=${ARTIFACT_KEY}" "WorkerImageUri=${WW_WORKER_IMAGE_URI}")
  fi
  printf 'Deploying CloudFormation phase: %s\n' "$label"
  deploy_cloudformation_checked "$WW_STACK_NAME" "$AWS_REGION" "$failure_mode" \
    --template-file "$ROOT/infra/cloudformation/webwatch.yaml" \
    --s3-bucket "$WW_ARTIFACT_BUCKET" \
    --s3-prefix "${ARTIFACT_PREFIX}/cloudformation" \
    --role-arn "$WW_EXECUTION_ROLE_ARN" \
    --capabilities CAPABILITY_NAMED_IAM \
    --tags "Application=WebWatch" "Stage=${WW_STAGE}" "Owner=${WW_RESOURCE_OWNER}" \
    --no-fail-on-empty-changeset \
    --parameter-overrides "${overrides[@]}"
  failure_mode=rollback
}

require_cognito_ses_ready() {
  if ! aws_active ses wait identity-exists --identities "$WW_STAGE_BASE_DOMAIN"; then
    printf 'Wait for SES to verify %s in %s, then rerun aws:deploy.\n' "$WW_STAGE_BASE_DOMAIN" "$AWS_REGION" >&2
    return 12
  fi
  if [[ "$WW_STAGE" == prod ]]; then
    local allowed
    allowed="$(aws_active sesv2 get-account --query 'SendingEnabled && ProductionAccessEnabled' --output json)"
    [[ "$allowed" == true ]] || { echo 'Obtain SES production access and enable sending in the primary Region, then rerun aws:deploy.' >&2; return 12; }
  fi
}

# A new install publishes the domain identity and DKIM records before Cognito
# switches to SES. Subsequent CI releases preserve the installed mail mode.
initial_mail="$WW_COGNITO_EMAIL_DELIVERY"
if [[ "$initial_mail" == ses && ${CLOVERSIGHT_EXISTING_RELEASE:-0} != 1 ]]; then
  if [[ "$failure_mode" == preserve ]]; then
    identity_status="$(aws_active ses get-identity-verification-attributes --identities "$WW_STAGE_BASE_DOMAIN" --query 'VerificationAttributes.*.VerificationStatus | [0]' --output text)"
    [[ "$identity_status" == Success ]] || initial_mail=cognito
  fi
  if [[ "$initial_mail" == ses ]]; then require_cognito_ses_ready; fi
fi

# DynamoDB accepts only one new GSI per UpdateTable operation. A brand-new
# table may create both indexes at once, while an existing 0.4.x table needs a
# completed LookupIndex phase before the final IdentityIndex phase.
if [[ -n "$existing_core_table" && "$existing_core_table" != None ]]; then
  existing_indexes=" $(aws_active dynamodb describe-table --table-name "$existing_core_table" --query 'Table.GlobalSecondaryIndexes[].IndexName' --output text | tr '\t\r\n' '   ') "
  if [[ " $existing_indexes " != *" LookupIndex "* && " $existing_indexes " != *" IdentityIndex "* ]]; then
    [[ ${CLOVERSIGHT_EXISTING_RELEASE:-0} != 1 ]] || { echo 'Finish the index migration before automated releases.' >&2; exit 12; }
    deploy_stack_phase true false 'add LookupIndex to the existing table' "$initial_mail"
  fi
fi
if [[ "$initial_mail" != "$WW_COGNITO_EMAIL_DELIVERY" ]]; then
  deploy_stack_phase true true 'publish the SES identity and DNS records' "$initial_mail"
  require_cognito_ses_ready
fi
deploy_stack_phase true true 'deploy the complete 0.5.22 stack'

if [[ ${CLOVERSIGHT_EXISTING_RELEASE:-0} == 1 ]]; then
  readback() {
    aws_active cloudformation describe-stacks --stack-name "$WW_STACK_NAME" --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" --output text
  }
  [[ "$(readback RuntimeArtifactKey)" == "$ARTIFACT_KEY" && "$(readback WorkerImageUri)" == "$WW_WORKER_IMAGE_URI" ]] || {
    echo 'Production did not adopt this runtime ZIP and worker digest.' >&2; exit 12;
  }
  echo "Primary runtime artifact: s3://$WW_ARTIFACT_BUCKET/$ARTIFACT_KEY"
fi
aws_active cloudformation describe-stacks --stack-name "$WW_STACK_NAME" --query 'Stacks[0].Outputs' --output table
printf 'Infrastructure deployed. Continue docs/upgrade-0.5.20.md for regional stacks, secrets, web assets, SES and acceptance checks.\n'
