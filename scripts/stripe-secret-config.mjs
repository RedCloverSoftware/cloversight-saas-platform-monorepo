import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLANS } from '../src/domain/plans.mjs';

// Deployment stage controls AWS isolation; Stripe mode independently controls
// the provider environment. Production retains live billing by default.
export function stripeSecretConfig(env = process.env) {
  const stage = env.STAGE || 'staging';
  if (!['staging', 'beta', 'prod'].includes(stage)) throw new Error('Stripe deployment requires STAGE=staging, beta or prod.');
  const mode = env.STRIPE_MODE || (stage === 'prod' ? 'live' : 'test');
  if (!['test', 'live'].includes(mode)) throw new Error('STRIPE_MODE must be test or live (or blank for the stage default).');
  if (stage !== 'prod' && mode !== 'test') throw new Error('Staging and beta require STRIPE_MODE=test.');
  const secretKey = env.STRIPE_SECRET_KEY || '';
  const prefixes = [`rk_${mode}_`, `sk_${mode}_`];
  if (!prefixes.some(prefix => secretKey.startsWith(prefix) && secretKey.length > prefix.length)) {
    throw new Error(`STRIPE_SECRET_KEY must be a restricted (rk_${mode}_) or standard (sk_${mode}_) server key for the selected mode. To test a production AWS deployment, explicitly set STRIPE_MODE=test.`);
  }
  if (!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_') || env.STRIPE_WEBHOOK_SECRET.length <= 6) throw new Error('Configure STRIPE_WEBHOOK_SECRET from the endpoint in the selected Stripe environment.');
  const priceIds = {};
  for (const tier of Object.keys(PLANS)) {
    const name = `STRIPE_PRICE_${tier.toUpperCase()}`;
    if (!env[name]?.startsWith('price_') || env[name].length <= 6) throw new Error(`Configure ${name} with a Stripe Price ID.`);
    priceIds[tier] = env[name];
  }
  return { mode, secretKey, webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    apiVersion: env.STRIPE_API_VERSION || '2025-06-30.basil', priceIds };
}

export async function verifyStripeCatalog(config, fetchImpl = fetch) {
  // Read-only provider checks. Never print credentials or provider error bodies.
  await Promise.all(Object.entries(config.priceIds).map(async ([tier, id]) => {
    let response;
    try {
      response = await fetchImpl(`https://api.stripe.com/v1/prices/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.secretKey}`, 'Stripe-Version': config.apiVersion },
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new Error(`Could not verify the ${tier} Stripe Price. Check connectivity and retry; no secret was uploaded.`); }
    if (!response.ok) throw new Error(`Stripe rejected the ${tier} Price lookup (HTTP ${response.status}). Check key permissions and that all Price IDs belong to the same Stripe environment. No secret was uploaded.`);
    let price;
    try { price = await response.json(); }
    catch { throw new Error(`Stripe returned invalid JSON for the ${tier} Price. No secret was uploaded.`); }
    const expected = PLANS[tier];
    if (price.id !== id || price.livemode !== (config.mode === 'live') || price.active !== true ||
        price.type !== 'recurring' || price.billing_scheme !== 'per_unit' || price.transform_quantity != null || price.custom_unit_amount != null ||
        price.unit_amount !== expected.priceMinor || price.currency !== expected.currency.toLowerCase() ||
        price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1 || price.recurring?.usage_type !== 'licensed') {
      throw new Error(`The ${tier} Price must be active, ${config.mode}-mode, fixed-price monthly USD billing at ${expected.priceMinor} cents, with interval_count=1 and licensed usage. No secret was uploaded.`);
    }
  }));
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const [command, output] = process.argv.slice(2);
    if (!['validate', 'prepare'].includes(command) || (command === 'prepare' && !output)) throw new Error('Usage: stripe-secret-config.mjs validate | prepare OUTPUT_FILE');
    const config = stripeSecretConfig();
    if (command === 'prepare') {
      await verifyStripeCatalog(config);
      fs.writeFileSync(output, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    }
    console.log(`Stripe ${config.mode.toUpperCase()} mode selected for AWS stage ${process.env.STAGE || 'staging'}${command === 'prepare' ? '; all six monthly Prices verified' : ''}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
