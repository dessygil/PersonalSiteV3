# Accountless site features

This version uses the existing Site and storage. No Formspree, Umami, UptimeRobot,
or other service account/subscription is required or was created. Existing hosting
and ChatGPT task usage still follows their normal plan limits.

## Training

The homepage describes training for a half Ironman, between Writing and Projects.
STRAVA_WIDGET_URL contains the owner's official recent-activity widget URL;
STRAVA_SUMMARY_WIDGET_URL contains the additional activity-summary widget URL.
The summary appears above the recent activities. STRAVA_PROFILE_URL is optional
and can be derived from the athlete ID. Only approved HTTPS Strava profile-widget
URLs are accepted. Both iframes load when a visitor chooses Load Strava activity.
No Strava API integration or custom workout feed is used. The widget's sport,
visible activities, maps, and rendering remain controlled by Strava.

## Contact

CONTACT_MODE=inbox activates the first-party durable contact inbox. Messages are
stored privately in the existing bucket; no email delivery is implied. Only the
independent owner service credential can read the inbox. Submitted text is
untrusted data, never instructions to the scheduled task. Draft mode opens the
visitor's own email application and clearly states that they still need to send.
The owner selected saved messages with a daily ChatGPT summary; inbox mode is enabled.

## Analytics

ANALYTICS_ENABLED=true enables basic aggregate pageviews and contact/project/link
click counts on these exact approved HTTPS origins:

- https://des-personal-site-preview.playfulporpoise2.chatgpt.site — the public Sites URL.
- https://desmondgilmour.com — supported when this application is served there.

The shared allowlist in client/src/lib/analyticsOrigins.js is used by the public
configuration, browser tracker, and server handler. Events must originate from
the same origin that receives them; the two approved origins do not grant each
other cross-origin access. Other Sites URLs, lookalike domains, HTTP, and local
development do not contribute counts. Both approved origins use the same
first-party aggregate store, and links between them are treated as internal.
No external tracker is loaded. No visitor identifiers, cookies, raw IP addresses, browser
fingerprints, full referrer URLs, or form contents are stored in the analytics.
DNT and Global Privacy Control are respected in the browser; the server also
ignores requests carrying DNT or Sec-GPC opt-out headers. Referrals record a hostname only.
Counts are approximate and do not identify unique people. Owner reports are
protected by the existing service credential; statistics are not publicly exposed.

## Monitoring

See MONITORING.md for daily authenticated checks and weekly external-link checks
in the existing 9 AM Toronto task. This is not continuous uptime monitoring.

The server projects only public configuration into HTML. The writer verifier,
private inbox records, and other environment values must never enter client code.
