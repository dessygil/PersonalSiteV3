import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildPath = join(root, 'client/build');
const assets = {};
const types = { '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.gif':'image/gif', '.webp':'image/webp', '.ico':'image/x-icon', '.json':'application/json', '.txt':'text/plain' };
async function walk(path, prefix = '') {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) { if (entry.name !== 'writing') await walk(join(path, entry.name), name); }
    else if (!/\.(map|html)$/.test(name) && name !== '/robots.txt') assets[name] = { type: types[extname(name)] || 'application/octet-stream', data: (await readFile(join(path, entry.name))).toString('base64') };
  }
}
await walk(buildPath);
const updater = await build({ entryPoints: [join(root, 'scripts/update-hosted-writing.mjs')], bundle: true, format: 'esm', platform: 'node', target: 'node24', write: false, banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
assets['/automation/devto-updater.mjs'] = { type: 'application/javascript; charset=utf-8', data: Buffer.from(updater.outputFiles[0].contents).toString('base64') };
assets['/automation/DEVTO.md'] = { type: 'text/plain; charset=utf-8', data: (await readFile(join(root, 'AUTOMATION.md'))).toString('base64') };
const checker = await build({ entryPoints: [join(root, 'scripts/check-hosted-site.mjs')], bundle: true, format: 'esm', platform: 'node', target: 'node24', write: false, banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
assets['/automation/site-checker.mjs'] = { type: 'application/javascript; charset=utf-8', data: Buffer.from(checker.outputFiles[0].contents).toString('base64') };
assets['/automation/site-report.mjs'] = { type: 'application/javascript; charset=utf-8', data: (await readFile(join(root, 'scripts/read-site-report.mjs'))).toString('base64') };
assets['/automation/MONITORING.md'] = { type: 'text/plain; charset=utf-8', data: (await readFile(join(root, 'MONITORING.md'))).toString('base64') };
const template = await readFile(join(buildPath, 'index.html'), 'utf8');
const snapshot = JSON.parse(await readFile(join(root, 'client/src/data/articles.json'), 'utf8'));
const generated = join(root, 'server/generated.mjs');
await writeFile(generated, `export const assets=${JSON.stringify(assets)};\nexport const template=${JSON.stringify(template)};\nexport const snapshot=${JSON.stringify(snapshot)};\n`);
await mkdir(join(root, 'dist/server'), { recursive: true });
try {
  await build({ entryPoints: [join(root, 'server/worker.mjs')], outfile: join(root, 'dist/server/index.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    loader: { '.js': 'jsx', '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
    alias: { react: join(root, 'client/node_modules/react'), 'react-dom/server': join(root, 'client/node_modules/react-dom/server.browser.js'), 'react-dom': join(root, 'client/node_modules/react-dom'), 'react-router-dom': join(root, 'client/node_modules/react-router-dom') }
  });
} finally { await rm(generated); }
console.log(`Built Worker with ${Object.keys(assets).length} assets and ${snapshot.length} fallback articles.`);
