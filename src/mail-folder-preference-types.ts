// Display-only folder preferences (E35): favorites, aliases, local icons and
// name colors, and sidebar visibility. None of these change anything on the
// mail provider; they are stored in Aerio's mail database on this computer.

export const MAIL_FOLDER_ICONS = ['folder', 'inbox', 'star', 'flag', 'bookmark', 'briefcase', 'receipt', 'users', 'home', 'heart', 'archive', 'tag'] as const
export type MailFolderIcon = typeof MAIL_FOLDER_ICONS[number]

/** A folder or label pinned into the Favorites section, keyed by account and provider folder id. */
export interface MailFolderFavorite {
  accountId: string
  /** Provider folder/label id (`folder:<path>` for IMAP, `folder:<id>` for Microsoft, the label id for Gmail). */
  labelId: string
  /** 0-based display order across every account. */
  position: number
  /** Display-only name shown in Favorites; never sent to the provider. */
  alias?: string
  /** The folder's name when it was last seen, shown while the folder is unavailable. */
  lastKnownName: string
  addedAt: string
}

/** Local look of one folder. Gmail label colors stay on Gmail and are not stored here. */
export interface MailFolderAppearance {
  accountId: string
  labelId: string
  icon?: MailFolderIcon
  /** Local name color (#rrggbb) for non-Gmail folders. */
  color?: string
  /** Hidden from the sidebar folder tree unless “Show hidden folders” is on. */
  hidden: boolean
}

export interface MailFolderPreferences {
  favorites: MailFolderFavorite[]
  appearance: MailFolderAppearance[]
}

export interface MailFolderReference {
  accountId: string
  labelId: string
}

/** `null` clears a value; an omitted field is left unchanged. */
export interface MailFolderAppearanceInput extends MailFolderReference {
  icon?: MailFolderIcon | null
  color?: string | null
  hidden?: boolean
}

export interface MailFolderPreferencesApi {
  get(): Promise<MailFolderPreferences>
  addFavorite(accountId: string, labelId: string): Promise<MailFolderPreferences>
  /** Removes the favorite only; the folder and its mail are untouched. */
  removeFavorite(accountId: string, labelId: string): Promise<MailFolderPreferences>
  /** Full new order of favorites; favorites left out keep their relative order after the listed ones. */
  reorderFavorites(order: MailFolderReference[]): Promise<MailFolderPreferences>
  setFavoriteAlias(accountId: string, labelId: string, alias: string | null): Promise<MailFolderPreferences>
  setAppearance(input: MailFolderAppearanceInput): Promise<MailFolderPreferences>
}
