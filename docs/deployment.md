# Deployment reference

For an empty AWS account, follow [First AWS installation](aws-account-bootstrap.md). It covers account access, DNS, the first stage, Stripe and the steward owner in dependency order. For routine releases to an installed production stack, follow the [business-fork CI/CD walkthrough](github-production.md). For a failed stack, start with [upgrade and recovery](upgrade-0.5.20.md).

Use the sections below to change or diagnose one part of an installation. Preserve the private `.env`, immutable owner subject, worker build record and original bootstrap principal. Primary, regional and web deployments complete separately. Schedule a maintenance window for changes that need them to move together.

## Production identity and independent alert destinations

Production deployment settings require `COGNITO_STEWARD_MFA=ON`, `TECHNICAL_ALERTS_ENABLED=true`, and explicit nonempty `TECHNICAL_ALERT_EMAIL`, `OPS_ALERT_EMAIL` and `BUDGET_ALERT_EMAIL`. These can be the same managed operator mailbox, although a healthy alternate operator channel remains advisable. Edit these values in the production checkout’s private `.env`. Any stage that enables application technical alerts also needs an explicit `TECHNICAL_ALERT_EMAIL`. Staging and beta have separate MFA and technical-alert settings.

The steward client supports only local `COGNITO` identities, and the pool enables software-token MFA. Prepare administrator TOTP enrollment and recovery before a production update. If a future release introduces a federated IdP, enforce MFA at that IdP: Cognito's user-pool MFA does not challenge federated users. AWS/Identity Center/Stripe administrator MFA and fresh authorization for high-impact application actions are separate controls, not supplied by this pool setting. See [AWS Cognito MFA](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html).

`TECHNICAL_ALERT_EMAIL` is the application SES recipient. `OPS_ALERT_EMAIL` subscribes to the primary operational SNS topic and a new local topic in every secondary capture Region. `BUDGET_ALERT_EMAIL` receives direct AWS Budgets messages independently of SES and SNS. Non-production deployments preserve their historical technical-email fallback when technical alerts are enabled; explicitly setting `OPS_ALERT_EMAIL` or `BUDGET_ALERT_EMAIL` also installs the corresponding independent fallback when application technical alerts are disabled.

CloudFormation creates pending SNS email subscriptions. Confirm **each Region's email** and inspect its subscription ARN before admitting production customer work; `PendingConfirmation` is not a verified destination. Production preflight reports unconfirmed primary subscriptions but permits first-time creation and recipient replacement, so it cannot certify delivery. With a source administrator profile, these are read-only examples after deployment:

```bash
aws cloudformation describe-stacks --stack-name webwatch-staging --region us-east-1 --profile saas-admin --query 'Stacks[0].Outputs[?OutputKey==`OpsTopicArn`].OutputValue|[0]' --output text --no-cli-pager
aws cloudformation describe-stacks --stack-name webwatch-staging-regional-eu-west-1 --region eu-west-1 --profile saas-admin --query 'Stacks[0].Outputs[?OutputKey==`OpsTopicArn`].OutputValue|[0]' --output text --no-cli-pager
read -rp 'Regional operations topic ARN from the lookup above: ' OPS_TOPIC_ARN
aws sns list-subscriptions-by-topic --topic-arn "$OPS_TOPIC_ARN" --region eu-west-1 --profile saas-admin --query 'Subscriptions[].[Protocol,Endpoint,SubscriptionArn]' --output table --no-cli-pager
```

Verify delivery with a controlled operator-owned alarm exercise after confirming subscriptions and retain the observed message/action history. That exercise is not performed by this release. Regional SNS alarm encryption requires a local customer-managed KMS key with a CloudWatch service grant; `alias/aws/sns` cannot supply that grant. The four default secondary Regions therefore add four customer-managed keys, four SNS topics and sixteen CloudWatch alarms, plus primary health metrics/alarms. These have recurring AWS charges; use current regional KMS/CloudWatch/SNS pricing when setting budgets. See [AWS SNS encrypted service publishing](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html).

New primary alarms detect missing positive dispatcher/healthy-maintenance heartbeats, maintenance task failures, primary browser errors/throttles and capture queue age. Each regional stack detects browser invocation errors, throttles, queue age and a nonempty DLQ. Missing scheduled heartbeats are unhealthy even on quiet days. Queue-age alarms are a delay signal, not evidence that a monitored website is down. This is partial business-health coverage: billing reconciliation backlog, SES quota, financial collector/controller health and per-task stale-success alarms remain follow-up work.

## Account backstop and optional tagged cost budget

