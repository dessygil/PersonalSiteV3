import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { Route, Routes } from "react-router-dom";
import Home from "../client/src/pages/home/Home";
import Topic from "../client/src/pages/writing/Topic";
import TopBar from "../client/src/components/topbar/TopBar";
import Footer from "../client/src/components/footer/Footer";
import { articleQuestionMessage } from "../client/src/components/contactme/ContactMe";

// Render the existing blue/white components, keeping layout and résumé copy in
// one source of truth for the browser and initial HTML.
export function renderProfile(articles, path, config, search = "", origin = "") {
  const initialMessage = articleQuestionMessage(search, origin, articles);
  return renderToStaticMarkup(
    <StaticRouter location={path}>
      <a className="skip-to-content" href="#main">Skip to main content</a>
      <TopBar />
      <main id="main" className="site-main" tabIndex="-1">
        <Routes>
          <Route path="/" element={<Home articles={articles} config={config} initialMessage={initialMessage} />} />
          <Route path="/writing/topics/:slug" element={<Topic articles={articles} />} />
        </Routes>
      </main>
      <Footer />
    </StaticRouter>,
  );
}
