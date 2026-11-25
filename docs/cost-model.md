# Capture-credit cost model

These figures are planning examples, not a bill forecast. Recalculate with current AWS prices and measured staging p50/p95 duration, memory, image bytes, request count, logs, retries, data transfer, notification volume, payment fees, tax, and support.

## Continuous 250-watcher scenario

250 watchers every 120 seconds in one Region request **5,400,000 captures per 30-day month**. Business's 100,000 credits cover about 13.3 hours at that rate; Scale's 300,000 cover 40 hours. At 15 billed seconds and 2 GB, the illustrative browser compute alone is about $2,700/month. Five Regions multiply captures and compute by five. Current subscriptions are intentionally unchanged; this workload needs measured economics and an explicitly purchased higher allowance/overage design before it can run continuously.

Run `npm run capacity:plan -- --watchers 250 --interval 120 --regions 1 --mean-seconds 15 --p95-seconds 30 --concurrency 96`. The calculator exposes cost assumptions, exclusions, credit coverage, evidence volume and conservative concurrency sizing. See the [production review](security-production-review-0.5.16.md) for the capacity table and remaining retention/financial gates. The 64-slot default reserves quota without provisioned concurrency; use measured tails to select a different ceiling. The new collection queries avoid reconstructing capture history on quiet maintenance discovery, but do not eliminate active global mutations or retention costs.

## Billing unit

One capture credit is one saved watcher run in one AWS Region. Desktop, tablet, mobile, and all enabled detectors are included. A five-Region run uses five credits. Target outages are billable because the browser attempt produced an outcome; internal CLOVERSIGHT retries and infrastructure failures are not.

Included credits do not roll over. The coordinator reserves credits before dispatch, pauses further checks at the allowance, and refunds only Regions classified as infrastructure failures.

## Plan ceilings

At an illustrative 15 seconds and 2 GB per browser Lambda, one capture consumes 30 GB-seconds. Using the commonly published example rate of USD $0.0000166667 per GB-second, compute is approximately $0.00050 per capture before free tier, requests, storage, transfer, and logs.

| Plan | USD/month | Included captures | Illustrative browser compute | Fastest cadence | Regional allowance |
|---|---:|---:|---:|---|---|
| Free | $0 | 10 | <$0.01 | weekly after trial | primary Region |
| Essentials | $19 | 1,000 | ~$0.50 | hourly | primary Region |
| Professional | $49 | 10,000 | ~$5 | 15 minutes | 2 Regions on 10 watchers |
| Team | $149 | 30,000 | ~$15 | 5 minutes | 3 Regions on 25 watchers |
| Business | $399 | 100,000 | ~$50 | 2 minutes | 5 Regions on 100 watchers |
| Scale | $899 | 300,000 | ~$150 | 2 minutes | 5 Regions on all watchers |

Cadence and watcher limits describe capability; credits enforce the monthly saved-capture allowance. They do not cap AWS spending: refunded infrastructure failures, physical retries, standing resources, retained storage and transfer can still incur charges. A customer cannot run every watcher at the fastest cadence indefinitely unless the included credits support it.

## One fully used Free account in us-east-1

Use a 30-day month and USD list prices. The current Free subscription includes one watcher in the primary region, five recipients in a single tier, 50 **account-wide** notification email attempts per UTC day, seven days of history, and zero SMS or PDF reports. The initial 30-day trial allows a daily cadence and 31 capture credits. Later periods allow a weekly cadence and 10 credits. Scheduled checks alone generally use fewer than those allowances.

| Usage assumption | Regular Free | Initial trial |
| --- | ---: | ---: |
| 1,500 recipient emails accepted by SES at $0.10 per 1,000 | $0.1500 | $0.1500 |
| 10 or 31 captures, one x86 2 GB attempt per credit at 15 billed seconds | $0.0050 | $0.0155 |
| Capture compute if each of those attempts instead consumes the 180-second timeout | $0.0600 | $0.1860 |
| One direct-sign-in Cognito Essentials active user | $0 or $0.015 | $0 or $0.015 |

The two capture rows are alternative durations. Using every daily email slot is a conservative budget assumption. For perspective, if each of ten captures opens one incident and one Free tier sends to five people once, that produces 50 recipient emails for the whole month ($0.005). The same trial example gives 155 ($0.0155). Actual incidents, retries and additional transactional mail change that result. A signup or password-reset email adds roughly $0.0001 per recipient at list price. At the expected low MAU count, direct sign-in ordinarily falls within Cognito's 10,000-MAU monthly allowance. The other service figures above intentionally ignore shared free tiers, credits and taxes.

For an illustrative ordinary-use allowance beyond captures and alerts, 10,000 DynamoDB WRUs and 50,000 RRUs cost about $0.0125, and 20 MB of CloudWatch log ingestion costs about $0.01. Reserve another $0.02 for short API/worker invocations, queues, small evidence storage and occasional downloads. At three MiB of new screenshot sources per credit, the 30 or 93 MiB of incoming screenshots alone consume a small fraction of that reserve with seven-day retention. These usage quantities are sizing assumptions awaiting production measurement. They yield **about $0.20 regular / $0.21 trial** at 15 seconds or **$0.25 / $0.38** at the timeout, before any billed Cognito MAU, large transfers or repeated physical attempts. Shared maintenance, the hosted zone, WAF, metrics, alarms, KMS keys, backups and other standing infrastructure are separate. For a fully allocated cost, add the chosen share of the monthly baseline.

