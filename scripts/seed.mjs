// Generates a deterministic folder of markdown notes for spike benchmarks.
// Usage: node scripts/seed.mjs [count=10000] [dir=fixtures/notes]
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const count = Number(process.argv[2] ?? 10000);
const dir = process.argv[3] ?? 'fixtures/notes';
const words = ('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa ' +
  'quebec romeo sierra tango uniform victor whiskey xray yankee zulu café naïve résumé meeting project recipe ' +
  'garden budget travel invoice server deploy kubernetes rust golang tauri wails sqlite search index note idea ' +
  'book movie music workout grocery family friend weekend monday tuesday release bug feature design review').split(' ');
const tags = ['work', 'home', 'ideas', 'todo', 'reading', 'dev', 'travel', 'finance'];

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rand() * a.length)];
const phrase = (n) => Array.from({ length: n }, () => pick(words)).join(' ');

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const titles = [];
for (let i = 0; i < count; i++) {
  const title = `${phrase(2 + Math.floor(rand() * 3))} ${i}`;
  titles.push(title);
  const paras = Array.from({ length: 2 + Math.floor(rand() * 6) }, () => phrase(20 + Math.floor(rand() * 60)));
  if (i > 0 && rand() < 0.5) paras.push(`See [[${pick(titles.slice(0, i))}]].`);
  paras.push(`#${pick(tags)} #${pick(tags)}`);
  writeFileSync(join(dir, `${title}.md`), `# ${title}\n\n${paras.join('\n\n')}\n`);
}
console.log(`wrote ${count} notes to ${dir}`);
