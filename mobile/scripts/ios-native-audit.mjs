import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = resolve(import.meta.dirname, '..'), artifacts = join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options });
if (process.platform !== 'darwin') throw new Error('iOS native validation requires macOS and Xcode.');
const env = { ...process.env, EXPO_PUBLIC_NATIVE_AUDIT: '1', CI: '1' };
run(process.execPath, ['node_modules/expo/bin/cli', 'prebuild', '--platform', 'ios', '--no-install'], { env, stdio: 'inherit' });
run('pod', ['install', '--project-directory=ios'], { env, stdio: 'inherit' });
run('xcodebuild', ['-workspace', 'ios/Aerio.xcworkspace', '-scheme', 'Aerio', '-configuration', 'Release', '-sdk', 'iphonesimulator', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', 'build/ios', 'CODE_SIGNING_ALLOWED=NO', 'ONLY_ACTIVE_ARCH=YES'], { env, stdio: 'inherit' });
const app = join(root, 'build/ios/Build/Products/Release-iphonesimulator/Aerio.app');
if (!existsSync(app)) throw new Error('Xcode did not produce Aerio.app.');
const runtimes = JSON.parse(run('xcrun', ['simctl', 'list', 'runtimes', '--json'])).runtimes.filter((item) => item.isAvailable && item.identifier.includes('.iOS-')).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
const types = JSON.parse(run('xcrun', ['simctl', 'list', 'devicetypes', '--json'])).devicetypes.filter((item) => item.name.startsWith('iPhone'));
if (!runtimes.length || !types.length) throw new Error('Install an iOS Simulator runtime.');
const udid = run('xcrun', ['simctl', 'create', `Aerio-CI-${randomUUID()}`, types.at(-1).identifier, runtimes[0].identifier]).trim();
try {
  run('xcrun', ['simctl', 'boot', udid]); run('xcrun', ['simctl', 'bootstatus', udid, '-b'], { stdio: 'inherit' });
  run('xcrun', ['simctl', 'install', udid, app]); run('xcrun', ['simctl', 'launch', udid, 'dev.aerio.mobile']);
  const container = run('xcrun', ['simctl', 'get_app_container', udid, 'dev.aerio.mobile', 'data']).trim();
  const report = join(container, 'Documents/aerio-native-audit.json');
  const deadline = Date.now() + 120000;
  while (!existsSync(report) && Date.now() < deadline) await new Promise((resolveReady) => setTimeout(resolveReady, 1000));
  if (!existsSync(report)) throw new Error('The simulator app did not produce its native integration report.');
  const result = JSON.parse(readFileSync(report, 'utf8')); writeFileSync(join(artifacts, 'ios-native-audit.json'), JSON.stringify(result, null, 2));
  if (!result.passed || result.platform !== 'ios') throw new Error(`iOS native integration failed: ${JSON.stringify(result)}`);
  cpSync(app, join(artifacts, 'Aerio-audit.app'), { recursive: true });
  console.log('iOS native application compiled and ran: SQLCipher, keychain, offline restart, lock guard and uncertain-send recovery passed.');
} finally {
  try { writeFileSync(join(artifacts, 'ios-simulator.log'), run('xcrun', ['simctl', 'spawn', udid, 'log', 'show', '--last', '3m', '--predicate', 'process == "Aerio"'])); } catch {}
  try { run('xcrun', ['simctl', 'shutdown', udid]); } catch {}
  run('xcrun', ['simctl', 'delete', udid]);
}
