import React, { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import TopBar from "./components/topbar/TopBar";
import Footer from "./components/footer/Footer";
import Home from "./pages/home/Home";
import "./index.css";
import usePageNavigation from "./lib/usePageNavigation";
import PageMetadata from "./lib/PageMetadata";
import Analytics from "./lib/Analytics";
import "./pages/writing/writing-enhancements.css";
const Writing = lazy(() => import("./pages/writing/Writing"));
const Article = lazy(() => import("./pages/writing/Article"));
const Topic = lazy(() => import("./pages/writing/Topic"));
function MissingPage() {
  usePageNavigation();
  return <section className="page-intro"><p className="eyebrow">404</p><h1>Page not found.</h1><p>This page may have moved.</p><Link className="text-link" to="/">Return home →</Link></section>;
}
export default function App() {
  return <BrowserRouter><PageMetadata /><Analytics /><a className="skip-to-content" href="#main">Skip to main content</a><TopBar />
    <main id="main" className="site-main" tabIndex="-1"><Suspense fallback={<p className="page-status" role="status">Loading page…</p>}><Routes>
      <Route path="/" element={<Home />} /><Route path="/writing" element={<Writing />} /><Route path="/writing/topics/:slug" element={<Topic />} /><Route path="/writing/:slug" element={<Article />} /><Route path="*" element={<MissingPage />} />
    </Routes></Suspense></main><Footer /></BrowserRouter>;
}
