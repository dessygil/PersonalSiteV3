import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import usePageNavigation from "../../lib/usePageNavigation";
import "./writing-dashboard.css";

const SIGN_IN_URL = "/signin-with-chatgpt?return_to=%2Fdashboard%2Fwriting";
const PLATFORMS = ["devto", "substack", "medium"];
const PLATFORM_LABELS = { devto: "DEV.to", substack: "Substack", medium: "Medium" };
const number = new Intl.NumberFormat("en-CA");
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const count = value => validCount(value) ? number.format(value) : "—";

function dateLabel(value, timeZone = "America/Toronto") {
  if (!value) return "Not available";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? "Not available" : date.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone });
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

// Supports quoted fields, doubled quotes, CRLF and line breaks inside quoted fields.
export function parseWritingStatsCsv(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Choose a CSV file containing article statistics.");
  if (input.length > 256000) throw new Error("Use a CSV file smaller than 256 KB.");
  const text = input.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"') {
      if (field || closed) throw new Error("The CSV contains a misplaced quote.");
      quoted = true;
    } else if (char === ",") {
      row.push(field); field = ""; closed = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); rows.push(row); row = []; field = ""; closed = false;
    } else {
      if (closed) {
        if (char === " " || char === "\t") continue;
        throw new Error("A quoted CSV field must be followed by a comma or a new line.");
      }
      field += char;
    }
  }
  if (quoted) throw new Error("The CSV contains an unfinished quoted field.");
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  const populated = rows.filter(cells => cells.some(cell => cell.trim()));
  const headers = (populated.shift() || []).map(value => value.trim().toLowerCase());
  if (headers.length !== 3 || new Set(headers).size !== 3 || !["slug", "url", "views"].every(header => headers.includes(header))) {
    throw new Error("The CSV header must contain exactly slug,url,views.");
  }
  if (!populated.length) throw new Error("The CSV needs at least one article row.");
  if (populated.length > 500) throw new Error("Import at most 500 article rows at a time.");
  const seen = new Set();
  return populated.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`CSV row ${index + 2} does not match the header.`);
    const record = Object.fromEntries(headers.map((header, i) => [header, cells[i].trim()]));
    if (!record.slug || seen.has(record.slug)) throw new Error(`CSV row ${index + 2} needs a distinct article slug.`);
    if (!safeUrl(record.url)) throw new Error(`CSV row ${index + 2} needs a valid HTTPS article URL.`);
    if (!/^\d+$/.test(record.views) || !validCount(Number(record.views))) throw new Error(`CSV row ${index + 2} needs a non-negative whole number of views.`);
    seen.add(record.slug);
    return { slug: record.slug, url: record.url, views: Number(record.views) };
  });
}

class DashboardError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

function devtoImportError(error) {
  const messages = {
    devto_key_required: "Enter an API key from your existing DEV.to account, dessygil, to import its private view counts. Copy the generated key value, not its label.",
    devto_invalid_key: "This API key is invalid or was not accepted by DEV.to. Copy the generated key value from the dessygil account in DEV.to settings, then try again.",
    devto_account_mismatch: "This key belongs to a different DEV.to account. Use an API key from dessygil to import this website’s articles.",
    devto_connection_failed: "Website could not connect to DEV.to. This does not mean your API key is wrong. The import was not confirmed; try again later.",
    devto_blocked: "Website could not connect to DEV.to. This does not mean your API key is wrong. DEV.to blocked the request; the import was not confirmed.",
    devto_rate_limited: "DEV.to is limiting requests. The import was not confirmed. Wait a few minutes, then try again.",
    devto_unavailable: "DEV.to returned an error, so the import could not be confirmed. Try again later.",
    devto_invalid_response: "DEV.to returned data this website could not use. The import was not confirmed. Try again later.",
    devto_no_matching_articles: "No DEV.to articles matched this website’s writing archive. Check that the archive’s source URLs refer to published articles on dessygil’s DEV.to account.",
    devto_import_conflict: "A newer snapshot is already saved for an article. Refresh the dashboard before importing again.",
    devto_storage_unavailable: "Statistics storage is unavailable, so the import could not be confirmed. Refresh the dashboard and try again later.",
    request_timeout: "The import request timed out, so completion could not be confirmed. Refresh the dashboard to check for an update before trying again.",
  };
  let text = Object.prototype.hasOwnProperty.call(messages, error.code) ? messages[error.code] : undefined;
  if (!text && error instanceof TypeError) text = "The import request could not reach the website. Completion could not be confirmed. Check your connection and refresh the dashboard before trying again.";
  return {
    type: "error",
    needsKey: ["devto_key_required", "devto_invalid_key", "devto_account_mismatch"].includes(error.code),
    text: `${text || "The DEV.to import could not be confirmed. Refresh the dashboard to check for an update before trying again."} The key has been cleared.`,
  };
}

