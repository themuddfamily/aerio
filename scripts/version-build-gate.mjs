import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

const manifests = JSON.parse(process.env.VERSION_MANIFESTS ?? '["package.json"]')
if (!Array.isArray(manifests) || !manifests.length || manifests.some((path) => !['package.json', 'mobile/package.json'].includes(path))) throw new Error('Unsupported version manifest')

let shouldBuild = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
if (process.env.GITHUB_EVENT_NAME === 'push') {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const before = event.before, after = process.env.GITHUB_SHA
  if (!/^[a-f0-9]{40,64}$/.test(before ?? '') || !/^[a-f0-9]{40,64}$/.test(after ?? '')) throw new Error('A push commit range is required')
  // A new branch/package has no previous version to bump. Do not launch builds.
  if (!/^0+$/.test(before)) {
    const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git(['cat-file', '-e', `${before}^{commit}`])
    git(['cat-file', '-e', `${after}^{commit}`])
    for (const path of manifests) {
      let previous
      try { previous = git(['show', `${before}:${path}`]) } catch { continue }
      const oldVersion = JSON.parse(previous).version
      const newVersion = JSON.parse(git(['show', `${after}:${path}`])).version
      if (typeof oldVersion !== 'string' || !oldVersion || typeof newVersion !== 'string' || !newVersion) throw new Error(`Missing package version in ${path}`)
      if (oldVersion !== newVersion) {
        shouldBuild = true
        console.log(`${path}: version changed from ${oldVersion} to ${newVersion}`)
      }
    }
  }
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `should_build=${shouldBuild}\n`)
console.log(shouldBuild ? 'Builds permitted by a version change or explicit manual run.' : 'Builds skipped: no package version changed.')
