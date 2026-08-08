const namedHtmlEntities: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  bull: '\u2022',
  copy: '\u00a9',
  euro: '\u20ac',
  gt: '>',
  hellip: '\u2026',
  ldquo: '\u201c',
  lsquo: '\u2018',
  lt: '<',
  mdash: '\u2014',
  middot: '\u00b7',
  nbsp: '\u00a0',
  ndash: '\u2013',
  pound: '\u00a3',
  quot: '"',
  rdquo: '\u201d',
  reg: '\u00ae',
  rsquo: '\u2019',
  trade: '\u2122',
  yen: '\u00a5'
}

function codePointFromEntity(entity: string, digits: string, radix: number) {
  const codePoint = Number.parseInt(digits, radix)
  const isUnicodeScalar = Number.isInteger(codePoint)
    && codePoint >= 0
    && codePoint <= 0x10ffff
    && (codePoint < 0xd800 || codePoint > 0xdfff)

  return isUnicodeScalar ? String.fromCodePoint(codePoint) : entity
}

/** Decode provider-generated HTML entities while leaving unknown entities intact. */
export function decodeHtmlEntities(value: string) {
  if (!value.includes('&')) return value

  return value
    .replace(/&#x([0-9a-f]+);/gi, (entity, digits: string) => codePointFromEntity(entity, digits, 16))
    .replace(/&#([0-9]+);/g, (entity, digits: string) => codePointFromEntity(entity, digits, 10))
    .replace(/&([a-z][a-z0-9]+);/gi, (entity, name: string) => namedHtmlEntities[name.toLowerCase()] ?? entity)
}