The existing `WebWatch-<stage>-monthly` name and logical resource IDs remain; its scope is the **whole AWS account**, regardless of its stage label. `MONTHLY_BUDGET_USD` controls that backstop. Its explicit cost basis preserves the historical defaults: unblended/non-amortized AWS charges including credits, refunds, discounts, tax, support, upfront/recurring and other subscriptions. This is an AWS-reported accrued-cost definition, not a gross resource meter or a finalized invoice. Independent budget mail can be added without switching the existing logical resource when technical alerts stay disabled. The historical pair of budget resource branches is retained for upgrades; changing `TECHNICAL_ALERTS_ENABLED` can switch their logical IDs, so review the generated change set for same-name budget replacement before executing it. Consolidating those branches safely on existing stacks needs an explicit migration.

Supported primary/regional resources now explicitly carry `Application`, `Stage`, `Component` and `Owner` tags, and both deployment scripts set stack tags. `RESOURCE_OWNER` defaults to `CLOVERSIGHT`. Bootstrap/shared ECR/artifact charges, unsupported tagging, historical untagged resources and account-wide charges are not automatically allocated to a stage. Do not add stage totals to the overlapping whole-account total or claim that tagging covers every AWS charge.

An optional second budget, `WebWatch-<stage>-tagged-monthly`, uses `FilterExpression` with **Application=WebWatch AND Stage=<stage>** and `Metrics: [UnblendedCost]`. It never replaces the account backstop. Before enabling it, activate both user-defined allocation tags in the billing account, wait until their status is active, and check that the expected tagged costs appear. A billing administrator can inspect/activate them with these one-line commands:

```bash
aws ce list-cost-allocation-tags --tag-keys Application Stage --status Active --type UserDefined --region us-east-1 --profile saas-admin --output json --no-cli-pager
aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=Application,Status=Active TagKey=Stage,Status=Active --region us-east-1 --profile saas-admin --no-cli-pager
```

Then set `SCOPED_BUDGET_ENABLED=true`, `COST_ALLOCATION_TAGS_ACTIVATED=true`, `SCOPED_MONTHLY_BUDGET_USD=<your-approved-limit>` and a valid `BUDGET_ALERT_EMAIL`, and deploy. The acknowledgment flag does not replace AWS verification: deployment preflight calls `ce:ListCostAllocationTags` and fails if either tag is inactive or billing access is denied. The bootstrap deployment role gets only that read permission, not allocation-tag activation authority. The check is skipped while the optional budget is disabled, preserving existing staging without new Cost Explorer access requirements. Billing-account/organization policy may still require owner configuration. Tag activation and billing feeds are delayed; inspect actual coverage before trusting the scoped amount. See [AWS budget filter/metric combinations](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_budgets_CreateBudget.html) and [tag backfill limits](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-allocation-backfill.html).

Direct budgets and these alarms do not cap the bill or implement a minute-scale dollar governor, independent cost outbox, price catalogue, cost reconciliation or rolling next-24-hour forecast. Cost Anomaly Detection and dedicated production-account allocation remain owner-approved follow-up work.

## Queue admission and reviewed Stripe custom domains

