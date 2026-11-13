import usePageNavigation from "../../lib/usePageNavigation";
import React from "react";
import MeIntro from "../../components/meintro/MeIntro";
import About from "../../components/about/About";
import Experience from "../../components/experience/Experience";
import Portfolio from "../../components/portfolio/Portfolio";
import BlogIntro from "../../components/blogintro/BlogIntro";
import ContactMe from "../../components/contactme/ContactMe";
import Training from "../../components/training/Training";
import { getSiteConfig } from "../../lib/siteConfig";
export default function Home({ articles, config = getSiteConfig() }) {
  usePageNavigation();
  return <div className="home-page"><MeIntro /><About /><Experience /><BlogIntro articles={articles} /><Training config={config} /><Portfolio /><ContactMe config={config} /></div>;
}
