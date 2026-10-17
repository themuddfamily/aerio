import { describe, expect, it } from 'vitest'
import { classifyTrackingImage, isHiddenStyle, RemoteContentRecorder, trackingUrlReasons } from './tracking-protection'

describe('tracking image classification', () => {
  it.each([
    ['https://u12.ct.sendgrid.net/wf/open?upn=abc', ['known-tracker-host', 'tracking-path']],
    ['https://example.us1.list-manage.com/track/open.php?u=1', ['known-tracker-host', 'tracking-path']],
    ['https://mailtrack.io/trace/mail/abc.png', ['known-tracker-host']],
    ['https://news.example/email/open.gif?id=7', ['tracking-path']],
    ['https://news.example/e/o.gif', ['tracking-path']],
    ['https://news.example/track?id=7', ['tracking-path']],
    ['https://news.example/images/hero.png', []],
    ['https://notsendgrid.net/hero.png', []],
    ['cid:logo', []],
    ['not a url', []]
  ])('classifies %s by URL text alone', (src, reasons) => {
    expect(trackingUrlReasons(src)).toEqual(reasons)
  })

  it('flags invisible dimensions without flagging ordinary small images', () => {
    expect(classifyTrackingImage({ src: 'https://a.example/x.png', width: 1, height: 1 }).reasons).toEqual(['tiny-dimensions'])
    expect(classifyTrackingImage({ src: 'https://a.example/x.png', width: 1 }).reasons).toEqual(['tiny-dimensions'])
    expect(classifyTrackingImage({ src: 'https://a.example/x.png', width: 600, height: 1 }).tracker).toBe(false)
    expect(classifyTrackingImage({ src: 'https://a.example/icon.png', width: 16, height: 16 }).tracker).toBe(false)
    expect(classifyTrackingImage({ src: 'cid:pixel', width: 1, height: 1 })).toEqual({ tracker: false, host: '', reasons: [] })
  })

  it('recognizes hidden image styles', () => {
    expect(isHiddenStyle('display: none !important')).toBe(true)
    expect(isHiddenStyle('visibility:hidden')).toBe(true)
    expect(isHiddenStyle('opacity: 0')).toBe(true)
    expect(isHiddenStyle('width:1px;height:1px')).toBe(true)
    expect(isHiddenStyle('max-height:0')).toBe(true)
    expect(isHiddenStyle('opacity:0.5;width:120px;border:0')).toBe(false)
    expect(isHiddenStyle('broken;:;')).toBe(false)
    expect(isHiddenStyle(undefined)).toBe(false)
  })

  it('groups findings by host and counts every remote image', () => {
    const recorder = new RemoteContentRecorder()
    recorder.recordImage(classifyTrackingImage({ src: 'https://images.example/hero.png', width: 600, height: 300 }))
    recorder.recordImage(classifyTrackingImage({ src: 'https://t.example/open.gif', width: 1, height: 1 }))
    recorder.recordImage(classifyTrackingImage({ src: 'https://t.example/x.png', style: 'display:none' }))
    expect(recorder.report()).toEqual({
      remoteImages: 3,
      trackers: [{ host: 't.example', reasons: ['tiny-dimensions', 'tracking-path', 'hidden-style'], count: 2 }]
    })
  })
})
