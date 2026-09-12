'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUTPUT = path.join(ROOT, '_site');
const PUBLISHED_FILES = Object.freeze([
  'ui/index.html',
  'ui/app.js',
  'ui/styles.css',
  'ui/aggregate.html',
  'ui/aggregate.js',
  'ui/aggregate.css',
  'runs/20260906-t05/manifest.json',
  'runs/20260906-t05/negative.json',
]);

function buildPages(outputRoot = DEFAULT_OUTPUT) {
  const destination = path.resolve(outputRoot);
  if (destination === path.resolve(ROOT)) throw new Error('Pages output cannot replace the repository root');

  if (destination === path.resolve(DEFAULT_OUTPUT)) {
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
      throw new Error('Pages output cannot be a symbolic link');
    }
    fs.rmSync(destination, { recursive: true, force: true });
  } else if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
    throw new Error('The custom Pages output directory must be empty');
  }
  fs.mkdirSync(destination, { recursive: true });

  for (const relativePath of PUBLISHED_FILES) {
    const target = path.join(destination, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relativePath), target);
  }

  fs.writeFileSync(path.join(destination, '.nojekyll'), '');
  return destination;
}

if (require.main === module) {
  console.log(`Built GitHub Pages site at ${buildPages()}`);
}

module.exports = { buildPages };
