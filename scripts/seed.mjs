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
  // Tasks on ~30% of notes, a mix of open/done/dated.
  if (rand() < 0.3) {
    const n = 1 + Math.floor(rand() * 3);
    paras.push(Array.from({ length: n }, () => {
      const r = rand();
      const day = String(1 + Math.floor(rand() * 28)).padStart(2, '0');
      return r < 0.3 ? `- [x] ${phrase(4)} @done(2026-10-${day})` : r < 0.7 ? `- [ ] ${phrase(4)} 📅 2026-10-${day}` : `- [ ] ${phrase(4)}`;
    }).join('\n'));
  }
  // Front matter on about half the notes (dates, tags, an alias) to exercise the parser and alias lookups.
  const fm = rand() < 0.5
    ? `---\ncreated: 2024-01-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00+00:00\nmodified: 2025-${String(1 + (i % 12)).padStart(2, '0')}-15T12:30:00+00:00\ntags: [${pick(tags)}]\naliases: [${pick(words)} ${i}]\n---\n`
    : '';
  writeFileSync(join(dir, `${title}.md`), `${fm}# ${title}\n\n${paras.join('\n\n')}\n`);
}
console.log(`wrote ${count} notes to ${dir}`);
