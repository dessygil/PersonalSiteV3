import { normalizeSiteConfig, validStravaWidget } from '../client/src/lib/siteConfig.js';
import { isAnalyticsOrigin } from '../client/src/lib/analyticsOrigins.js';
export function publicSiteConfig(env = {}, origin = '') {
  const widgetUrl = validStravaWidget(env.STRAVA_WIDGET_URL);
  const summaryWidgetUrl = validStravaWidget(env.STRAVA_SUMMARY_WIDGET_URL);
  const athlete = (widgetUrl || summaryWidgetUrl)?.match(/\/athletes\/(\d+)\//)?.[1];
  return normalizeSiteConfig({
    contact: { endpoint: env.CONTACT_MODE === 'inbox' && env.BUCKET ? '/api/contact' : null },
    strava: { widgetUrl, summaryWidgetUrl, profileUrl: env.STRAVA_PROFILE_URL || (athlete ? `https://www.strava.com/athletes/${athlete}` : null) },
    analytics: { enabled: env.ANALYTICS_ENABLED === 'true' && isAnalyticsOrigin(origin) },
  });
}