**Sustained API traffic is a different cost case.** The customer limiter permits 600 ordinary authenticated calls per minute per account, with a tighter 60/minute bootstrap limit and separate mutation limits. At 600 otherwise permitted small reads per minute for 30 days, 25.92 million requests cost about $25.92 for HTTP API Gateway. Each ordinary allowed call makes two DynamoDB counter updates; at one WRU each, the counters add about $32.40. If each invokes the 768 MB API Lambda for 100 ms, compute and request fees add about $37.58. **About $96** for those components excludes actual business reads, evidence egress, logs, identity checks and shared infrastructure. This is a workload sensitivity, not observed consumption. Credit limits do not bound monthly spending on portal/API traffic, evidence bytes, Cognito email or refunded infrastructure retries.

[SES](https://aws.amazon.com/ses/pricing/) · [Lambda](https://aws.amazon.com/lambda/pricing/) · [Cognito](https://aws.amazon.com/cognito/pricing/) · [DynamoDB](https://aws.amazon.com/dynamodb/pricing/on-demand/) · [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) · [HTTP API Gateway](https://aws.amazon.com/api-gateway/pricing/)

## Storage sensitivity

If each responsive source averages 1 MiB, three source PNGs produce about 3 MiB per credit before text, previews, and occasional diff overlays.

| Credits | New source PNGs/month at 1 MiB each |
|---:|---:|
| 1,000 | ~2.9 GiB |
| 10,000 | ~29 GiB |
| 30,000 | ~88 GiB |
| 100,000 | ~293 GiB |
| 300,000 | ~879 GiB |

Full-page PNGs can be much larger. Measure p50/p95 bytes and tall-page outliers before enabling Scale. Content-addressed objects reduce identical re-storage within a Region/month/retention cohort; they do not make a high-change workload free.

Lifecycle classes align storage duration with each plan. Eligible large objects move to Standard-IA after day 31 and longer-lived classes move to Glacier Instant Retrieval after day 90. AWS's default 128 KB transition floor keeps small text and metadata in Standard, avoiding transition/minimum-size overhead.

## Cost changes in 0.5.0

- Durable regional SQS replaces synchronous cross-Region orchestration, absorbs bursts, and uses tenant-hashed fair-queue groups to limit noisy-neighbor dwell time.
- Local comparison means screenshot and text bodies do not return to the primary Region.
- Only compact result metadata crosses Regions.
- Content hashes prevent duplicate monthly evidence uploads and identical prior-image reads.
- Tenant/account queries and sharded schedules replace global scans on the capture hot path.
- Direct pre-signed downloads remove API Gateway/Lambda binary proxy cost.
- Credit exhaustion and watcher state remove non-runnable work from scheduling.
- ECR expires only untagged build remnants after seven days; tagged deployment releases require explicit retirement checks.

## Measurements required before production

Track per Region and plan:

- browser duration and memory GB-seconds;
- successful, target-outage, retried, timed-out, and DLQ captures;
- transferred page bytes and stored PNG/text/diff bytes;
- dedupe hit rate and previous-hash shortcut rate;
- Standard, Standard-IA, and Glacier Instant Retrieval bytes/requests;
- SQS age/depth, result latency, DynamoDB consumed capacity, and log ingestion;
- notification/report volume and Stripe fees;
- credits used versus included and gross margin by cohort.

Scale remains sales-assisted until those measurements exist and the included 1 TB retention ceiling has an enforceable meter.

## Audit-supported changes in 0.5.11

The [October 8 audit](aws-audit-review-2026-10-08.md) measured 2,102,137 CoreTable consumed read units over a quiet day with zero scheduled watcher dispatches. Successful schema initialization is now cached only per store instance, and two bulk cleanup scans run every 15 minutes while urgent maintenance stays at one minute. This removes roughly 23% of the observed idle maintenance reconstruction pattern, not 23% of the AWS bill. Global notification/billing compatibility scans remain a scaling limit.

A new shared incomplete-run metric/alarm adds CloudWatch monitoring cost. Tagged image retention can increase ECR storage until releases are deliberately retired. Capture memory, concurrency, encryption, customer retention and isolation were preserved; ten observed regional invocations do not justify reducing browser CPU/memory. The audit has no invoice or Cost Explorer data, so precise savings need a later measured comparison.

## Audit remediation boundary — 0.5.13

Account Budgets now declare an explicit unblended charge basis, and operational SNS and budget email recipients can be configured separately from SES technical notices. Optional application/stage-tag budgets require owner-approved scope and activated allocation tags. Tags cannot reconstruct all historical or untaggable charges; delayed billing feeds and unattributed spend remain necessary future reconciliation work.

Regional alarm topics and KMS keys plus additional alarms/metric filters add recurring AWS charges. Check the primary/regional inventory and your Region's prices before rollout. Separate browser concurrency and approximate queue-pressure admission bound some work; neither estimates measured physical-attempt cost nor enforces a monetary ceiling.

The architecture audit's near-live attempt ledger, billed Lambda duration/INIT/ephemeral-storage accounting, regional price catalogue, delayed actual-cost reconciliation, spend freshness/confidence, rolling 24-hour liability forecast, independent financial collectors/evaluators/actuators, durable permits, notifications and safe latched holds remain deferred. Scale's storage allocation is still unmetered. The complete backlog and owner budget/scope questions are in [the audit register](audit-change-register-2026-10-10.md).
