import { ImagePlus, Plus, Star, Trash2 } from 'lucide-react'
import type { ContactField } from '../types'
import { CONTACT_FIELD_LIMIT, CONTACT_PHOTO_MAX_CHARS, isContactPhoto } from '../lib/contact-fields'

interface ContactFieldListProps {
  label: string
  itemLabel: string
  fields: ContactField[]
  types: readonly string[]
  inputType?: string
  placeholder?: string
  onChange(fields: ContactField[]): void
}

// Typed rows for emails, phones, or postal addresses. A star marks the preferred (primary) value.
export function ContactFieldList({ label, itemLabel, fields, types, inputType = 'text', placeholder, onChange }: ContactFieldListProps) {
  const update = (index: number, patch: Partial<ContactField>) => onChange(fields.map((field, position) => position === index ? { ...field, ...patch } : field))
  const typeOptions = (current?: string) => current && !types.includes(current) ? [...types, current] : types
  return (
    <fieldset className="contact-field-list">
      <legend>{label}</legend>
      {fields.map((field, index) => (
        <div className="contact-field-row" key={index}>
          <select aria-label={`${index ? `${itemLabel} ${index + 1}` : itemLabel} type`} value={field.type ?? ''} onChange={(event) => update(index, { type: event.target.value || undefined })}>
            <option value="">No label</option>
            {typeOptions(field.type).map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          {/* Editing the text of a structured address drops the old parts; the new text is sent as written. */}
          <input aria-label={index ? `${itemLabel} ${index + 1}` : itemLabel} type={inputType} value={field.value} placeholder={placeholder}
            onChange={(event) => update(index, { value: event.target.value, parts: undefined })} />
          <button type="button" className={`icon-button ${field.preferred ? 'active' : ''}`} title="Make primary" aria-pressed={Boolean(field.preferred)}
            onClick={() => onChange(fields.map((item, position) => ({ ...item, preferred: position === index ? !field.preferred : false })))}><Star size={14} /></button>
          <button type="button" className="icon-button danger" title={`Remove ${label.toLowerCase()}`} onClick={() => onChange(fields.filter((_, position) => position !== index))}><Trash2 size={14} /></button>
        </div>
      ))}
      <button type="button" className="button ghost small" disabled={fields.length >= CONTACT_FIELD_LIMIT} onClick={() => onChange([...fields, { value: '', type: types[0] }])}>
        <Plus size={14} /> Add {itemLabel}
      </button>
    </fieldset>
  )
}

// Downsizes a picked picture to a 128px JPEG so it stays well inside the stored photo bound.
async function photoFromFile(file: File): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('That picture could not be read'))
    reader.readAsDataURL(file)
  })
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('unreadable'))
      element.src = original
    })
    const canvas = document.createElement('canvas')
    const size = 128
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) throw new Error('unavailable')
    const scale = Math.max(size / image.width, size / image.height)
    context.drawImage(image, (size - image.width * scale) / 2, (size - image.height * scale) / 2, image.width * scale, image.height * scale)
    return canvas.toDataURL('image/jpeg', 0.85)
  } catch {
    return original
  }
}

export function ContactPhotoPicker({ photo, name, color, disabled, onChange, onError }: {
  photo?: string
  name: string
  color: string
  disabled?: boolean
  onChange(photo: string | undefined): void
  onError(message: string): void
}) {
  return (
    <div className="contact-photo-picker">
      {photo ? <img className="avatar large contact-photo" src={photo} alt="" /> : <span className="avatar large" style={{ background: color }}>{name.split(' ').map((value) => value[0]).join('').slice(0, 2) || '?'}</span>}
      <label className={`button ghost small ${disabled ? 'disabled' : ''}`}>
        <ImagePlus size={14} /> {photo ? 'Change photo' : 'Add photo'}
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden disabled={disabled} onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          void photoFromFile(file).then((value) => {
            if (!isContactPhoto(value)) onError(`Choose a PNG, JPEG, GIF, or WebP picture under ${Math.floor(CONTACT_PHOTO_MAX_CHARS * 0.75 / 1024)} KB`)
            else onChange(value)
          }).catch((error: unknown) => onError(error instanceof Error ? error.message : 'That picture could not be read'))
        }} />
      </label>
      {photo && !disabled && <button type="button" className="button ghost small" onClick={() => onChange(undefined)}>Remove</button>}
    </div>
  )
}
