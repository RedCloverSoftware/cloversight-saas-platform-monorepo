#!/usr/bin/env bash
# Exercise Chromium in the actual Lambda-format worker without AWS credentials.
set -euo pipefail

node scripts/worker-base.mjs
image=cloversight-worker:ci

docker buildx build --progress=plain --platform linux/amd64 \
  --provenance=false --sbom=false --load \
  --build-arg WEBWATCH_REQUIRE_DEPENDENCY_LOCKS=1 \
  --build-arg WEBWATCH_CAPTURE_RELEASE=ci \
  --build-arg WEBWATCH_CAPTURE_SOURCE_SHA256=ci \
  --file infra/docker/browser-worker/Dockerfile --tag "$image" .

docker image inspect --format 'Local worker image: {{.Id}} ({{.Os}}/{{.Architecture}})' "$image"

# The direct Node entrypoint needs the Lambda runtime identifiers to load Chromium libraries.
docker run --rm -i --pull=never --platform linux/amd64 --network none \
  --env AWS_EXECUTION_ENV=AWS_Lambda_nodejs22.x \
  --env AWS_LAMBDA_FUNCTION_NAME=cloversight-worker-ci \
  --entrypoint node "$image" --input-type=module - <<'JS'
import serverless from '@sparticuz/chromium';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: await serverless.executablePath(),
  args: serverless.args
});
try {
  const page = await browser.newPage();
  await page.setContent('<h1>Cloversight capture fixture</h1>');
  if (await page.locator('h1').textContent() !== 'Cloversight capture fixture') throw new Error('DOM capture failed.');
  if ((await page.screenshot()).length < 100) throw new Error('Screenshot capture failed.');
} finally {
  await browser.close();
}
JS

echo 'Worker smoke test passed'
