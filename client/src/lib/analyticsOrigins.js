// Exact origins approved for first-party aggregate analytics. This list does
// not control canonical URLs, site visibility, or owner authentication.
export const ANALYTICS_ORIGIN = "https://desmondgilmour.com";
export const ANALYTICS_ORIGINS = Object.freeze([
  ANALYTICS_ORIGIN,
  "https://des-personal-site-preview.playfulporpoise2.chatgpt.site",
]);
const internalHosts = new Set([
  ...ANALYTICS_ORIGINS.map(origin => new URL(origin).hostname),
  "www.desmondgilmour.com",
]);

export const isAnalyticsOrigin = origin => ANALYTICS_ORIGINS.includes(origin);
export const isInternalAnalyticsReferrer = hostname => internalHosts.has(hostname);
