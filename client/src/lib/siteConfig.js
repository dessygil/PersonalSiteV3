export function validStravaWidget(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.strava.com" && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/athletes\/\d+\/(latest-rides|activity-summary)\/[A-Za-z0-9_-]+$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}
export function validStravaProfile(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.strava.com" && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/athletes\/\d+\/?$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}
export function normalizeSiteConfig(value = {}) {
  return {
    contact: { endpoint: value?.contact?.endpoint === "/api/contact" ? "/api/contact" : null },
    strava: { widgetUrl: validStravaWidget(value?.strava?.widgetUrl), summaryWidgetUrl: validStravaWidget(value?.strava?.summaryWidgetUrl), profileUrl: validStravaProfile(value?.strava?.profileUrl) },
    analytics: { enabled: value?.analytics?.enabled === true, endpoint: "/api/analytics" },
  };
}
export function getSiteConfig() {
  return normalizeSiteConfig(typeof window === "undefined" ? {} : window.__SITE_CONFIG__);
}