function ExternalViews({ source, platform }) {
  if (!source || !validCount(source.views)) return <span className="dashboard-not-added">Not added</span>;
  const url = safeUrl(source.url);
  return <><strong>{count(source.views)}</strong><small>As of {dateLabel(source.asOf, "UTC")}</small>{url && <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open article on ${PLATFORM_LABELS[platform]}`}>Source ↗</a>}</>;
}

const RANGE_LABELS = { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", all: "All recorded time", custom: "Custom dates" };
const DEFAULT_FILTERS = { range: "30d", article: "" };
const periodDates = period => `${dateLabel(period.from)} – ${dateLabel(period.to)}`;
const hasRecordedDays = period => period.daily.some(day => validCount(day.views));

function reportUrl(filters) {
  const params = new URLSearchParams({ range: filters.range });
  if (filters.range === "custom") { params.set("from", filters.from); params.set("to", filters.to); }
  if (filters.article) params.set("article", filters.article);
  return `/api/private/writing-dashboard?${params}`;
}

function filtersFromPeriod(period) {
  return { range: period.range, ...(period.range === "custom" ? { from: period.from, to: period.to } : {}), article: period.selectedArticle || "" };
}

export function periodChartBuckets(daily) {
  const size = Math.max(1, Math.ceil(daily.length / 60));
  const buckets = [];
  for (let index = 0; index < daily.length; index += size) {
    const days = daily.slice(index, index + size);
    const recorded = days.filter(day => validCount(day.views));
    buckets.push({ from: days[0].day, to: days[days.length - 1].day, views: recorded.length ? recorded.reduce((sum, day) => sum + day.views, 0) : null, unavailableDays: days.length - recorded.length });
  }
  return { size, buckets };
}

function DailyViews({ period, articles, chartArticle, onArticleChange, disabled }) {
  const { size, buckets } = periodChartBuckets(period.daily);
  const maximum = Math.max(1, ...buckets.map(bucket => bucket.views || 0));
  const selected = articles.find(article => article.slug === period.selectedArticle);
  const available = hasRecordedDays(period);
  const scope = selected ? selected.title : "All articles";
  return <section className="dashboard-panel" aria-labelledby="daily-views-heading">
    <div className="dashboard-section-heading"><div><p className="eyebrow">SELECTED PERIOD / WEBSITE ONLY</p><h2 id="daily-views-heading">Daily website views</h2></div><p>{available ? `${count(period.selectedArticleViews)} recorded article views` : "No recorded data in this period"}</p></div>
    <label className="dashboard-chart-selector">Article for daily chart<select value={chartArticle} onChange={event => onArticleChange(event.target.value)} disabled={disabled}><option value="">All articles</option>{articles.map(article => <option key={article.slug} value={article.slug}>{article.title}</option>)}</select></label>
    <p className="dashboard-chart-scope"><strong>{scope}</strong> · {periodDates(period)}</p>
    <p className="dashboard-note">The article selector changes this chart only. The article table and period total still cover all articles. Dates use Toronto time; external platform snapshots are not included.</p>
    {buckets.length ? <><div className="dashboard-chart" role="img" aria-label={`${size > 1 ? "Grouped" : "Daily"} website article views for ${scope}: ${available ? `${count(period.selectedArticleViews)} recorded in this period` : "no recorded data in this period"}. Exact values are available in the daily numbers table below.`}>
      <div className="dashboard-bars" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))` }}>
        {buckets.map(bucket => <div className="dashboard-bar-track" key={bucket.from} title={`${dateLabel(bucket.from)}${bucket.to !== bucket.from ? `–${dateLabel(bucket.to)}` : ""}: ${bucket.views === null ? "Unavailable" : `${count(bucket.views)} recorded views`}${bucket.unavailableDays ? `; ${bucket.unavailableDays} unavailable ${bucket.unavailableDays === 1 ? "day" : "days"}` : ""}`}><span className={`dashboard-bar${bucket.views === null ? " is-unavailable" : bucket.views === 0 ? " is-zero" : ""}${bucket.views !== null && bucket.unavailableDays ? " has-unavailable-days" : ""}`} style={{ height: `${bucket.views === null ? 100 : Math.max(1, bucket.views / maximum * 100)}%` }} /></div>)}
      </div><div className="dashboard-chart-axis" aria-hidden="true"><span>{dateLabel(period.from)}</span><span>{dateLabel(period.to)}</span></div>
    </div>{size > 1 && <p className="dashboard-note">Bars group up to {size} consecutive days to keep this longer period readable. The table below contains every date.</p>}{period.includesUnrecordedDays && <p className="dashboard-note">Striped bars include dates before tracking began. Unavailable dates are not treated as zero.</p>}
    <details className="dashboard-daily-details"><summary>View exact daily numbers</summary><div className="dashboard-table-scroll"><table className="dashboard-table"><caption>Website article views by day — {scope} — {periodDates(period)}</caption><thead><tr><th scope="col">Date (Toronto)</th><th scope="col">Views</th><th scope="col">Coverage</th></tr></thead><tbody>{period.daily.map(day => <tr key={day.day}><th scope="row">{dateLabel(day.day)}</th><td>{day.views === null ? "Unavailable" : count(day.views)}</td><td>{day.views === null ? (period.websiteSince ? "Before tracking began" : "No recorded history") : day.day === period.today ? "Today · partial day" : "Recorded"}</td></tr>)}</tbody></table></div></details></> : <p>No dates are available for this period.</p>}
  </section>;
}