The deployment settings forward the following integer controls to the functions that use them: `CAPTURE_QUEUE_MAX_OUTSTANDING=256` (1–1000), `CAPTURE_QUEUE_HEALTH_CACHE_SECONDS=10` (0–60 seconds), `CAPTURE_QUEUE_DEFERRAL_SECONDS=60` (15–900 seconds), `CHECK_QUEUE_MAX_OUTSTANDING=500` (1–1000), and `DISPATCH_BATCH_SIZE=500` (1–1000). Browser reserved concurrency is separately controlled by `CAPTURE_RESERVED_CONCURRENCY=64` (2–500); blank `REGIONAL_CAPTURE_CONCURRENCY` inherits it. Existing private values override defaults and must be reviewed during upgrade. A read-only regional Lambda quota preflight runs before stack deployment. Tune limits against deployed capture slots and measured complete-processing tails; counts are approximate and these are soft admission controls. See [queue operations](operations.md#soft-queue-backpressure-and-infrastructure-deferral) and the [capacity calculator](cost-model.md).

`STRIPE_PAYMENT_ORIGINS` is optional and defaults to empty. The built-in `https://checkout.stripe.com` and `https://invoice.stripe.com` destinations remain allowed. If your Stripe account uses a custom payment domain, first verify its ownership and configuration in that account, then enter only its exact HTTPS origin in your protected deployment environment. Comma-separated additional origins are normalized, deduplicated and limited to 512 characters; credentials, paths, queries and fragments fail deployment-settings validation. No wildcard or inferred domain is added. Deploy the primary stack to forward the list to API, worker and billing runtimes, then verify actual Checkout/invoice navigation in Stripe test mode before enabling the corresponding production domain. Merely editing a local `.env` does not change an already deployed function.

## Workstation deployment commands

Run these from the operator checkout for the selected stage. The first-install guide shows which values to supply and when to run each command.

| Operation | Command and expected result |
| --- | --- |
| Inspect settings | `npm run deploy:settings` prints resolved hosts, stage, stack and staging allowlist. Run `npm run deploy:validate` after the bootstrap outputs and worker digest are available. |
| Bootstrap access | `npm run aws:bootstrap` creates or updates the shared roles, bucket, ECR repository and SES rule set, then merges five generated values into the private `.env`. Direct callers of `bootstrap-aws-access.sh` can run `bash infra/scripts/merge-generated-env.sh .local/bootstrap-outputs.env`. |
| Build the worker | `npm run aws:build-worker` builds a Linux amd64 image from the pinned Lambda Node 22 base and writes its immutable URI and source contract to `.local/worker-image.env`. Run `bash infra/scripts/merge-generated-env.sh .local/worker-image.env` after a direct build. |
| Deploy | `npm run deploy` runs preflight, builds a fresh worker, updates primary and regional stacks, uploads secrets, publishes the sites and activates SES. `-- --reuse-image` uses a validated image built from this release and checkout. `--skip-secrets` and `--skip-ses` are available for intentional maintenance. |
| Check the result | `npm run aws:audit -- --full` inspects the deployed resources. Check the public `/api/health` endpoint and exercise the customer and steward paths as well. |

The release uses queue protocol 1 and the `2026-09-capture-credits-usd-v1` catalog. Preserve existing Stripe Price IDs when upgrading within this catalog. For an older installation, also keep `WORKER_RESERVED_CONCURRENCY` at least two above `RESERVED_CHECK_CONCURRENCY` to leave space for result aggregation.

## Steward owner identity for this release

For a new pool, create the owner once in that stage’s steward pool, retrieve its immutable Cognito `sub`, put it in the private `STEWARD_OWNER_SUB` and redeploy the primary before staff sign-in. [First-owner commands](aws-account-bootstrap.md#5-connect-billing-and-create-the-first-steward)

For an existing installation, preserve the deployed subject. Look up the user before issuing another invitation. The initial steward password expires after one day. Other staff need an active invitation from the owner through Steward Manager. [Steward access and recovery](steward-security.md)

## Primary stack

```bash
npm run aws:deploy
```

The deploy script:

- Refuses root identity.
- Assumes the dedicated deployment role.
- Validates all required values and the allow-list.
- Verifies the ACM viewer certificate is in `us-east-1`, `ISSUED`, unexpired, and covers all three CloudFront aliases.
- Verifies the configured digest-pinned ECR worker still resolves to a Lambda-compatible single-image manifest.
- Fails early if one of those aliases is attached to another CloudFront distribution in the same AWS account.
- Packages exact runtime dependencies.
- Uploads the Lambda artifact to the private artifact bucket.
- Runs server-side CloudFormation validation.
- Deploys through the separate execution role.
- Configures staging edge and regional WAF ACLs for declared IP sets and the switchable ChatGPT header exception.
- Creates the primary capture queue/DLQ and compact-result queue/DLQ, attaches partial-batch mappings, and grants bounded cross-Region queue dispatch.
- Adds the DynamoDB identity index plus sharded watcher/capture-deadline index records on subsequent writes.
- Installs retention-class lifecycle rules and direct signed-read permissions for configured regional evidence buckets.

For a pre-0.5.0 `CoreTable`, the script inspects its current GSIs and deliberately performs two completed CloudFormation operations when both new indexes are absent: `LookupIndex` first, then the complete template with `IdentityIndex`. DynamoDB permits only one new GSI per `UpdateTable` operation. A new table creates both indexes in its initial `CreateTable` operation. Do not interrupt the script between these phases; if the second phase fails, correct the reported stack error and rerun the same command.

The staging WAF permits matching ChatGPT user-agent/browser-signature headers from any IP when `STAGING_CHATGPT_BROWSER_ENABLED=true` (default). This applies to both CloudFront and Cognito, and remains a spoofable header policy. Ensure ordinary workstation IPs are still in the private `.local/staging-ip-allowlist.txt`; beta and production do not attach these staging ACLs. The IP-set updater alone cannot install the new rules; deploy the primary stack. See [staging browser access](staging-browser-access.md) for the hotfix upgrade.

## Regional capture stacks

After the primary stack reaches `CREATE_COMPLETE` or `UPDATE_COMPLETE`, copy the immutable browser image into ECR in each configured secondary Region and deploy its queue, DLQ, private evidence bucket, and browser Lambda:

```bash
npm run aws:deploy-regional
```

The script skips `us-east-1`, creates an immutable ECR repository where needed, expires only untagged images after seven days and retains tagged deployment releases, pins the Lambda to the copied digest, and wires the regional worker to the primary result queue. Browser evidence remains in the regional bucket; only size-bounded compact metadata returns to `us-east-1`. Account, team, billing, notification, and audit data stay in the primary stack.

For an existing deployment, pause published watchers or use a short maintenance window between the primary and regional commands. The new primary coordinator can enqueue immediately, while an old regional stack has no deterministic queue. Check-queue redelivery is idempotent, but pausing avoids noisy dispatch retries.

The first account-scoped access after upgrading a pre-0.5.0 table performs a one-time, condition-guarded index backfill for that account. Keep the maintenance window in place until the primary and regional deployments are complete; the first check or customer sign-in may take longer while legacy tenant, identity, and schedule attributes are installed. A durable marker prevents later reads from repeating the scan. For the first 60 seconds after that marker is written, reads overlay a strongly consistent compatibility scan so eventual GSI propagation cannot hide freshly indexed rows.

If you later remove a Region, first remove it from every watcher, wait for capture runs to finish/expire, satisfy the evidence-erasure/retention procedure in `data-lifecycle.md`, deploy the primary stack, and only then delete that exact regional CloudFormation stack. The deployment script never destroys regional stacks or retained buckets.

## Install provider secrets

Set Stripe values only in the protected local environment or an interactive secret source. Twilio is optional: leave `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` all blank for email-only operation, or configure all three to enable SMS. Then run:

```bash
npm run aws:push-secrets
```

For a new catalog, create the six monthly USD Stripe Prices in the selected Stripe environment. Reuse the existing matching Prices on subsequent deployments. Set `STRIPE_PRICE_FREE`, `STRIPE_PRICE_ESSENTIALS`, `STRIPE_PRICE_PROFESSIONAL`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_BUSINESS`, and `STRIPE_PRICE_SCALE`. See [Stripe catalog migration](stripe-price-migration-0.5.0.md). Stripe Prices are immutable; do not repurpose the former CAD objects. If paid legacy subscriptions exist, review and migrate them explicitly during the maintenance window. Release 0.5.0 keeps exact CAD renewals operational as a migration bridge, but retired accounts cannot make self-serve plan changes until support migrates them.

The script validates the selected mode and all six Prices before writing the Stripe configuration to Secrets Manager. It writes Twilio only when the complete optional configuration is present. Avoid putting secrets in CloudFormation parameters, shell history, source files, screenshots, or frontend runtime config.

## Deploy static applications

Install the pinned portal dependencies before deploying. The web deployment
stops before any S3 mutation if the self-hosted Pico or Manrope assets are
missing.

```bash
npm ci
npm run aws:deploy-web
```

The script builds the public Astro site, writes the portals’ public Cognito configuration, publishes immutable assets before HTML, and waits for CloudFront invalidations.

### Customer login and verification email

New production installations use `auth.<stage-domain>` with the stage's verified SES domain. The primary deploy publishes DKIM records before it switches Cognito to SES. Production sending requires regional SES production access. Staging and beta can select these features explicitly.

For an installed production stack, follow the [branded login cutover](production-cognito.md). Existing prefix pools can keep their current sign-in path during the switch. GitHub releases preserve the installed domain and email settings.

## Activate SES receiving

After domain/DKIM verification and reply-domain MX publication:

```bash
npm run aws:activate-ses
```

The script refuses to replace an unrelated active receipt-rule set unless `REPLACE_ACTIVE_SES_RULE_SET=true` is explicitly set after review. It also verifies the current environment's `webwatch-<stage>-replies` rule exists in the shared set before activation. Only one SES receipt-rule set can be active in the region; staging, beta, and production therefore contribute separate recipient rules to the bootstrap-owned shared set.

## Run the post-deploy audit

After the primary and every regional stack are complete, secrets are installed, and static assets are deployed:

```bash
npm run aws:audit -- --full
```

The audit now checks primary and regional capture queues/DLQs, queue visibility/redrive configuration, regional Lambda health, regional bucket encryption/lifecycle, main lifecycle controls, alarms, DynamoDB, and the existing application/provider surfaces. Do not resume production watchers while a capture/result DLQ is non-empty or a regional queue/bucket check fails.

## Origin verification secret rotation

CloudFormation does not automatically re-resolve a Secrets Manager dynamic reference merely because the secret value changed. After rotating the `webwatch-<stage>-cloudfront-origin` secret, increment `ORIGIN_VERIFY_REVISION` in the environment and run `npm run aws:deploy`. The revision changes the CloudFront origin configuration and forces CloudFormation to resolve the current secret value.

## Update staging allow-list

Edit the private file selected by `STAGING_IP_ALLOWLIST_FILE` (normally `.local/staging-ip-allowlist.txt`), then run the updater from the staging operator checkout.

```bash
npm run aws:update-allowlist
```

Console changes are allowed for urgent access changes but create CloudFormation drift. Reconcile the text file before the next deployment.

With `STAGING_CHATGPT_BROWSER_ENABLED=false`, each workstation needs a matching IP entry. When the exception is enabled, matching browser headers also pass the staging WAF from any IP. Protected routes still require application authentication.

```bash
aws cloudwatch describe-alarms --alarm-name-prefix webwatch-staging --state-value ALARM --region us-east-1 --profile saas-admin
```

## Failure diagnosis

```bash
npm run aws:stack-events
read -rp 'Failing Lambda function name: ' FUNCTION_NAME
aws logs tail "/aws/lambda/$FUNCTION_NAME" --since 30m --region us-east-1 --profile saas-admin
read -rp 'Affected dead-letter queue URL: ' DLQ_URL
aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names All --region us-east-1 --profile saas-admin
read -rp 'Stack name to check for drift: ' STACK_NAME
aws cloudformation detect-stack-drift --stack-name "$STACK_NAME" --region us-east-1 --profile saas-admin
```

Do not manually delete resources until stack events identify the blocker. Data resources use retention protections where rollback deletion would risk data loss or get stuck on non-empty buckets.

For missed notifications or stale Stripe account state, use the targeted commands in [`operations.md`](operations.md) before creating another subscription or changing provider configuration.

### Recover a failed 0.5.2 API stage update

If `webwatch-staging` is in `UPDATE_ROLLBACK_FAILED` because `ApiStage` reports a missing `ANY /api/team/{proxy+}` route, stop before building or deploying. This release adds an explicit `ApiStage` dependency on `TeamProxyRoute`, so future CloudFormation operations create the route before applying its stage throttle; it cannot change an already running rollback. Inspect both the currently deployed route and CloudFormation ownership with these read-only commands:

```bash
aws cloudformation describe-stack-resource --stack-name webwatch-staging --logical-resource-id TeamProxyRoute --region us-east-1 --profile saas-admin --query 'StackResourceDetail.[ResourceStatus,PhysicalResourceId,ResourceStatusReason]' --output table --no-cli-pager
API_ID="$(aws cloudformation describe-stack-resource --stack-name webwatch-staging --logical-resource-id HttpApi --region us-east-1 --profile saas-admin --query 'StackResourceDetail.PhysicalResourceId' --output text)"
aws apigatewayv2 get-routes --api-id "$API_ID" --region us-east-1 --profile saas-admin --query 'Items[].[RouteKey,RouteId]' --output table --no-cli-pager
aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name '$default' --region us-east-1 --profile saas-admin --query 'RouteSettings' --output json --no-cli-pager
```

If `TeamProxyRoute` belongs to the existing stack but its physical route ID is absent from API Gateway, its CloudFormation ownership needs reconciliation before another deployment; a dependency cannot recreate a missing physical resource that CloudFormation believes it already owns. Do not create an untracked replacement route with the same key. If the route was being added by the failed change set and the prior template references the route only in `ApiStage.RouteSettings`, continue rollback with no skip first. Should it fail again with the same missing-route error, `--resources-to-skip ApiStage` is the narrow recovery option, but the resulting stage is inconsistent with the old template until the corrected stack update succeeds. Confirm the resource ownership and event timestamps before using that option. CloudFront header-policy and dead-letter-queue errors marked “Resource update/creation cancelled” are consequences of the stage failure, not separate configuration faults.

## Rollback exercise

Before customer use:

1. Deploy staging successfully.
2. Make an intentionally invalid, non-data parameter change in a temporary branch/template.
3. Confirm CloudFormation rolls back without deleting retained data.
4. Restore the valid template and deploy again.
5. Verify API, dispatcher, queues, Cognito login, browser capture, and portals.
6. Record stack outputs and rollback evidence in the release checklist.

The account-state condition in scoped DynamoDB transactions requires `dynamodb:ConditionCheckItem`, as described in [AWS transactional IAM](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html). API, worker/billing, report and inbound-email roles now receive that action only on the primary Core table; deploy the matching role policies with this source before exercising tenant mutations.
