import { describe, expect, it } from 'vitest'
import {
  CALDAV_NS, childElement, DAV_NS, DavXmlError, elementText, escapeXml, multigetBody, parseMultistatus, parseXml, prop, propfindBody, propText, syncCollectionBody
} from './dav-xml'

describe('DAV XML reader', () => {
  it('resolves default and prefixed namespaces, including redeclared prefixes', () => {
    const root = parseXml(`<?xml version="1.0"?><!-- server --><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
      <response><href>/a</href><C:calendar-data xmlns:C="urn:example:other">x</C:calendar-data><x:y xmlns:x="${CALDAV_NS}" C:attr="1" plain='2'/></response></multistatus>`)
    expect(root).toMatchObject({ ns: DAV_NS, name: 'multistatus' })
    const response = childElement(root, DAV_NS, 'response')!
    expect(response.children.map((child) => [child.ns, child.name])).toEqual([[DAV_NS, 'href'], ['urn:example:other', 'calendar-data'], [CALDAV_NS, 'y']])
    expect(response.children[2].attributes).toEqual({ '{urn:ietf:params:xml:ns:caldav}attr': '1', plain: '2' })
  })

  it('decodes entities, character references, and CDATA', () => {
    const root = parseXml('<d:a xmlns:d="DAV:">Tom &amp; Jerry &lt;3 &#x1F600;&#65;<![CDATA[<raw> & ]]></d:a>')
    expect(elementText(root)).toBe('Tom & Jerry <3 😀A<raw> &')
  })

  it.each([
    ['<!DOCTYPE x [<!ENTITY a "b">]><x/>', /DOCTYPE/],
    ['<a><b></a>', /mismatched/],
    ['<a>', /ended before/],
    ['<p:a/>', /undeclared XML prefix/],
    ['<a/><b/>', /more than one XML root/],
    ['text', /not XML|outside/],
    ['<a b=c/>', /malformed XML attribute/],
    ['<a><!-- never closed </a>', /unterminated XML comment/]
  ])('rejects malformed or unsafe input %#', (input, error) => {
    expect(() => parseXml(input)).toThrow(DavXmlError)
    expect(() => parseXml(input)).toThrow(error)
  })

  it('enforces depth and size limits', () => {
    expect(() => parseXml('<a><a><a/></a></a>', { maxChars: 1_000, maxDepth: 2, maxElements: 100 })).toThrow(/nested too deeply/)
    expect(() => parseXml('<a><b/><b/></a>', { maxChars: 1_000, maxDepth: 5, maxElements: 2 })).toThrow(/too many/)
    expect(() => parseXml('<a/>', { maxChars: 2, maxDepth: 5, maxElements: 5 })).toThrow(/too large/)
  })

  it('reads multistatus propstats, per-response status, and the sync token', () => {
    const result = parseMultistatus(`<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
      <d:response><d:href>/cal/</d:href>
        <d:propstat><d:prop><d:displayname>Work</d:displayname><cs:getctag>7</cs:getctag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        <d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
      </d:response>
      <d:response><d:href>/cal/gone.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
      <d:response><d:status>HTTP/1.1 200 OK</d:status></d:response>
      <d:sync-token>token-9</d:sync-token></d:multistatus>`)
    expect(result.syncToken).toBe('token-9')
    expect(result.responses).toHaveLength(2)
    const [collection, gone] = result.responses
    expect(propText(collection, DAV_NS, 'displayname')).toBe('Work')
    expect(propText(collection, 'http://calendarserver.org/ns/', 'getctag')).toBe('7')
    expect(prop(collection, DAV_NS, 'getetag')).toBeUndefined()
    expect(collection.propStatus.get('{DAV:}getetag')).toBe(404)
    expect(gone.status).toBe(404)
    expect(() => parseMultistatus('<d:error xmlns:d="DAV:"/>')).toThrow(/multistatus/)
  })

  it('builds request bodies with escaped values that it can read back', () => {
    expect(escapeXml('a<&>"')).toBe('a&lt;&amp;&gt;&quot;')
    expect(parseXml(propfindBody([[DAV_NS, 'getetag'], [CALDAV_NS, 'calendar-home-set']])).children[0].children.map((child) => child.name)).toEqual(['getetag', 'calendar-home-set'])
    const sync = parseXml(syncCollectionBody('a&b', [[DAV_NS, 'getetag']]))
    expect(elementText(childElement(sync, DAV_NS, 'sync-token'))).toBe('a&b')
    expect(elementText(childElement(sync, DAV_NS, 'sync-level'))).toBe('1')
    const multiget = parseXml(multigetBody('addressbook', ['/card/a b.vcf']))
    expect(multiget).toMatchObject({ ns: 'urn:ietf:params:xml:ns:carddav', name: 'addressbook-multiget' })
    expect(multiget.children.filter((child) => child.name === 'href').map(elementText)).toEqual(['/card/a b.vcf'])
  })
})