export default function WritingDashboard() {
  usePageNavigation();
  const [data, setData] = useState(null);
  const [access, setAccess] = useState("loading");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("totalViews");
  const [rangeDraft, setRangeDraft] = useState("30d");
  const [fromDraft, setFromDraft] = useState("");
  const [toDraft, setToDraft] = useState("");
  const [rangeError, setRangeError] = useState("");
  const [chartArticle, setChartArticle] = useState("");
  const [periodQuery, setPeriodQuery] = useState("");
  const [periodSort, setPeriodSort] = useState("periodWebsiteViews");
  const [apiKey, setApiKey] = useState("");
  const [devtoStatus, setDevtoStatus] = useState(null);
  const [manualStatus, setManualStatus] = useState(null);
  const [mutation, setMutation] = useState(null);
  const [platform, setPlatform] = useState("substack");
  const [asOf, setAsOf] = useState("");
  const [slug, setSlug] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [views, setViews] = useState("");
  const [manualMode, setManualMode] = useState("single");
  const [csvFile, setCsvFile] = useState(null);
  const controllers = useRef(new Set());
  const mounted = useRef(true);
  const busy = useRef(false);
  const apiInput = useRef(null);
  const latestLoad = useRef(0);
  const appliedFilters = useRef(DEFAULT_FILTERS);
  const lastAttempt = useRef(DEFAULT_FILTERS);
  const hasLoadedData = useRef(false);

  const request = useCallback(async (url, payload) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 40000);
    try {
      const response = await fetch(url, {
        method: payload === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new DashboardError(body?.error || "The request could not be completed.", response.status, body?.code);
      if (!body || typeof body !== "object") throw new Error("The server returned an unexpected response.");
      return body;
    } catch (error) {
      if (error.name === "AbortError") throw new DashboardError("The request timed out. Please try again.", undefined, "request_timeout");
      throw error;
    } finally { clearTimeout(timeout); controllers.current.delete(controller); }
  }, []);

  const handleAccessError = useCallback(error => {
    if (error.status !== 401 && error.status !== 403) return false;
    if (mounted.current) { hasLoadedData.current = false; setData(null); setApiKey(""); setAccess(error.status === 401 ? "signin" : "forbidden"); }
    return true;
  }, []);

  const load = useCallback(async (filters = appliedFilters.current) => {
    if (!mounted.current) return;
    const requestId = ++latestLoad.current;
    lastAttempt.current = { ...filters };
    setLoading(true); setLoadError("");
    try {
      const result = await request(reportUrl(filters));
      const period = result.period;
      if (!Array.isArray(result.articles) || !Array.isArray(result.daily) || !result.totals || !result.coverage ||
          !period || !Object.prototype.hasOwnProperty.call(RANGE_LABELS, period.range) || !validDate(period.from) || !validDate(period.to) || !validDate(period.today) ||
          !Array.isArray(period.daily) || !period.daily.every(day => validDate(day.day) && (day.views === null || validCount(day.views))) ||
          !validCount(period.totalWebsiteViews) || !validCount(period.selectedArticleViews) || !result.articles.every(article => validCount(article.periodWebsiteViews))) throw new Error("The dashboard response was incomplete.");
      if (mounted.current && requestId === latestLoad.current) {
        appliedFilters.current = filtersFromPeriod(period);
        hasLoadedData.current = true;
        setData(result); setAccess("owner"); setLoadError(""); setChartArticle(period.selectedArticle || "");
      }
    } catch (error) {
      if (mounted.current && requestId === latestLoad.current && !handleAccessError(error)) {
        setLoadError(`The dashboard could not be loaded. ${hasLoadedData.current ? "The report below still shows its last successfully loaded date range." : "Please try again."}`);
        setChartArticle(appliedFilters.current.article);
        setAccess(current => current === "loading" ? "error" : current);
      }
    } finally { if (mounted.current && requestId === latestLoad.current) setLoading(false); }
  }, [request, handleAccessError]);

  useEffect(() => {
    mounted.current = true;
    load();
    const currentControllers = controllers.current;
    return () => { mounted.current = false; latestLoad.current += 1; currentControllers.forEach(controller => controller.abort()); };
  }, [load]);

  useEffect(() => {
    if (!mutation && devtoStatus?.needsKey) apiInput.current?.focus();
  }, [mutation, devtoStatus]);

  const shownArticles = useMemo(() => {
    const filtered = (data?.articles || []).filter(article => `${article.title} ${article.slug}`.toLowerCase().includes(query.trim().toLowerCase()));
    return filtered.sort((a, b) => sort === "title" ? a.title.localeCompare(b.title) : (b[sort] || 0) - (a[sort] || 0) || a.title.localeCompare(b.title));
  }, [data, query, sort]);

  const periodArticles = useMemo(() => {
    const filtered = (data?.articles || []).filter(article => `${article.title} ${article.slug}`.toLowerCase().includes(periodQuery.trim().toLowerCase()));
    return filtered.sort((a, b) => periodSort === "title" ? a.title.localeCompare(b.title) : b.periodWebsiteViews - a.periodWebsiteViews || a.title.localeCompare(b.title));
  }, [data, periodQuery, periodSort]);

  function changeRange(value) {
    setRangeDraft(value); setRangeError("");
    if (value === "custom") {
      if (!fromDraft) setFromDraft(data.period.from);
      if (!toDraft) setToDraft(data.period.to);
    }
  }

  function applyRange(event) {
    event.preventDefault();
    if (mutation) return;
    setRangeError("");
    if (rangeDraft === "custom") {
      if (!validDate(fromDraft) || !validDate(toDraft)) { setRangeError("Enter valid start and end dates."); return; }
      if (fromDraft > toDraft) { setRangeError("The start date must be on or before the end date."); return; }
      if (toDraft > data.period.today) { setRangeError(`Choose dates on or before ${dateLabel(data.period.today)} in Toronto.`); return; }
      if ((Date.parse(toDraft) - Date.parse(fromDraft)) / 86400000 + 1 > 3660) { setRangeError("Choose a period of at most 3,660 days, including both the start and end dates."); return; }
    }
    load({ range: rangeDraft, ...(rangeDraft === "custom" ? { from: fromDraft, to: toDraft } : {}), article: appliedFilters.current.article });
  }

  function changeChartArticle(article) {
    setChartArticle(article);
    load({ ...appliedFilters.current, article });
  }

  async function importDevto(event) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true; setMutation("devto"); setDevtoStatus(null);
    const key = apiKey.trim();
    setApiKey("");
    try {
      const result = await request("/api/private/devto-stats", key ? { apiKey: key } : {});
      if (result.ok !== true || !validCount(result.imported)) throw new Error("Import was not confirmed.");
      if (mounted.current) setDevtoStatus({ type: "success", text: `Updated DEV.to views for ${count(result.imported)} ${result.imported === 1 ? "article" : "articles"}. Each latest cumulative snapshot replaces the previous one.` });
      await load();
    } catch (error) {
      if (mounted.current && !handleAccessError(error)) {
        setDevtoStatus(devtoImportError(error));
      }
    } finally { busy.current = false; if (mounted.current) { setApiKey(""); setMutation(null); } }
  }

  async function saveManual(event) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true; setMutation("manual"); setManualStatus(null);
    try {
      if (!validDate(asOf)) throw new Error("Choose the date these cumulative view counts were reported.");
      let articles;
      if (manualMode === "csv") {
        if (!csvFile) throw new Error("Choose a CSV file first.");
        if (csvFile.size > 256000) throw new Error("Use a CSV file smaller than 256 KB.");
        articles = parseWritingStatsCsv(await csvFile.text());
      } else {
        if (!slug) throw new Error("Choose an article.");
        if (!safeUrl(sourceUrl.trim())) throw new Error("Enter a valid HTTPS article URL without a username, password, or port.");
        if (!/^\d+$/.test(views.trim()) || !validCount(Number(views.trim()))) throw new Error("Enter a non-negative whole number of views.");
        articles = [{ slug, url: sourceUrl.trim(), views: Number(views.trim()) }];
      }
      const knownSlugs = new Set(data.articles.map(article => article.slug));
      if (articles.some(article => !knownSlugs.has(article.slug))) throw new Error("Every row must use a slug from an article on this website.");
      const result = await request("/api/private/writing-stats", { platform, asOf, articles });
      if (result.ok !== true || !validCount(result.imported)) throw new Error("The update was not confirmed. Check the dashboard before trying again.");
      if (mounted.current) setManualStatus({ type: "success", text: `Saved ${PLATFORM_LABELS[platform]} views for ${count(result.imported)} ${result.imported === 1 ? "article" : "articles"}. Existing snapshots were replaced, not added together.` });
      await load();
    } catch (error) {
      if (mounted.current && !handleAccessError(error)) setManualStatus({ type: "error", text: error.status && error.status >= 500 ? "The update could not be confirmed. Check the dashboard before trying again." : error.message || "The update could not be confirmed. Please try again." });
    } finally { busy.current = false; if (mounted.current) setMutation(null); }
  }

  return <div className="writing-dashboard">
    <header className="page-intro dashboard-intro"><p className="eyebrow">PRIVATE / WRITING</p><h1>Writing dashboard.</h1><p>Article views and likes, with reported views from the other places your writing appears.</p><Link className="text-link" to="/writing">View the public writing archive →</Link></header>
    {access === "loading" && <p role="status" className="dashboard-loading">Checking dashboard access…</p>}
    {access === "signin" && <section className="dashboard-panel dashboard-access" aria-labelledby="dashboard-sign-in"><h2 id="dashboard-sign-in">Sign in to view your dashboard.</h2><p>These statistics and import tools are available only to the site owner.</p><a className="primary-link" href={SIGN_IN_URL} target="_top">Sign in with ChatGPT</a></section>}
    {access === "forbidden" && <section className="dashboard-panel dashboard-access" aria-labelledby="dashboard-owner-only"><h2 id="dashboard-owner-only">This dashboard is private.</h2><p>You are signed in, but this account does not have owner access.</p><Link className="text-link" to="/writing">Return to the writing archive →</Link></section>}
    {loadError && access !== "signin" && access !== "forbidden" && <div className="dashboard-message is-error" role="alert"><p>{loadError}</p><button className="dashboard-secondary" onClick={() => load(lastAttempt.current)} disabled={loading || !!mutation}>Try again</button></div>}
    {access === "owner" && data && <>
      <div className="dashboard-toolbar"><p>Refreshed {dateLabel(data.coverage.generatedAt || data.coverage.lastUpdated)} · Toronto time</p><button className="dashboard-secondary" onClick={() => load()} disabled={loading || !!mutation}>{loading ? "Refreshing…" : "Refresh dashboard"}</button></div>
      {data.coverage.analyticsEnabled === false && <p className="dashboard-message" role="status">Website view collection is currently paused. Previously recorded views and reported platform snapshots are shown below.</p>}
      <section className="dashboard-panel dashboard-period-report" aria-labelledby="period-report-heading">
        <p className="eyebrow">DATE RANGE / WEBSITE ONLY</p><h2 id="period-report-heading">Website views</h2>
        <p>Choose a period to see views recorded on this website. Both the start and end date are included, in Toronto time.</p>
        <form className="dashboard-range-form" onSubmit={applyRange} aria-label="Choose website report period" noValidate>
          <label>Date range<select value={rangeDraft} onChange={event => changeRange(event.target.value)} disabled={!!mutation}>{Object.entries(RANGE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          {rangeDraft === "custom" && <><label>Start date<input type="date" value={fromDraft} max={data.period.today} onChange={event => { setFromDraft(event.target.value); setRangeError(""); }} disabled={!!mutation} required /></label><label>End date<input type="date" value={toDraft} max={data.period.today} onChange={event => { setToDraft(event.target.value); setRangeError(""); }} disabled={!!mutation} required /></label></>}
          <button className="primary-link" type="submit" disabled={!!mutation}>Apply date range</button>
        </form>
        {rangeError && <p className="dashboard-message is-error" role="alert">{rangeError}</p>}
        {loading && <p className="dashboard-note" role="status">Loading report… The displayed dates and figures stay together until the new report is ready.</p>}
        <div className="dashboard-period-summary" aria-label="Selected website period summary"><div><span>Showing {RANGE_LABELS[data.period.range].toLowerCase()}</span><strong>{periodDates(data.period)}</strong><small>Both dates included · Toronto time</small></div><div><span>Recorded website views in this period</span><strong>{hasRecordedDays(data.period) ? count(data.period.totalWebsiteViews) : "Not available"}</strong><small>All articles · repeat visits can count again</small></div></div>
        <p className="dashboard-note">{data.period.websiteSince ? `Tracking started ${dateLabel(data.period.websiteSince)}.` : "Website tracking has not recorded any days yet."}{data.period.includesUnrecordedDays ? " Dates before tracking began are unavailable, not zero; totals include recorded days only." : ""}{data.period.includesToday ? ` Today (${dateLabel(data.period.today)}) is a partial day.` : ""}</p>
      </section>
      <DailyViews period={data.period} articles={data.articles} chartArticle={chartArticle} onArticleChange={changeChartArticle} disabled={loading || !!mutation} />
      <section className="dashboard-panel" aria-labelledby="period-articles-heading"><div className="dashboard-section-heading"><div><p className="eyebrow">SELECTED PERIOD / ALL ARTICLES</p><h2 id="period-articles-heading">Website views by article</h2></div><p>{periodDates(data.period)}</p></div>
        <div className="dashboard-filters"><label>Search period report<input type="search" value={periodQuery} onChange={event => setPeriodQuery(event.target.value)} placeholder="Search titles or slugs" /></label><label>Sort website report by<select value={periodSort} onChange={event => setPeriodSort(event.target.value)}><option value="periodWebsiteViews">Views in this period</option><option value="title">Article title</option></select></label></div>
        <div className="dashboard-table-scroll" role="region" aria-label="Website views in selected period" tabIndex="0"><table className="dashboard-table dashboard-period-table"><caption>Website views by article for {periodDates(data.period)}. All articles are included regardless of the chart selection.</caption><thead><tr><th scope="col">Article</th><th scope="col">Views in this period</th></tr></thead><tbody>{periodArticles.map(article => <tr key={article.slug}><th scope="row"><Link to={`/writing/${article.slug}`}>{article.title}</Link></th><td>{hasRecordedDays(data.period) ? count(article.periodWebsiteViews) : "Not available"}</td></tr>)}</tbody></table></div>
        {!periodArticles.length && <p className="dashboard-note">{data.articles.length ? "No articles match this search." : "No articles are available yet."}</p>}
      </section>
      <section className="dashboard-lifetime-report" aria-labelledby="lifetime-report-heading"><header className="dashboard-report-heading"><p className="eyebrow">SEPARATE REPORT / LIFETIME & PLATFORM SNAPSHOTS</p><h2 id="lifetime-report-heading">Lifetime and reported platform totals</h2><p>The date-range controls above do not filter these figures. Website views and likes cover all recorded history; each external platform uses its latest cumulative snapshot.</p></header>
      <div className="dashboard-summary" aria-label="Writing statistics summary">
        <div className="dashboard-stat"><span>Website article views</span><strong>{count(data.totals.websiteViews)}</strong><small>Since {data.coverage.websiteSince ? dateLabel(data.coverage.websiteSince) : "collection began"}</small></div>
        <div className="dashboard-stat"><span>Reported views (available sources)</span><strong>{count(data.totals.reportedViews)}</strong><small>{PLATFORMS.every(source => data.coverage.platforms?.[source]?.reportedArticles === data.articles.length && data.articles.length > 0) ? "Website + available external snapshots" : "Incomplete coverage · only available sources included"}</small></div>
        <div className="dashboard-stat"><span>Website article likes</span><strong>{count(data.totals.likes)}</strong><small>Likes recorded on this website</small></div>
      </div>
      <section className="dashboard-panel dashboard-definitions" aria-labelledby="dashboard-definitions-heading"><h2 id="dashboard-definitions-heading">What these numbers mean</h2>
        <p>Views are not unique readers. One person can generate multiple views or read the same article on more than one platform. The reported total adds the available counts; it does not deduplicate people across platforms.</p>
        <p>Website counts cover recorded article views {data.coverage.websiteSince ? `since ${dateLabel(data.coverage.websiteSince)}` : "from the start of collection; there are no earlier records"}. External counts are the latest cumulative snapshots you imported, each with its own “as of” date. Missing sources show “Not added”, not zero.</p>
        <p>Platforms measure views differently. Substack can include web, email, and app views. On Medium, enter views (at least 5 seconds), not reads (at least 30 seconds). These platform counts are not directly comparable.</p>
        <div className="dashboard-source-coverage">{PLATFORMS.map(source => {
          const coverage = data.coverage.platforms?.[source];
          const value = data.totals[`${source}Views`];
          return <div key={source}><h3>{PLATFORM_LABELS[source]}</h3><strong>{validCount(value) ? `${count(value)} reported views` : "Not added"}</strong>{coverage && <small>{count(coverage.reportedArticles)} of {count(coverage.totalArticles)} articles{coverage.latestAsOf && <> · As of {dateLabel(coverage.earliestAsOf, "UTC")}{coverage.earliestAsOf !== coverage.latestAsOf ? `–${dateLabel(coverage.latestAsOf, "UTC")}` : ""}</>}</small>}</div>;
        })}</div>
        {data.coverage.unassignedWebsiteViews > 0 && <p className="dashboard-note">{count(data.coverage.unassignedWebsiteViews)} website views could not be assigned to a current article. They are not included in the per-article table.</p>}
      </section>
      <section className="dashboard-panel" aria-labelledby="article-stats-heading"><div className="dashboard-section-heading"><div><p className="eyebrow">BY ARTICLE</p><h2 id="article-stats-heading">Views across your writing</h2></div></div>
        <div className="dashboard-filters"><label>Find an article<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search titles or slugs" /></label><label>Sort by<select value={sort} onChange={event => setSort(event.target.value)}><option value="totalViews">Reported views</option><option value="websiteViews">Website views</option><option value="likes">Website likes</option><option value="title">Article title</option></select></label></div>
        <div className="dashboard-table-scroll" role="region" aria-label="Per-article writing statistics" tabIndex="0"><table className="dashboard-table dashboard-articles-table"><caption>Recorded website views and latest reported cumulative views from external sources. Total means available reported views, not unique readers.</caption><thead><tr><th scope="col">Article</th><th scope="col">Website</th><th scope="col">DEV.to</th><th scope="col">Substack</th><th scope="col">Medium</th><th scope="col">Reported total</th><th scope="col">Website likes</th></tr></thead><tbody>{shownArticles.map(article => <tr key={article.slug}><th scope="row"><Link to={`/writing/${article.slug}`}>{article.title}</Link><small className="dashboard-article-slug">{article.slug}</small></th><td><strong>{count(article.websiteViews)}</strong></td>{PLATFORMS.map(source => <td key={source}><ExternalViews source={article[source]} platform={source} /></td>)}<td><strong>{count(article.totalViews)}</strong></td><td>{count(article.likes)}</td></tr>)}</tbody></table></div>
        {!shownArticles.length && <p className="dashboard-note">{data.articles.length ? "No articles match this search." : "No articles are available yet."}</p>}
      </section>
      </section>
      <section className="dashboard-panel" aria-labelledby="devto-import-heading"><p className="eyebrow">OWNER TOOLS</p><h2 id="devto-import-heading">Import DEV.to views</h2><p>Open <a className="text-link" href="https://dev.to/settings/extensions" target="_blank" rel="noopener noreferrer">DEV.to API key settings ↗</a> while signed in as <strong>dessygil</strong>. Copy the generated key value, not its label, and paste it here, never in chat. It is used for this import only and cleared when submitted; this page does not save it.</p><form onSubmit={importDevto} className="dashboard-import-form" aria-label="Import DEV.to statistics"><label htmlFor="dashboard-devto-key">DEV.to API key (if requested)</label><input ref={apiInput} id="dashboard-devto-key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" spellCheck="false" disabled={!!mutation} aria-describedby="dashboard-devto-key-note" /><p className="dashboard-note" id="dashboard-devto-key-note">If a key is already configured for the site, you can leave this blank. Importing replaces the previous DEV.to snapshot for each matched article.</p><button className="primary-link" type="submit" disabled={!!mutation || loading}>{mutation === "devto" ? "Importing…" : "Import DEV.to views"}</button></form>{devtoStatus && <p className={`dashboard-message ${devtoStatus.type === "error" ? "is-error" : "is-success"}`} role={devtoStatus.type === "error" ? "alert" : "status"}>{devtoStatus.text}</p>}</section>
      <section className="dashboard-panel" aria-labelledby="manual-stats-heading"><p className="eyebrow">OWNER TOOLS</p><h2 id="manual-stats-heading">Add platform view counts</h2><p>Copy the cumulative view count shown by Substack or Medium and record the date. Saving a new snapshot replaces the previous count for that article and platform; it never adds both snapshots together.</p>
        <form className="dashboard-manual-form" onSubmit={saveManual} aria-label="Save platform view counts" noValidate><fieldset disabled={!!mutation}><legend className="dashboard-sr-only">Platform snapshot</legend><div className="dashboard-form-grid"><label>Platform<select value={platform} onChange={event => setPlatform(event.target.value)}><option value="substack">Substack</option><option value="medium">Medium</option></select></label><label>Counts as of<input type="date" value={asOf} onChange={event => setAsOf(event.target.value)} required /></label><label>Entry method<select value={manualMode} onChange={event => { setManualMode(event.target.value); setManualStatus(null); }}><option value="single">One article</option><option value="csv">CSV file</option></select></label></div>
          {manualMode === "single" ? <><label>Article<select value={slug} onChange={event => setSlug(event.target.value)} required><option value="">Choose an article</option>{data.articles.map(article => <option value={article.slug} key={article.slug}>{article.title}</option>)}</select></label><label>Article URL on {PLATFORM_LABELS[platform]}<input type="url" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} placeholder={platform === "substack" ? "https://publication.substack.com/p/article" : "https://medium.com/@author/article"} required /></label><label>Cumulative views<input type="number" min="0" step="1" inputMode="numeric" value={views} onChange={event => setViews(event.target.value)} required /></label></> : <><label>Statistics CSV<input type="file" accept=".csv,text/csv" onChange={event => { setCsvFile(event.target.files?.[0] || null); setManualStatus(null); }} aria-describedby="dashboard-csv-help" /></label><div className="dashboard-csv-help" id="dashboard-csv-help"><p>Use the header <code>slug,url,views</code> and one row per article. Copy the article slug from the table above. All rows use the selected platform and “Counts as of” date. Quoted fields and commas are supported; use at most 500 rows and 256 KB.</p><pre>slug,url,views{"\n"}your-article-slug,https://publication.substack.com/p/article,123</pre><p>The example is a format guide, not imported data.</p></div></>}
          <p className="dashboard-note">Use the article URL hosted on substack.com or medium.com. Missing platform statistics stay “Not added”. Enter zero only when the platform reports zero views.</p><button type="submit" className="primary-link" disabled={!!mutation || loading}>{mutation === "manual" ? "Saving…" : "Save platform views"}</button>
        </fieldset></form>{manualStatus && <p className={`dashboard-message ${manualStatus.type === "error" ? "is-error" : "is-success"}`} role={manualStatus.type === "error" ? "alert" : "status"}>{manualStatus.text}</p>}
      </section>
    </>}
  </div>;
}
