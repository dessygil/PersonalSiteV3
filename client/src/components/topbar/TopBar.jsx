import React, { useState, useEffect, useRef } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
export default function TopBar() {
  const [open, setOpen] = useState(false);
  const menuButton = useRef(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location]);
  const currentSection = hash => location.pathname === "/" && location.hash === hash ? "location" : undefined;
  function handleKeyDown(event) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      menuButton.current?.focus();
    }
  }
  return <header className="site-header"><nav className="site-nav" aria-label="Main navigation" onKeyDown={handleKeyDown}>
    <Link className="brand" to="/" aria-label="Desmond Gilmour home" aria-current={location.pathname === "/" && !location.hash ? "page" : undefined}><span className="brand-mark" aria-hidden="true">dg.</span><span className="brand-name">Desmond Gilmour</span></Link>
    <button ref={menuButton} className="menu-toggle" type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls="primary-links">{open ? "Close" : "Menu"}</button>
    <div id="primary-links" className={`nav-links ${open ? "is-open" : ""}`}><Link to="/#Experience-anchor" aria-current={currentSection("#Experience-anchor")} onClick={() => setOpen(false)}>Experience</Link><NavLink to="/writing">Writing</NavLink><Link to="/#Training-anchor" aria-current={currentSection("#Training-anchor")} onClick={() => setOpen(false)}>Strava</Link><Link to="/#Portfolio-anchor" aria-current={currentSection("#Portfolio-anchor")} onClick={() => setOpen(false)}>Projects</Link><Link className="nav-contact" to="/#Contact-anchor" aria-current={currentSection("#Contact-anchor")} onClick={() => setOpen(false)}>Get in touch <span aria-hidden="true">↗</span></Link></div>
  </nav></header>;
}
