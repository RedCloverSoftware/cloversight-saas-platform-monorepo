# Branded customer login and verification mail on cloversight.app

Use this once for the existing business production installation in `us-east-1`. The customer sign-in address is `auth.cloversight.app`. The customer portal and OAuth callback stay at `https://cloversight.app/app/`. The steward portal has its own pool, app client, sign-in domain and MFA. Both pools will send Cognito mail from **Cloversight <no-reply@cloversight.app>**.

## Apply the patch to the business checkout

If this guide already came from the merged business branch, start at step 1. Otherwise download `cloversight-production-auth.patch` to `~/Downloads`. From a clean checkout:

```bash
cd ~/Projects/cloversight-saas-platform-business/cloversight-saas-platform-monorepo
git fetch origin main &&
git switch -c fix/production-cognito origin/main &&
git apply --check ~/Downloads/cloversight-production-auth.patch &&
git apply --index ~/Downloads/cloversight-production-auth.patch
git diff --cached --check && git diff --cached --stat
```

The patch was built from the supplied 0.5.22 source. If the check reports a conflict, compare those paths with your business revision before applying. The inspected stack supplies the deployment values in this procedure.

## 1. Inspect the installation

From the patched business checkout on openSUSE, with AWS CLI v2, Python 3, GitHub CLI and jq:

```bash
cd ~/Projects/cloversight-saas-platform-business/cloversight-saas-platform-monorepo
export AWS_PROFILE=saas-admin AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
BUSINESS=RedCloverSoftware/cloversight-saas-platform-monorepo
aws sts get-caller-identity --query '[Account,Arn]' --output table
python3 scripts/plan-production-login.py inspect
curl -fsS https://cloversight.app/runtime-config.json | jq '{cognitoDomain,clientId,redirectUri}'
```

Confirm AWS account `807434077491`. Record both pool IDs and the customer client ID to compare after rollout. The inspection prints the existing stack's outputs, actual Cognito senders, the apex and auth records in the stack's hosted zone, ACM names and SES status. A prefix-mode stack with an Amazon hostname in the runtime JSON explains the current login. If the stack and Cognito are already custom but the runtime JSON is old, go straight to web publication in step 4 for the domain. Use the other steps for the mail change.

The public apex must resolve to an A record. ACM must report **ISSUED** for an exact `auth.cloversight.app` name or `*.cloversight.app` in `us-east-1`. A certificate covering only the apex and the two portals needs an additional certificate. Request one for `auth.cloversight.app` in ACM, choose DNS validation, use **Create records in Route 53**, and wait for **Issued**. Then export `COGNITO_CUSTOMER_CERTIFICATE_ARN` in this shell to that ARN. Otherwise the planner uses the installed auth certificate, falling back to the web certificate. CloudFormation creates the auth alias to Cognito's own CloudFront target. The auth host must not be an alias of the site's distribution.

SES must report verified, **DKIM SUCCESS**, **production true** and **sending true**. The primary stack owns the identity, its three DKIM CNAMEs and the MAIL FROM records. If verification is pending, compare the DNS names under SES → **Verified identities → cloversight.app → Authentication** with this public zone and its registrar delegation. If sandboxed, in SES **in us-east-1**, open **Account dashboard → Request production access**, select transactional mail and describe account verification and password resets. Wait for approval. Receiving-rule activation configures inbound mail separately.

## 2. Install the reviewed templates

Apply the patch on a business branch, run its tests, and merge its PR to `main`. Allow the ordinary **production / release** job to finish. It installs the new template and preserves the current sign-in parameters. In this same checkout switch to the merged revision before updating the existing bootstrap stack. These commands use the previously installed bootstrap parameters.

```bash
node --test tests/cognito-cutover.test.mjs tests/deployment-settings.test.mjs \
  tests/aws-live-preflight.test.mjs tests/deployment-auth-preflight.test.mjs &&
npm run iac:validate && npm run iac:schema &&
git commit -m "Use the production Cognito hostname and verified SES sender" &&
git push -u origin HEAD &&
gh pr create --repo "$BUSINESS" --base main --fill
```

Use the project's pinned IaC tools for local schema validation. If needed, create them once with `python3 -m venv .local/iac-venv`, run `.local/iac-venv/bin/python -m pip install -r infra/requirements-iac.txt`, and activate the environment with `source .local/iac-venv/bin/activate` before running the tests. After review, merge the business PR and wait for its main-branch production release before continuing.

```bash
git switch main && git pull --ff-only origin main
aws cloudformation describe-stacks --stack-name webwatch-deployment-bootstrap \
  --query 'Stacks[0].[StackId,StackStatus]' --output table &&
aws cloudformation deploy --stack-name webwatch-deployment-bootstrap \
  --template-file infra/bootstrap/access.yaml --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset
```

