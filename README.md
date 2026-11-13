# Desmond Gilmour — V3

The third version of Desmond Gilmour's personal website: a professional profile,
selected projects, training updates, and a complete archive of published DEV.to
articles. The homepage uses the LinkedIn information supplied by Des on
November 10, 2026. The resume download has been removed; Des shares that directly.

## Local development

The React 18 application lives in `client/`. From the repository root:

```sh
npm ci
npm run setup
npm start
```

Open `http://localhost:3000`. Setup and builds were verified with Node.js 24 and
npm 11. Root `npm install` alone does not install the client dependencies.

```sh
npm run build
npm test -- --watchAll=false --runInBand
```

Production output is `client/build/`. The postbuild script creates real static
entrypoints for `/writing/` and every `/writing/:slug/` route, so article links
can be opened directly. Configure your static host's SPA fallback to `index.html`
for unknown client-side paths if supported. No frontend API token is required.

The Sites deployment adds a small Worker and durable R2 writing archive.
Run `npm ci` and `npm run build:site` for its `dist/server/index.js` output.
The Worker serves the full homepage, topic collections, and article HTML before
JavaScript runs, with profile/article metadata, a sitemap, and an RSS feed.
The homepage downloads article summaries; full text loads only when needed.
Responsive WebP portraits avoid downloading the original multi-megabyte photo.
See `SEARCH.md` for the canonical policy and the later custom-domain connection.

## Content

- Introduction and About: `client/src/components/meintro/MeIntro.jsx` and
  `client/src/components/about/About.jsx`.
- Jobs and dates: `client/src/data/experience.json`.
- Education: `client/src/components/experience/Experience.jsx`.
- Selected projects: `client/src/components/portfolio/Portfolio.jsx`.
- Earlier GitHub projects: `client/src/data/github-projects.json`.
- Full writing archive: `client/src/data/articles.json`.
- Article images: `client/public/writing-assets/`.
- Writing topic pages: `client/src/lib/writingTopics.js` and `client/src/pages/writing/Topic.jsx`.
- Profile/search metadata: `client/src/lib/siteMetadata.js`.
- Layout and responsive styles: `client/src/index.css`.

Article pages preserve the full source text, formatting, links, tags, and dates.
HTML is sanitized before display; DEV.to-only code controls are removed. Source
links credit the original DEV.to publication. Article text and imported images
are served with the site, with no visitor-time requests to the DEV.to API.

## Refresh writing from DEV.to

With Node.js 24.5 or later:

```sh
npm run sync:writing
npm run build
```

The importer reads every page of public articles for `dessygil`, downloads each
full article, copies supported images, and replaces the JSON only after all
articles succeed. It checks author identity and unique slugs. Review its output,
commit the changed article data and assets, then republish. The initial import
contains 17 published articles. This command updates the static fallback.
The hosted Site has a separate background importer that reads new and edited
posts into persistent storage without a rebuild. See `AUTOMATION.md` for the
unattended update operation and verification steps.

## Hosting and source

Source repository: [dessygil/PersonalSiteV3](https://github.com/dessygil/PersonalSiteV3).

This version is publicly hosted at
https://des-personal-site-preview.playfulporpoise2.chatgpt.site while the owner
arranges the transfer of desmondgilmour.com into their Name.com account.
The original dessygil/des-personal-site GitHub repository and Netlify site are
separate and are not changed by this version. V3 is the independent source copy.

Sites keeps its own deployment source repository. Publishing code to GitHub
does not deploy the website automatically; build and publish through Sites to
update the running version. The existing Sites project ID is retained in
`.openai/hosting.json`. Secrets, stored contact messages, analytics records,
and runtime writing updates are not part of this repository.

For the full hosted application, run `npm run build:site` and
`npm run test:server`. A static client-only host does not provide the persistent
contact inbox, runtime writing imports, or server-rendered article pages.

## Training, contact, analytics, and checks

The homepage includes a half-Ironman training section and the owner's official
Strava widgets, which load on request. The site also includes a first-party
contact form, basic aggregate analytics, and authenticated health/link checks.
These use existing hosting and task resources, without new service accounts.
See `INTEGRATIONS.md` for runtime settings and data handling, and `MONITORING.md`
for the existing daily task's checks. Analytics is restricted to the approved
public origins; local development remains untracked.
