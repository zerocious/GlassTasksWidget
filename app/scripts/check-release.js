'use strict';

/**
 * Pre-publish check of electron-builder output: would electron-updater actually find,
 * download and verify this release?
 *
 *   node scripts/check-release.js [dist-folder]      (default: ./dist)
 *
 * Exit code 0 = safe to publish, 1 = something would break auto-update or the install.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const dist = path.resolve(process.argv[2] || path.join(APP_ROOT, 'dist'));
const problems = [];
const fail = (msg) => problems.push(msg);

/** Tiny reader for the flat YAML electron-builder writes (no dependency needed). */
function parseLatestYml(text) {
  const out = { files: [] };
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    let m;
    if ((m = line.match(/^files:\s*$/))) continue;
    if ((m = line.match(/^\s+-\s+url:\s*(.+)$/))) {
      current = { url: m[1].trim() };
      out.files.push(current);
    } else if (current && (m = line.match(/^\s{4}(sha512|size):\s*(.+)$/))) {
      current[m[1]] = m[1] === 'size' ? Number(m[2]) : m[2].trim();
    } else if ((m = line.match(/^([A-Za-z]+):\s*(.+)$/))) {
      current = null;
      out[m[1]] = m[2].replace(/^'|'$/g, '').trim();
    }
  }
  return out;
}

function sha512Base64(file) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(file));
  return hash.digest('base64');
}

const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
const latestPath = path.join(dist, 'latest.yml');

if (!fs.existsSync(latestPath)) {
  console.error(`✖ ${latestPath} not found: build with "electron-builder --win nsis" first`);
  process.exit(1);
}
const latest = parseLatestYml(fs.readFileSync(latestPath, 'utf8'));

if (latest.version !== pkg.version) fail(`latest.yml version ${latest.version} != package.json ${pkg.version}`);
if (!latest.files.length) fail('latest.yml lists no files');

for (const entry of latest.files) {
  const file = path.join(dist, entry.url);
  if (/\s/.test(entry.url)) fail(`url "${entry.url}" contains spaces`);
  if (!fs.existsSync(file)) {
    fail(`latest.yml points to "${entry.url}", which is not in ${dist} (GitHub would 404 on download)`);
    continue;
  }
  const size = fs.statSync(file).size;
  if (entry.size !== size) fail(`${entry.url}: size ${size} != latest.yml ${entry.size}`);
  if (entry.sha512 !== sha512Base64(file)) fail(`${entry.url}: sha512 differs from latest.yml (updater would reject it)`);
  if (!fs.existsSync(`${file}.blockmap`)) fail(`${entry.url}.blockmap is missing (differential updates would fall back to a full download)`);
}
if (latest.path && !latest.files.some((f) => f.url === latest.path)) fail(`latest.yml "path" ${latest.path} is not among its files`);

// What the installed app reads to know where to look for updates.
const appUpdate = path.join(dist, 'win-unpacked', 'resources', 'app-update.yml');
if (fs.existsSync(appUpdate)) {
  const text = fs.readFileSync(appUpdate, 'utf8');
  const repo = pkg.build && pkg.build.publish && pkg.build.publish[0];
  if (repo && !(text.includes(`owner: ${repo.owner}`) && text.includes(`repo: ${repo.repo}`))) {
    fail(`app-update.yml does not point to ${repo.owner}/${repo.repo}`);
  }
} else {
  fail('win-unpacked/resources/app-update.yml is missing: the installed app could not check for updates');
}

if (problems.length) {
  console.error(`✖ ${problems.length} problem(s) in ${dist}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
const names = latest.files.map((f) => f.url).join(', ');
console.log(`✔ release ${latest.version} is consistent: ${names} (size, sha512, blockmap, updater target)`);
