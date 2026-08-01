import { Mail } from 'lucide-react'
import { FcGoogle } from 'react-icons/fc'
import { FaYahoo } from 'react-icons/fa6'
import { SiIcloud, SiProtonmail } from 'react-icons/si'
import type { MailProviderId } from '../gmail-types'

interface Props {
  provider: MailProviderId
  size?: number
}

const FASTMAIL_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAMAAAC7IEhfAAAAsVBMVEXf4eXf4eXf4eUAZ7lps+f/////wQeHv+c4hsS60+bR2+SZu9fJ2OUOcL1/vOdwtuez0Oakyua1yt2Ls9VwpM8qfsHD0uDv9vv/+/A4kNIdesQUdMH/zz3vuxLP4/K/2e6v0OliruSPveBVpd6As9xgoNP/89FAjcswhMb/8MEHbLz/7LIQba4gcqMweJj/5JNAfo3/4INgiXb/2GSPnmSAlGCvpT+/qzTPsCj/ySb/xRdYQ6lwAAAAAnRSTlO/EAh5bysAAAEqSURBVDjLrdVnk8IgEIBh72ADpDejnnq9997+/w873QkcBEgcx/ej84xpm81ob7S/QSuGbjjphtsWljUnGK/LHliNidY48sCGk068ccEoIVZJZMOKOKu6MCKeIhM2iQ/OYwNynzs4YTqsPOx2RikVGsT79/3YddeHdFX6D0v8OQg+THcOQNfFCtYtDL4etLM7ghYWCnIJg+WrdBcTkJApSFq47vMeH8kxYBSzILZ8JuRqAi4YtlD2fopoEC4u0Qwe+gXFIPy5gR7IFXybgg2ZdcN/7wAcsOg+wsUUnDA2hyJ5AjttKOR8z8+op9wY3Bn1xYwJDzOfy0IFMeGDovu65r4TVFAmMptlwrVSQmZdR+hZUiLVWZr3rL24YO2fFfH2i3S3S3y08efjD7y7G4p6Gb2YAAAAAElFTkSuQmCC'

function MicrosoftLogo({ size }: { size: number }) {
  const gap = Math.max(1, Math.round(size * 0.08))
  const tile = (size - gap) / 2
  return <span className="microsoft-provider-logo" style={{ width: size, height: size, gap }} aria-hidden="true">
    <i style={{ width: tile, height: tile, background: '#f25022' }} />
    <i style={{ width: tile, height: tile, background: '#7fba00' }} />
    <i style={{ width: tile, height: tile, background: '#00a4ef' }} />
    <i style={{ width: tile, height: tile, background: '#ffb900' }} />
  </span>
}

export default function ProviderLogo({ provider, size = 24 }: Props) {
  if (provider === 'gmail') return <FcGoogle size={size} aria-hidden="true" />
  if (provider === 'microsoft') return <MicrosoftLogo size={size} />
  if (provider === 'icloud') return <SiIcloud size={size} color="#3693f3" aria-hidden="true" />
  if (provider === 'yahoo') return <FaYahoo size={size} color="#6001d2" aria-hidden="true" />
  if (provider === 'fastmail') return <img className="fastmail-provider-logo" width={size} height={size} src={FASTMAIL_ICON} alt="" aria-hidden="true" />
  if (provider === 'proton-bridge') return <SiProtonmail size={size} color="#6d4aff" aria-hidden="true" />
  return <Mail size={size} aria-hidden="true" />
}
