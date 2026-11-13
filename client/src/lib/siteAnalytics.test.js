import {
  ANALYTICS_ENDPOINT, ANALYTICS_EVENTS, analyticsPath, analyticsReferrer,
  createAnalyticsController, isAnalyticsEnabled, mountAnalytics, trackAnalyticsEvent,
} from "./siteAnalytics";

jest.mock("./writingData", () => [{ slug: "test-post", tags: ["science"] }]);

const config = { analytics: { enabled: true, endpoint: ANALYTICS_ENDPOINT } };
const platformOrigin = "https://des-personal-site-preview.playfulporpoise2.chatgpt.site";
function browser(overrides = {}) {
  const document = window.document.implementation.createHTMLDocument("Analytics test");
  Object.defineProperty(document, "referrer", { value: "https://search.example/results?q=person@example.com#private" });
  return {
    document, navigator: {},
    location: { origin: "https://desmondgilmour.com", pathname: "/" },
    fetch: jest.fn(() => Promise.resolve({ ok: true })),
    ...overrides,
  };
}
const payloads = environment => environment.fetch.mock.calls.map(([, request]) => JSON.parse(request.body));
function click(environment, href, properties = {}) {
  const link = environment.document.createElement("a");
  link.href = href;
  const child = environment.document.createElement("span");
  child.textContent = "A link";
  link.appendChild(child);
  environment.document.body.appendChild(link);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...properties });
  child.dispatchEvent(event);
  return event;
}

test("analytics requires explicit same-origin enablement and respects privacy signals", () => {
  const environment = browser();
  expect(isAnalyticsEnabled(config, environment)).toBe(true);
  for (const analytics of [undefined, { enabled: false, endpoint: ANALYTICS_ENDPOINT }, { enabled: "true", endpoint: ANALYTICS_ENDPOINT }, { enabled: true, endpoint: "https://other.example/api/analytics" }, { enabled: true, endpoint: "/api/analytics?email=private" }]) {
    expect(isAnalyticsEnabled({ analytics }, environment)).toBe(false);
  }
  for (const origin of ["http://localhost:3000", "https://preview.example", "http://desmondgilmour.com", "https://www.desmondgilmour.com", "https://desmondgilmour.com.example", platformOrigin.replace("https:", "http:"), `${platformOrigin}.example`, "https://another-site.playfulporpoise2.chatgpt.site"]) {
    expect(isAnalyticsEnabled(config, browser({ location: { origin } }))).toBe(false);
  }
  for (const origin of ["https://desmondgilmour.com", platformOrigin]) {
    expect(isAnalyticsEnabled(config, browser({ location: { origin } }))).toBe(true);
    for (const navigator of [{ globalPrivacyControl: true }, { doNotTrack: "1" }, { doNotTrack: "yes" }, { msDoNotTrack: "1" }]) {
      expect(isAnalyticsEnabled(config, browser({ navigator, location: { origin } }))).toBe(false);
    }
    expect(isAnalyticsEnabled(config, browser({ doNotTrack: "1", location: { origin } }))).toBe(false);
  }
});

test("only published paths and external referrer hostnames survive normalization", () => {
  expect(analyticsPath("/writing?email=private@example.com#message")).toBe("/writing");
  expect(analyticsPath("/writing/test-post#private")).toBe("/writing/test-post");
  expect(analyticsPath("/writing/topics/science?search=private")).toBe("/writing/topics/science");
  expect(analyticsPath("/person@example.com/private")).toBe("/404");
  expect(analyticsPath("/api/contact")).toBe("/404");
  expect(analyticsReferrer("https://search.example/results?q=person@example.com#private")).toBe("search.example");
  for (const value of [null, "", "invalid", "https://desmondgilmour.com/writing", "https://www.desmondgilmour.com/", `${platformOrigin}/writing?private=1`, "https://user:password@example.com/", "http://127.0.0.1/private", "http://[::1]/", "data:text/plain,private"]) {
    expect(analyticsReferrer(value)).toBeNull();
  }
});

test("public Sites origin uses cookie-free relative analytics and honors later privacy changes", () => {
  const environment = browser({ location: { origin: platformOrigin, pathname: "/" } });
  const session = mountAnalytics(config, environment);
  session.page("/");
  expect(payloads(environment)).toEqual([{ event: "pageview", path: "/", referrer: "search.example" }]);
  expect(environment.fetch.mock.calls[0][0]).toBe("/api/analytics");
  expect(environment.fetch.mock.calls[0][1]).toMatchObject({ mode: "same-origin", credentials: "omit", referrerPolicy: "no-referrer" });
  environment.navigator.globalPrivacyControl = true;
  session.page("/writing");
  click(environment, "mailto:private@example.com");
  expect(environment.fetch).toHaveBeenCalledTimes(1);
  session.release();
});

