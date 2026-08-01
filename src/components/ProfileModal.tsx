import { Camera, Trash2, UserRound } from 'lucide-react'
import { useState } from 'react'
import type { UserProfile } from '../types'
import Modal from './Modal'

interface ProfileModalProps {
  profile: UserProfile
  onSave(profile: UserProfile): void
  onClose(): void
  onToast(message: string): void
}

function initials(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'A'
}

export default function ProfileModal({ profile, onSave, onClose, onToast }: ProfileModalProps) {
  const [displayName, setDisplayName] = useState(profile.displayName)
  const [email, setEmail] = useState(profile.email ?? '')
  const [avatarDataUrl, setAvatarDataUrl] = useState(profile.avatarDataUrl)
  const [choosingImage, setChoosingImage] = useState(false)

  const chooseImage = async () => {
    setChoosingImage(true)
    try {
      const image = await window.aerio.chooseProfileImage()
      if (image) setAvatarDataUrl(image)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The profile picture could not be opened')
    } finally {
      setChoosingImage(false)
    }
  }

  const save = () => {
    const name = displayName.trim()
    if (!name) {
      onToast('Add a display name')
      return
    }
    onSave({ displayName: name, email: email.trim() || undefined, avatarDataUrl })
    onToast('Profile updated')
    onClose()
  }

  return (
    <Modal title="Your Aerio profile" subtitle="Personalise how Aerio represents you on this device." width="medium" onClose={onClose}>
      <div className="profile-editor">
        <section className="profile-picture-editor">
          <span className="profile-preview">
            {avatarDataUrl ? <img src={avatarDataUrl} alt="Profile" /> : <strong>{initials(displayName)}</strong>}
          </span>
          <div>
            <h3>Profile picture</h3>
            <p>Choose a PNG, JPEG, or WebP image. Aerio stores a small local copy.</p>
            <span className="profile-picture-actions">
              <button className="button ghost small" disabled={choosingImage} onClick={() => void chooseImage()}><Camera size={15} /> {choosingImage ? 'Choosing…' : avatarDataUrl ? 'Change picture' : 'Add picture'}</button>
              {avatarDataUrl && <button className="button ghost small danger" onClick={() => setAvatarDataUrl(undefined)}><Trash2 size={15} /> Remove</button>}
            </span>
          </div>
        </section>
        <label className="field"><span>Display name</span><input autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name" /></label>
        <label className="field"><span>Profile email <small>optional</small></span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
        <div className="profile-info"><UserRound size={17} /><span><strong>Local Aerio profile</strong><small>This does not change the names or pictures attached to your connected email accounts.</small></span></div>
        <footer className="modal-footer"><button className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={!displayName.trim()} onClick={save}>Save profile</button></footer>
      </div>
    </Modal>
  )
}
