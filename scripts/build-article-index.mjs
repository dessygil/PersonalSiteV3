import { readFile, writeFile } from 'node:fs/promises';
const source = new URL('../client/src/data/articles.json', import.meta.url);
const articles = JSON.parse(await readFile(source, 'utf8'));
const index = articles.map(({ bodyHtml, bodyMarkdown, ...metadata }) => metadata);
await writeFile(new URL('../client/src/data/article-index.json', import.meta.url), JSON.stringify(index, null, 2) + '\n');