test("SPA pageviews deduplicate query changes and StrictMode remounts but count return visits", () => {
  const environment = browser();
  const controller = createAnalyticsController(environment);
  const first = controller.acquire(config);
  first.page("/");
  first.release();
  const second = controller.acquire(config);
  second.page("/");
  second.page("/?search=private#contact");
  second.page("/writing");
  second.page("/writing?search=private#article");
  second.page("/writing/test-post");
  second.page("/writing");
  expect(payloads(environment).map(payload => payload.path)).toEqual(["/", "/writing", "/writing/test-post", "/writing"]);
  expect(payloads(environment).every(payload => payload.event === "pageview")).toBe(true);
  second.release();
  second.page("/");
  expect(controller.track(ANALYTICS_EVENTS.contactSuccess)).toBe(false);
  expect(environment.fetch).toHaveBeenCalledTimes(4);
});

test("events send only fixed aggregate fields without cookies or HTTP referrers", () => {
  const environment = browser({ location: { origin: "https://desmondgilmour.com", pathname: "/writing?email=private@example.com#message" } });
  const session = mountAnalytics(config, environment);
  expect(trackAnalyticsEvent(ANALYTICS_EVENTS.contactSuccess, environment)).toBe(true);
  expect(trackAnalyticsEvent("private@example.com", environment)).toBe(false);
  expect(payloads(environment)).toEqual([{ event: "contact_submitted", path: "/writing", referrer: "search.example" }]);
  const [endpoint, request] = environment.fetch.mock.calls[0];
  expect(endpoint).toBe("/api/analytics");
  expect(request).toMatchObject({ method: "POST", mode: "same-origin", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", keepalive: true });
  expect(request.body).not.toMatch(/private|email|message|query|title|user|screen/i);
  expect(environment.document.querySelector("script")).toBeNull();
  session.release();
});

test("delegated outbound clicks emit one fixed event and never cancel navigation", () => {
  const environment = browser();
  const controller = createAnalyticsController(environment);
  const first = controller.acquire(config);
  const second = controller.acquire(config);
  for (const href of ["mailto:private@example.com?subject=secret", "https://github.com/dessygil/des-personal-site?private=1", "https://www.linkedin.com/in/desmondgilmour?private=1"]) {
    expect(click(environment, href).defaultPrevented).toBe(false);
  }
  click(environment, "https://github.com/dessygil");
  click(environment, "https://github.com.example/dessygil/repository");
  click(environment, "/writing");
  expect(payloads(environment).map(payload => payload.event)).toEqual(["email_click", "github_click", "linkedin_click"]);
  expect(JSON.stringify(payloads(environment))).not.toMatch(/private|subject|secret|dessygil/);
  first.release();
  second.release();
  click(environment, "mailto:private@example.com");
  expect(environment.fetch).toHaveBeenCalledTimes(3);
});

test("disabled previews, newly enabled privacy signals, and form inputs never produce events", () => {
  const preview = browser({ location: { origin: "https://preview.example", pathname: "/" } });
  const previewSession = mountAnalytics(config, preview);
  previewSession.page("/");
  click(preview, "mailto:private@example.com");
  expect(preview.fetch).not.toHaveBeenCalled();
  const environment = browser();
  const controller = createAnalyticsController(environment);
  const session = controller.acquire(config);
  environment.document.body.innerHTML = '<form><input name="email" value="private@example.com"><textarea>Secret message</textarea></form>';
  environment.document.querySelector("input").dispatchEvent(new Event("input", { bubbles: true }));
  environment.document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true }));
  expect(environment.fetch).not.toHaveBeenCalled();
  environment.navigator.globalPrivacyControl = true;
  session.page("/writing");
  controller.track(ANALYTICS_EVENTS.contactSuccess);
  click(environment, "mailto:private@example.com");
  expect(environment.fetch).not.toHaveBeenCalled();
  session.release();
});

test("blocked analytics requests do not throw or retry", async () => {
  const environment = browser({ fetch: jest.fn(() => Promise.reject(new Error("Offline"))) });
  const session = mountAnalytics(config, environment);
  expect(() => session.page("/")).not.toThrow();
  await Promise.resolve();
  expect(environment.fetch).toHaveBeenCalledTimes(1);
  environment.fetch.mockImplementation(() => { throw new Error("Blocked"); });
  expect(() => session.page("/writing")).not.toThrow();
  expect(environment.fetch).toHaveBeenCalledTimes(2);
  session.release();
});
