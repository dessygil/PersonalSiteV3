import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSiteConfig } from '../server/runtimeConfig.mjs';
import { normalizeSiteConfig } from '../client/src/lib/siteConfig.js';
const widget = 'https://www.strava.com/athletes/123/latest-rides/example-widget';
const summaryWidget = 'https://www.strava.com/athletes/123/activity-summary/example-widget';
test('public config includes only validated widget and feature settings, never server secrets', () => {
 const value = publicSiteConfig({ STRAVA_WIDGET_URL: widget, STRAVA_SUMMARY_WIDGET_URL: summaryWidget, CONTACT_MODE: 'inbox', BUCKET: {}, ANALYTICS_ENABLED: 'true', WRITING_SERVICE_TOKEN_SHA256: 'never-expose-this' }, 'https://desmondgilmour.com');
 assert.equal(value.strava.widgetUrl, widget); assert.equal(value.strava.profileUrl, 'https://www.strava.com/athletes/123');
 assert.equal(value.strava.summaryWidgetUrl, summaryWidget);
 assert.equal(publicSiteConfig({ STRAVA_SUMMARY_WIDGET_URL: summaryWidget }).strava.profileUrl, 'https://www.strava.com/athletes/123');
 assert.equal(value.contact.endpoint, '/api/contact'); assert.equal(value.analytics.enabled, true);
 assert.ok(!JSON.stringify(value).includes('never-expose-this'));
});
test('analytics enables only the four approved HTTPS origins with the explicit flag', () => {
 for (const origin of ['https://desmondgilmour.ca', 'https://www.desmondgilmour.ca', 'https://desmondgilmour.com', 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site']) {
  assert.equal(publicSiteConfig({ ANALYTICS_ENABLED: 'true' }, origin).analytics.enabled, true);
  for (const flag of [undefined, 'false', true, 'TRUE']) assert.equal(publicSiteConfig({ ANALYTICS_ENABLED: flag }, origin).analytics.enabled, false);
 }
});
test('analytics stays off on other Sites, local, lookalike and non-HTTPS origins', () => {
 for (const origin of ['https://another-site.playfulporpoise2.chatgpt.site', 'https://des-personal-site-preview.other-workspace.chatgpt.site', 'http://localhost:3000', 'http://desmondgilmour.ca', 'http://www.desmondgilmour.ca', 'https://desmondgilmour.ca.evil.test', 'https://www.desmondgilmour.ca.evil.test', 'https://desmondgilmour.ca:8443', 'https://www.desmondgilmour.ca:8443', 'http://desmondgilmour.com', 'http://des-personal-site-preview.playfulporpoise2.chatgpt.site', 'https://desmondgilmour.com.evil.test', 'https://des-personal-site-preview.playfulporpoise2.chatgpt.site.evil.test', 'https://www.desmondgilmour.com']) assert.equal(publicSiteConfig({ ANALYTICS_ENABLED: 'true' }, origin).analytics.enabled, false);
});
test('unsafe service settings cannot create arbitrary embeds or form destinations', () => {
 for (const widgetUrl of ['javascript:alert(1)', 'https://www.strava.com.evil.test/athletes/123/latest-rides/x', 'https://www.strava.com/athletes/123/latest-rides/x?redirect=evil', 'https://user:password@www.strava.com/athletes/123/latest-rides/x']) assert.equal(normalizeSiteConfig({ strava: { widgetUrl } }).strava.widgetUrl, null);
 assert.equal(normalizeSiteConfig({ contact: { endpoint: 'https://evil.test' } }).contact.endpoint, null);
 assert.equal(publicSiteConfig({ CONTACT_MODE: 'inbox' }).contact.endpoint, null);
 assert.equal(normalizeSiteConfig({ strava: { summaryWidgetUrl: 'https://www.strava.com.evil.test/athletes/123/activity-summary/x' } }).strava.summaryWidgetUrl, null);
});
