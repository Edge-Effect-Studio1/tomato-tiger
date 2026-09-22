// Prints a deploy file as JSON-escaped text (the exact form that goes inside a "data" string), in chunks.
//   node emit.js <relative file> [start] [len]      chunk of the escaped-source text (start/len in source characters)
//   node emit.js --info                             size + sha1 of every deploy file
const fs = require('fs');
const crypto = require('crypto');
const DEP = 'C:/Users/rverhofste/OneDrive - Adams Group, Inc/Desktop/Code/2_Analytics & Decks/Headwaters/deploy/adams-grower-survey/';
const FILES = ['index.html', 'js/survey-1.js', 'js/survey-2.js', 'js/survey-3.js', 'admin/index.html', 'api/submit.js', 'api/submissions.js', 'api/suggest-field.js', 'vercel.json', 'package.json', '404.html', 'pwa.js'];
if (process.argv[2] === '--info') {
  for (const f of FILES) { const b = fs.readFileSync(DEP + f); console.log(crypto.createHash('sha1').update(b).digest('hex'), String(b.length).padStart(7), 'bytes', String(b.toString('utf8').length).padStart(7), 'chars', f); }
  process.exit(0);
}
const f = process.argv[2], start = Number(process.argv[3] || 0), len = Number(process.argv[4] || 1e9);
const s = fs.readFileSync(DEP + f, 'utf8');
const part = s.slice(start, start + len);
process.stdout.write(`### ${f} chars ${start}-${start + part.length} of ${s.length}\n` + JSON.stringify(part).slice(1, -1).replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n### END\n');
