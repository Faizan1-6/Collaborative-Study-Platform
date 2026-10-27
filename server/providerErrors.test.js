import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError } from './providerErrors.js';

test('distinguishes exhausted account quota from request rate limiting', () => {
  const quota = classifyProviderError('Groq', {
    status: 429,
    error: { code: 'insufficient_quota', message: 'You exceeded your current quota.' },
  });
  const rateLimit = classifyProviderError('Groq', {
    status: 429,
    error: { code: 'rate_limit_exceeded', message: 'Requests per minute limit reached.' },
  });

  assert.match(quota.error, /quota or plan limit/i);
  assert.match(rateLimit.error, /rate limited/i);
});

test('explains output-token rate limits without retrying', () => {
  const result = classifyProviderError('Groq', {
    status: 429,
    error: { message: 'Limit reached for output tokens per minute.' },
  });

  assert.match(result.error, /output token rate limit/i);
});

test('reports provider capacity, credentials, and model failures clearly', () => {
  assert.match(classifyProviderError('Gemini', { status: 503 }).error, /temporarily at capacity/i);
  assert.match(classifyProviderError('Gemini', { status: 401 }).error, /server credentials/i);
  assert.match(classifyProviderError('Groq', { status: 404 }).error, /configured model/i);
});
