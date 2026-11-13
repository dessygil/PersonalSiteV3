import articles from "./writingData";
import { getWritingTopics } from "./writingTopics";
import { ANALYTICS_ORIGIN, isAnalyticsOrigin, isInternalAnalyticsReferrer } from "./analyticsOrigins";

export { ANALYTICS_ORIGIN };
export const ANALYTICS_ENDPOINT = "/api/analytics";
export const ANALYTICS_EVENTS = Object.freeze({
  contactSuccess: "contact_submitted",
  emailClick: "email_click",
  githubClick: "github_click",
  linkedinClick: "linkedin_click",
});
const customEvents = new Set(Object.values(ANALYTICS_EVENTS));
const controllers = new WeakMap();
const routes = new Set([
  "/", "/writing",
  ...articles.map(article => `/writing/${article.slug}`),
  ...getWritingTopics(articles).map(topic => `/writing/topics/${topic.slug}`),
]);

function privacyOptOut(browser) {
  const navigator = browser?.navigator || {};
  const optedOut = value => value === true || /^(1|yes)$/i.test(String(value));
  return navigator.globalPrivacyControl === true || [navigator.doNotTrack, navigator.msDoNotTrack, browser?.doNotTrack].some(optedOut);
}

export function isAnalyticsEnabled(config, browser) {
  return Boolean(config?.analytics?.enabled === true
    && config.analytics.endpoint === ANALYTICS_ENDPOINT
    && isAnalyticsOrigin(browser?.location?.origin)
    && !privacyOptOut(browser));
}

export function analyticsPath(pathname) {
  // Unknown paths may contain personal information. Only published paths are
  // recorded; other paths share a generic label without query or hash values.
  const path = typeof pathname === "string" ? pathname.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/" : "/404";
  return routes.has(path) ? path : "/404";
}

export function analyticsReferrer(referrer) {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || isInternalAnalyticsReferrer(hostname)
      || !/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(hostname) || /^\d+(\.\d+){3}$/.test(hostname)) return null;
    return hostname;
  } catch { return null; }
}

export function linkAnalyticsEvent(anchor) {
  const href = anchor?.getAttribute?.("href");
  if (!href) return null;
  if (/^mailto:/i.test(href)) return ANALYTICS_EVENTS.emailClick;
  try {
    const url = new URL(href, ANALYTICS_ORIGIN);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (["linkedin.com", "www.linkedin.com"].includes(url.hostname)) return ANALYTICS_EVENTS.linkedinClick;
    if (url.hostname === "github.com" && url.pathname.split("/").filter(Boolean).length >= 2) return ANALYTICS_EVENTS.githubClick;
  } catch { /* Invalid links have no analytics event. */ }
  return null;
}

export function createAnalyticsController(browser) {
  const document = browser.document;
  let settings;
  let consumers = 0;
  let lastPage = null;
  const allowed = () => consumers > 0 && isAnalyticsEnabled({ analytics: settings }, browser);

  function send(event, path) {
    if (!allowed() || typeof browser.fetch !== "function") return false;
    if (typeof path === "string" && /^\/dashboard(?:\/|$)/.test(path)) return false;
    const payload = { event, path: analyticsPath(path), referrer: analyticsReferrer(document.referrer) };
    try {
      const response = browser.fetch(ANALYTICS_ENDPOINT, {
        method: "POST",
        mode: "same-origin",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (typeof response?.catch === "function") response.catch(() => {});
      return true;
    } catch { return false; }
  }

  function track(event) {
    return customEvents.has(event) ? send(event, browser.location.pathname) : false;
  }

  function onClick(event) {
    if (event.defaultPrevented || (event.button !== undefined && event.button !== 0)) return;
    const element = event.target?.closest ? event.target : event.target?.parentElement;
    const name = linkAnalyticsEvent(element?.closest?.("a[href]"));
    if (name) track(name);
    // Never delay or cancel navigation, or inspect form controls.
  }

  return {
    acquire(config) {
      if (!isAnalyticsEnabled(config, browser)) return { page() {}, release() {} };
      settings = { ...config.analytics };
      consumers += 1;
      if (consumers === 1) document.addEventListener("click", onClick);
      let released = false;
      return {
        page(pathname) {
          if (released || !allowed()) return;
          if (typeof pathname === "string" && /^\/dashboard(?:\/|$)/.test(pathname)) return;
          const path = analyticsPath(pathname);
          if (path !== lastPage && send("pageview", path)) lastPage = path;
        },
        release() {
          if (released) return;
          released = true;
          consumers -= 1;
          if (!consumers) document.removeEventListener("click", onClick);
          // Retain only the last route in memory so React StrictMode remounts
          // cannot count the same page twice. No browser storage or visitor ID.
        },
      };
    },
    track,
  };
}

export function mountAnalytics(config, browser = typeof window === "undefined" ? null : window) {
  if (!browser?.document) return { page() {}, release() {} };
  let controller = controllers.get(browser);
  if (!controller) { controller = createAnalyticsController(browser); controllers.set(browser, controller); }
  return controller.acquire(config);
}

export function trackAnalyticsEvent(event, browser = typeof window === "undefined" ? null : window) {
  return browser ? controllers.get(browser)?.track(event) || false : false;
}

export function trackContactSuccess() {
  return trackAnalyticsEvent(ANALYTICS_EVENTS.contactSuccess);
}
