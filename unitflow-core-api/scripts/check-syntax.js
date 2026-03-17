const { execSync } = require('node:child_process');
const { readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

function files(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files(full, acc);
    else if (full.endsWith('.js')) acc.push(full);
  }
  return acc;
}

for (const file of files(join(process.cwd(), 'src')).concat(files(join(process.cwd(), 'tests')))) {
  execSync(`node --check "${file}"`, { stdio: 'inherit' });
}
