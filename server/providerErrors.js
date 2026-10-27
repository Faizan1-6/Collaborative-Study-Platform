export function classifyProviderError(provider, error) {
  const status = Number(error?.status);
  const message = [
    error?.error?.message,
    error?.error?.type,
    error?.error?.code,
    error?.message,
  ].filter((part) => typeof part === 'string').join(' ').toLowerCase();

  if (status === 429) {
    if (/insufficient_quota|billing|payment|credits|plan restriction|upgrade (?:your )?(?:plan|account)|current quota|quota (?:has been )?(?:exhausted|depleted|exceeded)|(?:daily|monthly|billing period) (?:usage )?limit/i.test(message)) {
      return {
        status: 429,
        error: `${provider} account quota or plan limit reached. Check the provider account's usage and billing settings.`,
      };
    }
    if (/output tokens per minute|requested \d+.*tokens|tokens per minute/i.test(message)) {
      return {
        status: 429,
        error: `${provider} output token rate limit reached. The request has been capped; wait for the provider limit to reset and try again.`,
      };
    }
    return { status: 429, error: `${provider} is rate limited. Wait a moment and try again.` };
  }
  if (status === 401 || status === 403) {
    return { status: 502, error: `${provider} rejected the server credentials. Check the configured API key and permissions.` };
  }
  if (status === 400) {
    return { status: 502, error: `${provider} could not process the request. Check provider access and model availability.` };
  }
  if (status === 404) {
    return { status: 502, error: `${provider} could not find the configured model. Check the model ID and account availability.` };
  }
  if (status === 503) {
    return { status: 503, error: `${provider} is temporarily at capacity. Please try again shortly.` };
  }
  return { status: 502, error: `${provider} is temporarily unavailable. Check the server logs and try again.` };
}
