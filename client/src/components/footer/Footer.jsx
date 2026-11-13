import React from "react";
import { Link } from "react-router-dom";
export default function Footer() {
  return <footer className="site-footer"><div><Link className="footer-name" to="/">Desmond Gilmour<span className="footer-name-dot" aria-hidden="true">.</span></Link><p>Science, software, and the work in between.</p></div><nav className="footer-links" aria-label="Social links and feeds"><a href="https://www.linkedin.com/in/desmondgilmour">LinkedIn <span aria-hidden="true">↗</span></a><a href="https://github.com/dessygil">GitHub <span aria-hidden="true">↗</span></a><a href="https://dev.to/dessygil">DEV.to <span aria-hidden="true">↗</span></a><a href="/feed.xml" type="application/rss+xml">RSS feed</a></nav><small>© {new Date().getFullYear()} Desmond Gilmour</small></footer>;
}
