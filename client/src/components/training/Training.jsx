import React, { useEffect, useRef, useState } from "react";
import "./training.css";
import { getSiteConfig } from "../../lib/siteConfig";

function officialStravaUrl(value, endpoint = "profile") {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    const paths = {
      profile: /^\/athletes\/[1-9]\d*\/?$/,
      "latest-rides": /^\/athletes\/[1-9]\d*\/latest-rides\/[A-Za-z0-9_-]+\/?$/,
      "activity-summary": /^\/athletes\/[1-9]\d*\/activity-summary\/[A-Za-z0-9_-]+\/?$/
    };
    const path = paths[endpoint];
    if (url.origin !== "https://www.strava.com" || url.username || url.password || url.hash || !path.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export default function Training({ config = getSiteConfig() }) {
  const widgetUrl = officialStravaUrl(config?.strava?.widgetUrl, "latest-rides");
  const summaryWidgetUrl = officialStravaUrl(config?.strava?.summaryWidgetUrl, "activity-summary");
  const profileUrl = officialStravaUrl(config?.strava?.profileUrl);
  const widgetKey = JSON.stringify([summaryWidgetUrl, widgetUrl]);
  const hasWidgets = !!(summaryWidgetUrl || widgetUrl);
  const [loadedWidgets, setLoadedWidgets] = useState(null);
  const isLoaded = hasWidgets && loadedWidgets === widgetKey;
  const widgetRegion = useRef(null);
  useEffect(() => {
    if (isLoaded) widgetRegion.current?.focus({ preventScroll: true });
  }, [isLoaded, widgetKey]);

  return (
    <section id="Training-anchor" className="content-section training-section" aria-labelledby="training-heading">
      <div className={`training-layout${hasWidgets ? " training-layout-with-widget" : ""}`}>
        <div className="training-intro">
          <div className="section-heading"><div><span className="section-index">05 / STRAVA</span><h2 id="training-heading">Training for a half Ironman.</h2></div></div>
          <p className="section-summary">Away from work, I’m training for a half Ironman, balancing swimming, cycling, and running.</p>
          {profileUrl && <a className="text-link training-profile-link" href={profileUrl}>Follow my training on Strava <span aria-hidden="true">↗</span></a>}
        </div>
        {hasWidgets && <div className="training-widget-panel">
          <h3 id="training-updates-heading">Training updates</h3>
          {isLoaded ? <div ref={widgetRegion} className="training-widgets" role="region" aria-labelledby="training-updates-heading" tabIndex={-1}>
            {summaryWidgetUrl && <iframe className="training-widget training-widget-summary" src={summaryWidgetUrl} title="Desmond Gilmour’s Strava activity summary" width="300" height="160" loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups" />}
            {widgetUrl && <iframe className="training-widget training-widget-latest" src={widgetUrl} title="Desmond Gilmour’s latest Strava activities" width="300" height="454" loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups" />}
          </div> : <div className="training-widget-consent"><p>Load my Strava activity to follow along.</p><p className="training-widget-privacy" id="training-widget-privacy">Strava provides this content. Loading it connects your browser to Strava.</p><button className="primary-link" type="button" onClick={() => setLoadedWidgets(widgetKey)} aria-describedby="training-widget-privacy">Load Strava activity</button></div>}
        </div>}
      </div>
    </section>
  );
}