This allows CloudFormation to create Cognito's email service-linked role and the workstation deployment role to read the SES account's sending status. The CI release role and the GitHub repository variables keep their existing permissions and values.

## 3. Review and execute the production configuration change

Run between releases. The planner targets the installed primary stack and uses its current template. It preserves all other parameter values, including the runtime artifact and worker image. A pool already using custom-only login keeps that mode. A pool using the prefix gets `custom-with-prefix` so its existing branding and sign-in path remain available. For the apex hosted zone, compare the printed delegation with `dig +short NS cloversight.app` before proceeding.

```bash
python3 scripts/plan-production-login.py plan
```

If one prerequisite is pending, use `plan --only domain` or `plan --only email` to ship the ready feature. Repeat this step for the other when ready. Web publication is required when changing the login hostname. If the planner reports that the settings are already installed, continue to the relevant verification. Otherwise copy the whole change-set ARN from its last line.

```bash
read -rp 'Change-set ARN printed above: ' CHANGE_SET
aws cloudformation wait change-set-create-complete --change-set-name "$CHANGE_SET" &&
aws cloudformation describe-change-set --change-set-name "$CHANGE_SET" \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,Replacement]' --output table
```

Expect in-place pool mail updates and, if needed, the new customer custom domain and DNS aliases. Check any reported dependent changes. Stop if a pool or client would be replaced or removed, an existing prefix or branding resource would be deleted, or unrelated infrastructure would change. After reviewing:

```bash
aws cloudformation execute-change-set --change-set-name "$CHANGE_SET" &&
aws cloudformation wait stack-update-complete --stack-name webwatch-prod
python3 scripts/plan-production-login.py inspect
```

The custom domain should report **ACTIVE**, point to the existing customer pool, and both pools should show **DEVELOPER** with the expected From address. Allow time for DNS and CloudFront propagation before switching the browser to the new host. Open this URL with the actual installed public client and callback to check that TLS works and the managed login form renders:

```bash
CLIENT=$(aws cloudformation describe-stacks --stack-name webwatch-prod \
  --query "Stacks[0].Outputs[?OutputKey=='CustomerClientId'].OutputValue | [0]" --output text)
printf 'https://auth.cloversight.app/login?client_id=%s&response_type=code&scope=openid&redirect_uri=https%%3A%%2F%%2Fcloversight.app%%2Fapp%%2F\n' "$CLIENT"
```

## 4. Publish the customer runtime configuration and verify

Dispatch the existing production workflow against the merged business `main`. This forces a full release including the portal runtime configuration. The job reads the installed stack parameters. A normal push to main continues to be the trigger for future changes.

```bash
RUN_ID=$(gh api --method POST -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$BUSINESS/actions/workflows/ci.yml/dispatches" \
  -f ref=main -f 'inputs[target]=deploy-production' --jq .workflow_run_id) &&
  gh run watch "$RUN_ID" --repo "$BUSINESS" --exit-status
curl -fsS https://cloversight.app/runtime-config.json | jq -e \
  '.cognitoDomain == "https://auth.cloversight.app" and .redirectUri == "https://cloversight.app/app/"'
```

In a private browser, sign up with a mailbox you control, redeem the code, sign out, sign back in, and request a password reset. Check the visible From address, the receiving mailbox's DKIM/DMARC results and the post-login URL. Sign in separately with an existing customer and check the same account and watchers. Check steward MFA with an existing steward. Newly generated messages exercise the new sender.

No local secrets are required for this cutover. For future manual deployments, match the installed settings in your private operator `.env`: `COGNITO_EMAIL_DELIVERY=ses`, the installed `COGNITO_CUSTOMER_DOMAIN_MODE`, and the auth certificate ARN if different from the web certificate. Add no Stripe values or AWS access keys to GitHub. Existing app clients, OAuth callbacks, token issuers and billing configuration keep their current identifiers.

**Recovery.** If the browser switch causes trouble on a pool migrated from prefix, its old prefix still exists. You can restore the former public client configuration first with the working prefix, then return the stack to its recorded prefix mode and republish. To restore the original sender, update just `CognitoEmailDelivery` to `cognito` with the current template and previous values for other parameters. Use reviewed CloudFormation change sets. Keep the pools and their deletion protection in place. Sign-in cookies are host-specific, so a customer may have to sign in again on the new host.

[AWS custom-domain requirements](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-add-custom-domain.html) · [Cognito domain coexistence and discovery](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-assign-domain-prefix.html) · [Cognito email and SES](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html)
