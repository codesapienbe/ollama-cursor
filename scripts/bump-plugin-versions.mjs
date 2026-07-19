import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) {
    throw new Error(`Unsupported semantic version: ${version}`);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return `${major}.${minor}.${patch + 1}`;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const packageJsonPath = resolve(repoRoot, 'package.json');
const packageLockPath = resolve(repoRoot, 'package-lock.json');
const intellijGradlePropertiesPath = resolve(repoRoot, 'intellij-plugin', 'gradle.properties');

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const previousVsCodeVersion = packageJson.version;
const nextVsCodeVersion = bumpPatch(previousVsCodeVersion);
packageJson.version = nextVsCodeVersion;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8'));
packageLock.version = nextVsCodeVersion;
if (!packageLock.packages || !packageLock.packages['']) {
  throw new Error('Could not find root package metadata in package-lock.json');
}
packageLock.packages[''].version = nextVsCodeVersion;
writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

const gradleProperties = readFileSync(intellijGradlePropertiesPath, 'utf8');
const intellijVersionMatch = gradleProperties.match(/^pluginVersion\s*=\s*(\d+\.\d+\.\d+)\s*$/m);
if (!intellijVersionMatch) {
  throw new Error('Could not find pluginVersion in intellij-plugin/gradle.properties');
}

const previousIntellijVersion = intellijVersionMatch[1];
const nextIntellijVersion = bumpPatch(previousIntellijVersion);
const updatedGradleProperties = gradleProperties.replace(
  /^pluginVersion\s*=\s*(\d+\.\d+\.\d+)\s*$/m,
  `pluginVersion = ${nextIntellijVersion}`,
);
writeFileSync(intellijGradlePropertiesPath, updatedGradleProperties);

console.log(`VS Code plugin version: ${previousVsCodeVersion} -> ${nextVsCodeVersion}`);
console.log(`IntelliJ plugin version: ${previousIntellijVersion} -> ${nextIntellijVersion}`);
