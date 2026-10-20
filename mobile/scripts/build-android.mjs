import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { resolve, join, isAbsolute, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
const source = resolve(import.meta.dirname, '..');
const architectures = process.env.AERIO_ANDROID_ARCH?.split(',');
if (architectures?.some((name) => !['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'].includes(name))) throw new Error('AERIO_ANDROID_ARCH must contain only known Android architecture names separated by commas.');
let root = source;
// Some dependency-generated C++ filenames exceed Ninja's Windows limit even with
// CMAKE_OBJECT_PATH_MAX. Build in a real short checkout, not a subst/junction path.
if (process.platform === 'win32') {
  if (!process.env.AERIO_ANDROID_BUILD_ROOT) throw new Error('Set AERIO_ANDROID_BUILD_ROOT to a dedicated short directory such as C:\\am. This avoids Windows native C++ path limits.');
  root = resolve(process.env.AERIO_ANDROID_BUILD_ROOT);
  if (!isAbsolute(root) || root.length > 10 || root === resolve('/') || root === source) throw new Error('Choose a dedicated Windows build directory with an absolute path of at most 10 characters, such as C:\\am.');
  const marker = join(root, '.aerio-build-workspace');
  if (existsSync(root) && !existsSync(marker)) throw new Error('The build directory already exists without an Aerio marker. Choose a new empty path.');
  if (existsSync(marker) && (lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8').toLowerCase() !== source.toLowerCase())) throw new Error('This build workspace belongs to a different checkout.');
  if (existsSync(root) && realpathSync.native(root).toLowerCase() !== root.toLowerCase()) throw new Error('Use a real short build directory, not a junction, symlink or substituted drive.');
  mkdirSync(root, { recursive: true }); writeFileSync(marker, source);
  for (const name of ['src', 'plugins', 'assets']) {
    const target = resolve(root, name);
    if (relative(root, target) !== name || target === root || !target.toLowerCase().startsWith(`${root}${sep}`.toLowerCase())) throw new Error('Unexpected owned build subtree.');
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink() || !realpathSync.native(target).toLowerCase().startsWith(`${realpathSync.native(root)}${sep}`.toLowerCase())) throw new Error('An owned build subtree points outside the build workspace.');
      rmSync(target, { recursive: true, force: true });
    }
  }
  for (const name of ['package.json', 'package-lock.json', 'app.json', 'app.config.ts', 'tsconfig.json', 'src', 'plugins', 'assets']) cpSync(join(source, name), join(root, name), { recursive: true });
}
const run = (command, args, options = {}) => { const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env, ...options }); if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.message}).`); };
if (root !== source) {
  if (!process.env.npm_execpath) throw new Error('Invoke this script through npm run build:android.');
  run(process.execPath, [process.env.npm_execpath, 'ci', '--no-audit', '--no-fund']);
}
run(process.execPath, [join(root, 'node_modules/expo/bin/cli'), 'prebuild', '--platform', 'android', '--no-install']);
const args = [':app:assembleRelease', '--no-daemon', ...(process.env.AERIO_ANDROID_ARCH ? [`-PreactNativeArchitectures=${process.env.AERIO_ANDROID_ARCH}`] : [])];
if (process.platform === 'win32') run('cmd.exe', ['/d', '/s', '/c', 'gradlew.bat', ...args], { cwd: join(root, 'android') });
else run('./gradlew', args, { cwd: join(root, 'android') });
const apk = join(root, 'android/app/build/outputs/apk/release/app-release.apk');
const artifacts = join(source, 'artifacts'); mkdirSync(artifacts, { recursive: true });
const name = process.env.EXPO_PUBLIC_NATIVE_AUDIT === '1' ? 'Aerio-native-audit.apk' : 'Aerio-android.apk';
cpSync(apk, join(artifacts, name));
writeFileSync(join(artifacts, 'android-build.json'), JSON.stringify({ apk: name, sha256: createHash('sha256').update(readFileSync(apk)).digest('hex'), auditBuild: process.env.EXPO_PUBLIC_NATIVE_AUDIT === '1', builtAt: new Date().toISOString(), note: 'Local test signing only. Use EAS production credentials for store distribution.' }, null, 2));
