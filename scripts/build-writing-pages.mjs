// Give every article a real static entrypoint so direct links and refreshes work.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'client/build');
const template = await readFile(join(output, 'index.html'), 'utf8');
const articles = JSON.parse(await readFile(join(root, 'client/src/data/articles.json'), 'utf8'));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
async function page(path, title, description) {
  const directory = join(output, path);
  await mkdir(directory, { recursive: true });
  const html = template.replace(/<title>[^<]*<\/title>/, `<title>${escape(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?\s*>/, `<meta name="description" content="${escape(description)}"/>`);
  await writeFile(join(directory, 'index.html'), html);
}
await page('writing', 'Writing | Desmond Gilmour', 'Articles by Desmond Gilmour on biophysical science, chemistry, and software.');
for (const article of articles) {
  if (!/^[a-z0-9-]+$/.test(article.slug)) throw new Error('Unsafe article slug');
  await page(`writing/${article.slug}`, `${article.title} | Desmond Gilmour`, article.description);
}
await writeFile(join(output, '404.html'), template);
console.log(`Prepared Writing archive and ${articles.length} direct article entrypoints.`);
