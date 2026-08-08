import { useEffect, useRef } from 'react'

interface MessageHtmlProps {
  className?: string
  html: string
}

/** Render message markup and expose each link destination through its native tooltip. */
export default function MessageHtml({ className = '', html }: MessageHtmlProps) {
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bodyRef.current?.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
      const destination = link.getAttribute('href')?.trim()
      if (destination) link.title = destination
    })
  }, [html])

  return <div ref={bodyRef} className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
