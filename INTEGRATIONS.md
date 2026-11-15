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

## Article reactions and sharing

Each full article offers a Helpful button with undo, Copy link, LinkedIn sharing,
and the browser's native share sheet when supported. Sharing always uses the
website article URL. Ask me about this article opens the existing contact form
with a known article's title and URL; visitors still review and send their message.

Reactions use a random browser-local identifier, hashed per article on the server,
conditional storage writes, and hashed-IP rate limits. No raw IP is retained.
This is basic repeat protection: clearing browser storage or using another device
can allow another mark. Helpful counts are website-only and are not unique readers.
This identifier is separate from aggregate, identifier-free traffic analytics.
Keep `REACTION_HMAC_SECRET` as a stable 64-hex-character native runtime secret,
independent of the rotating writer service credential. Changing the reaction
secret requires a voter-identity migration; do not rotate it as routine maintenance.

## Private writing dashboard

Visit `/dashboard/writing` and sign in with the site owner's existing ChatGPT
account. Sites supplies authenticated identity headers. Every dashboard API
checks a signed-in ID plus the configured `WRITING_OWNER_EMAIL` server-side,
or the existing independently verified service bearer. Other signed-in visitors
cannot access the statistics. The dashboard shell contains no private data and
is excluded from indexing and public traffic collection. The contact inbox keeps
its separate service-only authorization.

Set `WRITING_OWNER_EMAIL` as a native Sites runtime secret using the verified site
owner's account email, never a public environment variable or client constant.
Optionally set `DEVTO_ANALYTICS_API_KEY` as a runtime secret. Without it, the owner
can enter a DEV.to key in the private import form for that request only; it is not
saved, logged, or placed in a URL. Do not paste credentials into chat or source.
The import verifies the DEV.to account is `dessygil`, fetches owned published
articles, and stores validated counts without saving the key.

Substack and Medium statistics can be entered manually or in the dashboard's CSV
template. These are cumulative per-article view snapshots, not monthly increments.
Match each external article to its local article and supply the observation date.
An updated snapshot replaces the earlier one; importing twice must not add it twice.
One external article URL can map to only one local article within each platform.
Substack offers a post-statistics CSV in Analytics → Stats → Posts; adapt its columns
to the dashboard template after reviewing them. Medium has no supported analytics
API or documented story-view CSV export, so copy its reported counts into the form
or template. No unsupported scraping or session-cookie access is used.

The combined total is **reported views from available sources**, not unique people.
Website totals cover records collected by this application; they do not backfill
old Netlify visits. External columns use latest imported cumulative counts and
show their observation dates; missing sources remain blank rather than zero.
The date-range report covers website article views only. Choose the last 7, 30,
or 90 days, all recorded history, or an inclusive custom range. Dates use
America/Toronto, including daylight-saving changes; today is a partial day.
The per-article table uses the selected period, and the chart can show all
articles or one article. Dates before the first saved analytics record are
unavailable, not zero; later days without events show zero recorded views.
Lifetime platform totals and helpful marks remain separate from period views.

The private GET `/api/private/writing-dashboard` accepts `range=7d|30d|90d|all|custom`
(default `30d`), `from` and `to` for a custom range, and an optional known `article`
slug for the chart. Custom ranges must contain at most 3,660 calendar days and
cannot end in the future. Existing lifetime response fields and the `daily`
30-day series remain compatible with scheduled readers; `period` and each
article's `periodWebsiteViews` supply the new report. No extra visitor identifiers
or analytics service are needed.

External imports currently retain only the latest cumulative snapshot, so they
cannot reconstruct historical date ranges. Substack counts web/email/app
views; Medium uses its own time thresholds and daily deduplication. No automatic
Substack/Medium sync is implied. The existing DEV.to content sync remains separate
from owner-only view statistics.
