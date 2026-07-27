import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { mkdir, writeFile } from 'node:fs/promises'

const svg = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7667f7"/>
      <stop offset="1" stop-color="#4a3ed6"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="228" fill="url(#g)"/>
  <path d="M260 662 439 297c30-61 116-61 146 0l179 365c25 51-12 110-69 110-31 0-59-18-73-46l-26-55H426l-26 55c-14 28-42 46-73 46-57 0-94-59-67-110Zm221-111h58l-29-74-29 74Z" fill="white"/>
  <path d="M334 716c92 58 264 58 356 0" fill="none" stroke="#c8c2ff" stroke-width="26" stroke-linecap="round" opacity=".85"/>
</svg>`

await mkdir('build', { recursive: true })
const sizes = [16, 24, 32, 48, 64, 128, 256]
const buffers = await Promise.all(sizes.map((size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()))
await writeFile('build/icon.png', await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer())
await writeFile('build/icon.ico', await pngToIco(buffers))
