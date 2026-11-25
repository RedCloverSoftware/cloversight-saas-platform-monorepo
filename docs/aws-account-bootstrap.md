# First AWS installation

Use this guide to take one reviewed release from a local checkout to a working staging environment, then repeat it for production. The workstation provisions the first stacks. GitHub Actions can release to production once those stacks exist. For an installation already serving users, use the [deployment runbook](deployment.md) or the [CI/CD walkthrough](github-production.md).

## 1. Set up account access

1. Secure the AWS root user with MFA, remove any root access keys and set billing, security and operations contacts. Use a separate human identity for the steps below. [Root user guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html)
2. In the AWS Organizations management account, enable an **organization instance** of IAM Identity Center. A standalone account can create an organization during enablement. Create or connect your user, require MFA at the identity provider, and assign the user or group a permission set in the target AWS account. The initial administrator needs to create the bootstrap CloudFormation stack and its IAM, S3, ECR and SES resources. Keep routine deployment access separate from this initial admin access. [Enable Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/enable-identity-center.html) · [Assign account access](https://docs.aws.amazon.com/singlesignon/latest/userguide/assignusers.html)
3. Install AWS CLI v2, Docker Engine with Buildx, Git, Node, npm, Python 3 and `zip` on the workstation. On Tumbleweed see [workstation tools](testing.md#workstation-tools). Configure **`saas-admin`** with your access portal start URL, Identity Center region and permission set. Choose `us-east-1` as the CLI default deployment region and `json` for output. [AWS CLI SSO setup](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)

```bash
aws configure sso --profile saas-admin
aws sso login --profile saas-admin
aws sts get-caller-identity --profile saas-admin --query '{Account:Account,Arn:Arn}' --output table
docker info >/dev/null && docker buildx version
```

Record the 12-digit account ID. To get the **IAM role ARN** for `AWS_DEPLOYMENT_PRINCIPAL_ARN`, resolve the signed-in role name through IAM. The STS session ARN printed above identifies just this login.

```bash
CALLER_ARN="$(aws sts get-caller-identity --profile saas-admin --query Arn --output text)"
ROLE_SESSION="${CALLER_ARN#*:assumed-role/}"
ROLE_NAME="${ROLE_SESSION%%/*}"
aws iam get-role --profile saas-admin --role-name "$ROLE_NAME" --query Role.Arn --output text
```

Use the full `arn:aws:iam::…:role/…` returned by IAM, including its Identity Center path. Set up an account or organization CloudTrail trail with a protected destination, account-level S3 Block Public Access and billing alerts. These account controls sit outside the application stacks. [Identity Center role ARNs](https://docs.aws.amazon.com/singlesignon/latest/userguide/referencingpermissionsets.html)

## 2. Prepare the domain and regions

The examples use `BASE_DOMAIN=cloversight.app`. For staging the scripts add `staging.` automatically. Pick a domain you control. Use its existing authoritative **public Route 53 hosted zone**, or create one and delegate it at the registrar. Save the zone ID without `/hostedzone/`. If staging runs in a separate AWS account, you can create and delegate the `staging.<base-domain>` child zone to that account. [Route 53 delegation](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/MigratingDNS.html) · [Delegating a child zone](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-routing-traffic-for-subdomains.html)

In ACM **in `us-east-1` in the target account**, request a public certificate covering the names below. Choose DNS validation, publish the ACM CNAMEs and wait for **Issued**. Keep the validation records for renewal. Production defaults to a custom customer sign-in host. Staging defaults to the AWS prefix. [CloudFront certificate requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html) · [ACM DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)

| Environment | Required CloudFront names with `BASE_DOMAIN=cloversight.app` |
| --- | --- |
| Staging | `staging.cloversight.app`, `login.staging.cloversight.app`, `stewards.staging.cloversight.app` |
| Production | `cloversight.app`, `login.cloversight.app`, `stewards.cloversight.app`, `auth.cloversight.app` (or a separate us-east-1 certificate for auth) |

The customer portal lives at `/app/` on the public host. The legacy `login.` hostname still needs certificate coverage. A wildcard covers one label, so `*.cloversight.app` alone misses the apex and `stewards.staging.cloversight.app`. For a new production deployment set `COGNITO_CUSTOMER_DOMAIN_MODE=custom` and `COGNITO_EMAIL_DELIVERY=ses` if your copied environment file has older defaults. For staging with a branded login include `auth.staging.cloversight.app` on the certificate. CloudFormation creates the web aliases, SES domain identity, DKIM, mail and reply records. Resolve existing records or identities owned outside the stack before deploying.

The default capture regions are `us-east-1,us-east-2,us-west-2,ca-central-1,eu-west-1`. Keep all five to offer five-region checks. A smaller installation requires at least three supported regions including `us-east-1`. Check Lambda headroom in **each** target region before the browser build:

```bash
for region in us-east-1 us-east-2 us-west-2 ca-central-1 eu-west-1; do
  printf '%s ' "$region"
  aws lambda get-account-settings --profile saas-admin --region "$region" \
    --query 'AccountLimit.UnreservedConcurrentExecutions' --output text
done
```

With the template defaults, a first environment needs at least **179** unreserved slots in the primary region (79 new reservations plus 100 remaining) and **164** in each secondary region (64 plus 100). Existing workloads, a second environment or changed settings affect headroom. New accounts may start below these levels. Request the needed increases in **Service Quotas → AWS Lambda** for each region. These are concurrency reservations. KMS keys, alarms and storage can still incur charges when customer traffic is low. The account-wide budget sends alerts as costs accrue. [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) · [Cost model](cost-model.md)

## 3. Give each stage its own checkout and configuration

Keep a clean dev checkout and a separate private operator directory per stage. With Git, run the following **once**, from the reviewed commit you want to deploy. With a source ZIP, extract that same release into two new directories instead.

```bash
git worktree add --detach ../cloversight-staging HEAD
git worktree add --detach ../cloversight-prod HEAD
cd ../cloversight-staging
```

Start with staging. From its root, create the private configuration and install the pinned tools. Repeat the block in the production checkout when you reach step 7. A previous configuration in that directory is preserved.

```bash
umask 077
test -e .env || cp .env.example .env
chmod 600 .env
npm ci && npm run deps:check
python3 -m venv .local/iac-venv &&
  .local/iac-venv/bin/python -m pip install -r infra/requirements-iac.txt
```

Edit the existing assignments in `.env`. Keep `AWS_PROFILE=saas-admin` here because the deployment scripts source this file. Set `AWS_ACCOUNT_ID`, `AWS_DEPLOYMENT_PRINCIPAL_ARN` from step 1, `AWS_REGION=us-east-1`, `BASE_DOMAIN`, `ROUTE53_HOSTED_ZONE_ID`, `CLOUDFRONT_CERTIFICATE_ARN` and `REGIONAL_CHECK_REGIONS`. Set your own contact addresses and `MONTHLY_BUDGET_USD`. The remaining differences are listed below.

| Setting | Staging | Production |
| --- | --- | --- |
| `STAGE` / `STACK_NAME` | `staging` / `webwatch-staging` | `prod` / `webwatch-prod` |
| New pool login and email | `COGNITO_CUSTOMER_DOMAIN_MODE=prefix`, `COGNITO_EMAIL_DELIVERY=cognito` | `COGNITO_CUSTOMER_DOMAIN_MODE=custom`, `COGNITO_EMAIL_DELIVERY=ses`. Obtain regional SES production access before enabling public signups. |
| Access | Put your real operator CIDRs in `.local/staging-ip-allowlist.txt`. Set `STAGING_CHATGPT_BROWSER_ENABLED=false` for IP-only access. Its default `true` also permits the documented, spoofable browser-header exception. | The staging WAF is absent. Set `COGNITO_STEWARD_MFA=ON` and prepare software-token enrollment. |
| Alert destinations | Set `OPS_ALERT_EMAIL` and `BUDGET_ALERT_EMAIL` for exercised mail. If enabling app alerts, set `TECHNICAL_ALERTS_ENABLED=true` and your own `TECHNICAL_ALERT_EMAIL`. | Set `TECHNICAL_ALERTS_ENABLED=true` and explicitly set `TECHNICAL_ALERT_EMAIL` (app/SES), `OPS_ALERT_EMAIL` (SNS) and `BUDGET_ALERT_EMAIL` (Budgets). |
| Stripe | `STRIPE_MODE=test` with objects from one Stripe sandbox. | `STRIPE_MODE=live` with live objects. For a deliberate sandbox trial on the production URL, use `test` and follow the [live cutover](stripe-production-test-0.5.20.md). |

For staging, create the private allowlist from the tracked example, then **replace every example network** with an authorized egress address or range, such as your workstation’s public IP with `/32` for IPv4 (`/128` for one IPv6 address). To exercise staging with a hosted CI runner, include its dedicated egress. [Staging access](staging-browser-access.md)

```bash
mkdir -p .local
test -e .local/staging-ip-allowlist.txt || cp config/staging-ip-allowlist.txt .local/staging-ip-allowlist.txt
```

Leave `STEWARD_OWNER_SUB` and `STRIPE_WEBHOOK_SECRET` empty for the first **primary-only** deploy below. Leave generated role, bucket and image values for the scripts. The local `BILLING_PROVIDER` and `EMAIL_PROVIDER` defaults are for development. In AWS, staging uses real SES and optional Twilio even when Stripe is in test mode.

## 4. Bootstrap access and create the primary stack

From the selected stage directory, create or update the shared bootstrap stack.

```bash
aws sso login --profile saas-admin
npm run aws:bootstrap
```

Bootstrap creates the deployment and CloudFormation execution roles, a private artifact bucket, the worker ECR repository and a shared SES receiving rule set. The wrapper merges the five generated values into this checkout’s `.env`. Keep the default `BOOTSTRAP_STACK_NAME=webwatch-deployment-bootstrap` and `webwatch-shared-inbound` rule set when both environments share an account. Run the same bootstrap from the other checkout to populate its values.

Grant the calling Identity Center permission set `sts:AssumeRole` on the **exact generated `AWS_DEPLOYMENT_ROLE_ARN`** if it lacks that permission. In **IAM Identity Center → Permission sets**, edit that permission set’s permissions, add an Allow for the action on that role, and provision the updated permission set to the target account. Refresh your login and confirm that STS returns the assumed deployment role:

```bash
aws sso login --profile saas-admin
bash infra/scripts/assume-deployment-role.sh aws sts get-caller-identity --query Arn --output text
```

Build the worker, merge its generated digest and verify the resolved hosts and stack before creating resources. These granular commands stop after the primary stack, so you can register Stripe against its real API endpoint before publishing the sites.

```bash
npm run aws:build-worker &&
  bash infra/scripts/merge-generated-env.sh .local/worker-image.env &&
  npm run deploy:settings &&
  npm run deploy:validate
```

With the correct account, domain and stack selected, run:

```bash
npm run aws:deploy
```

Wait for `CREATE_COMPLETE`. If a command fails, inspect `npm run aws:stack-events` and the [recovery guide](upgrade-0.5.20.md) before retrying. Keep `.local/worker-image.env` in this operator directory for the next deployment.

## 5. Connect billing and create the first steward

Use this helper in the current Bash session to read outputs from the stack selected by the private `.env`. It prints the requested value and keeps provider credentials out of the terminal output.

```bash
stage_output() (
  ROOT="$PWD"
  source infra/scripts/lib.sh
  load_webwatch_env
  aws_source cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text --no-cli-pager
)
stage_output StripeWebhookUrl
stage_output StewardUserPoolId
```

**Stripe.** Select the matching sandbox or live account in the Stripe Dashboard. In **Product catalog**, create active fixed-price monthly subscriptions in **USD** with one licensed unit and a single monthly interval. Use a recurring **Price** for each plan: Free **$0**, Essentials **$19**, Professional **$49**, Team **$149**, Business **$399**, Scale **$899**. Copy the six `price_…` IDs into their corresponding `STRIPE_PRICE_…` entries. Scale is sales-assisted and still needs a Price for catalog validation. [Stripe products and prices](https://docs.stripe.com/products-prices/manage-prices)

In **Workbench → Webhooks**, create a snapshot webhook destination for **your account** using the exact `StripeWebhookUrl`. Use the project’s pinned API version `2025-06-30.basil`. Select `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded` and `invoice.payment_failed`. Save the destination, reveal its `whsec_…` signing secret, then fill `STRIPE_WEBHOOK_SECRET` and the matching `STRIPE_SECRET_KEY` in this stage’s private `.env`. The final deploy checks the six Prices before uploading the configuration to Secrets Manager. [Stripe webhook setup](https://docs.stripe.com/webhooks)

**Optional SMS.** For email-only deployment, leave `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` blank. To enable SMS, supply all three before the final primary update, then use the enabled stack’s `TwilioInboundWebhookUrl` and `TwilioStatusWebhookUrl` when configuring and testing the integration. [Notification channels](notifications.md)

**Steward owner.** For a new pool, use an email inbox controlled by the intended platform owner. The command below sends an invitation. The steward pool’s temporary password expires after one day. If the user already exists, reuse it and go straight to the subject lookup.

```bash
POOL_ID="$(stage_output StewardUserPoolId)"
read -rp 'Steward owner email: ' OWNER_EMAIL
aws cognito-idp admin-create-user --profile saas-admin --region us-east-1 \
  --user-pool-id "$POOL_ID" --username "$OWNER_EMAIL" \
  --user-attributes "Name=email,Value=$OWNER_EMAIL" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL --query 'User.Username' --output text
```

```bash
aws cognito-idp admin-get-user --profile saas-admin --region us-east-1 \
  --user-pool-id "$POOL_ID" --username "$OWNER_EMAIL" \
  --query "UserAttributes[?Name=='sub'].Value | [0]" --output text
```

Set `STEWARD_OWNER_SUB` in this stage’s `.env` to that exact subject. Each pool issues its own subject. Keep the production owner binding across upgrades. [Steward access and recovery](steward-security.md)

## 6. Publish and verify this stage

```bash
npm run deploy -- --reuse-image
```

This applies the owner setting, deploys the stack in each selected secondary region, validates and uploads provider secrets, publishes the three web surfaces, waits for CloudFront and activates the shared SES rule set. It uses the image built from this checkout in step 4. An unrelated active SES rule set requires an explicit operator decision. A region can have one active receiving rule set. [SES receiving](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html)

Before admitting customers:

1. Open the URLs returned by `stage_output PublicUrl`, `stage_output CustomerUrl` and `stage_output StewardUrl`. Check the API, sign in to both portals and complete the steward’s first password change and MFA when enabled.
2. In SES in `us-east-1`, check the stack-created domain identity and DKIM verification, reply-domain MX and receipt rule. In the sandbox use verified test recipients. Obtain SES production access before sending to customers, and test delivery and a reply. Provision and test `support@cloversight.app` before launch, including delivery from an external address. The public site uses this mailbox for support, privacy and security inquiries. Confirm the fixed steward security destination with the platform owner. [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
3. Confirm the SNS email for the primary topic and **each** regional operations topic that was created. Use `OpsTopicArn` in each stack’s outputs to check its subscription is confirmed. Verify a controlled alarm reaches the operator. [SNS email confirmation](https://docs.aws.amazon.com/sns/latest/dg/sns-email-notifications.html)
4. In staging, complete a sandbox checkout and confirm Stripe delivered the webhook and the portal shows the expected plan. Create a watcher for a site you control, let a scheduled check run, then open its screenshots and check usage. Exercise cancellation, notifications and regional results before production. [Staging checks](ci-staging-verification-2026-09-26.md)

```bash
curl -fsS "$(stage_output PublicUrl)/api/health"
npm run aws:audit -- --full
```

Look for `{"status":"healthy"}` and review audit findings, including regional queues, dead-letter queues and alarms. The audit and a successful stack deployment cover different checks.

## 7. Repeat for production, then enable CI/CD

Use the **production operator checkout** at the same tested commit. Repeat steps 2–6 with production names, certificates, contacts, Stripe objects and the production steward subject. Use a separate AWS account for production when possible. In that layout each account needs its own bootstrap, delegated zone and certificate. Select the corresponding SSO profile in the checkout and CLI commands (`saas-admin` in the production examples). In a shared account, the bootstrap can be reused, but each stage still has its own application stacks, user pools, settings and webhook endpoint.

The supplied business workflow is bound to **AWS account `807434077491`**, `webwatch-prod` and `cloversight.app`. If deploying to a different account or domain, review the account and role in `.github/workflows/production.yml`, the installation and smoke-test targets in `scripts/github-production.mjs`, and the live fixture in `scripts/scheduled-acceptance.mjs` before enabling the workflow. The public Astro canonical URL and branded contacts also need review for a different domain. The account bootstrap and workstation install use the configured target.

For subsequent releases, follow the [GitHub Actions walkthrough](github-production.md). It guides you through the public personal archive, the business fork and its OIDC role, read-only inspection and first verified release. The business runner reads existing CloudFormation values and assumes short-lived AWS credentials. Keep production `.env` and its backups private for operator tasks and secret rotation.

**Access scope.** The human deployment role passes a specific execution role to CloudFormation. That execution role can manage application IAM roles under the `webwatch-staging-*`, `webwatch-beta-*` and `webwatch-prod-*` names and has broad provisioning permissions for the authored AWS services. Restrict who can deploy and review infrastructure changes. Cost-tag activation, approved audit retention and Cost Anomaly Detection remain account-owner tasks. [Deployment and budget reference](deployment.md)
