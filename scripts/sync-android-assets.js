const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePublic = path.join(root, 'public');
const sourceShared = path.join(root, 'shared', 'domain.js');
const target = path.join(root, 'android', 'app', 'src', 'main', 'assets');

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

fs.rmSync(target, { recursive: true, force: true });
copyDirectory(sourcePublic, target);
fs.mkdirSync(path.join(target, 'shared'), { recursive: true });
fs.copyFileSync(sourceShared, path.join(target, 'shared', 'domain.js'));
console.log(`Android assets synced to ${target}`);
