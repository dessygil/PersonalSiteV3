import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { getSiteConfig } from "./siteConfig";
import { mountAnalytics } from "./siteAnalytics";

export default function Analytics() {
  const { pathname } = useLocation();
  const { enabled, endpoint } = getSiteConfig().analytics;
  const session = useRef(null);
  useEffect(() => {
    const active = mountAnalytics({ analytics: { enabled, endpoint } });
    session.current = active;
    return () => { active.release(); if (session.current === active) session.current = null; };
  }, [enabled, endpoint]);
  useEffect(() => { session.current?.page(pathname); }, [pathname, enabled, endpoint]);
  return null;
}
