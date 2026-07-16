export function usesUsageWhenEmpty(settings = {}) {
  return settings.usageWhenEmpty === true || settings.usageWhenEmpty === 'true';
}

export function shouldShowUsageWhenEmpty(session, settings = {}) {
  return !session && usesUsageWhenEmpty(settings);
}
