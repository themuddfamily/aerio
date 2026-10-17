# Inbox category tabs

Inbox tabs split the Inbox into **Primary**, **Social**, **Promotions**,
**Updates**, **Forums**, and up to ten tabs of your own. Each conversation in
the Inbox appears in exactly one tab. Tabs only apply to the Inbox: Starred,
Sent, Archive, labels, folders, and saved searches outside the Inbox always
show every conversation.

A conversation's inbox category is classification metadata that Aerio keeps
on its own. It is stored apart from:

- **Message-local tags and links** (`message-local.sqlite`), which you add to
  individual messages; and
- **Outlook categories** and Gmail user labels, which stay visible labels on
  the conversation and keep synchronizing as before.

Changing a tab never adds, removes, or renames a tag, an Outlook category, or a
user label.

## Using the tabs

- The tab strip sits above the conversation list whenever the Inbox is open
  (for one account or **All accounts**) and at least one tab besides Primary is
  turned on. Each tab shows its number of unread conversations. In
  **All accounts**, the counts add up every account, and the tab lists show the
  conversations from every account.
- Pinned conversations still list first inside each tab, then the rest newest
  first. Search and filters work inside the current tab.
- Snoozed and Trash conversations are not counted, matching the Inbox count.

### Keyboard

- The tab strip is a single tab stop. With it focused, **Left** and **Right**
  move to the previous or next tab (wrapping around), and **Home** and **End**
  jump to the first or last tab. Moving selects the tab.
- From anywhere in Mail outside a text field or dialog, **Alt+Right** and
  **Alt+Left** select the next or previous tab, and **Alt+1** to **Alt+9**
  select a tab by position.

### Configuring tabs

**Settings › Inbox tabs** lists every tab in order:

- Turn a tab on or off with its checkbox. Primary cannot be turned off. Mail
  that belongs to a turned-off tab (or to a custom tab you removed) shows in
  Primary; it is not lost or reclassified, and it returns to its tab when the
  tab is turned on again.
- Rename any tab, reorder tabs with the arrow buttons, and **Add tab** for a
  custom tab (for example "Receipts"). Custom tabs are filled by moving
  conversations to them, by sender/domain rules, and by mail rules.
- **Save tabs** stores the configuration. The defaults match Gmail: Primary,
  Social, Promotions, and Updates on, Forums off.

## How a conversation is classified

Aerio decides a conversation's tab from the newest message you received in it
(your own replies and drafts are ignored, so replying never moves a
conversation). The first source that has an answer wins:

1. **Manual move** — you moved this conversation with **Move to inbox tab…**.
2. **Mail rule** — a mail rule's **Set inbox category** action. A rule never
   replaces your own manual move.
3. **Sender rule** — a classification rule for the exact sender address, then
   for the sender's domain. A domain rule also covers subdomains
   (`shop.example` matches `news.shop.example`); the most specific domain wins.
4. **Provider category** — Gmail or Outlook's own classification (see below).
5. **Aerio's classifier** — a local heuristic (see below).
6. **Primary**, when nothing else applies.

Each conversation records which source decided it; the **Move to inbox tab**
dialog shows it ("now: Provider category", "now: Moved by you", and so on).

### Synchronized categories: Gmail

Gmail's category labels are read on every sync and map one to one:
`CATEGORY_PERSONAL` → Primary, `CATEGORY_SOCIAL` → Social,
`CATEGORY_PROMOTIONS` → Promotions, `CATEGORY_UPDATES` → Updates, and
`CATEGORY_FORUMS` → Forums. These labels are not shown as visible labels.

### Synchronized categories: Outlook (Microsoft 365 and Outlook.com)

Aerio requests Microsoft Graph's `inferenceClassification` for Inbox messages.
Outlook only has two values, so the mapping rule is:

- **Focused** → Primary.
- **Other** → the category Aerio's classifier picks for the message when that
  is not Primary (so a newsletter in Other lands in Promotions and a LinkedIn
  notification in Social), and **Updates** otherwise.

Messages downloaded before this feature carry no Focused/Other value until
Outlook reports a change for them, or until **Rebuild local copy** downloads
the account again; meanwhile Aerio's classifier is used.

### Local categories: IMAP, iCloud, Yahoo, Fastmail, Proton Bridge, Local Folders

These accounts have no provider categories, so Aerio's local classifier decides
(after manual moves and rules). It runs on this computer when a message is
downloaded and looks at:

- known social networks (Facebook, LinkedIn, X/Twitter, Instagram, Reddit,
  Discord, and others) → Social;
- known notification services (GitHub, GitLab, Atlassian, Slack, payment and
  shipping services), `Auto-Submitted` automatic mail, and no-reply or
  notification senders without an unsubscribe link → Updates;
- discussion lists (`List-Id` together with `List-Post`, Google Groups,
  groups.io, Discourse) → Forums;
- bulk mail (`List-Unsubscribe`, `Precedence: bulk` or `list`, `List-Id`, or
  bulk-sending services) → Promotions;
- everything else → Primary.

Imported messages and conversations cached before the upgrade are classified
from the sender address alone, because their headers are not re-read.

## Reclassifying

**Move to inbox tab…** is in the conversation context menu, and **Tab** is in
the selection toolbar for checked conversations. Choose a tab, or
**Automatic** to drop your manual choice and let rules, the provider, and the
classifier decide again.

- **Always do this.** When the selected conversations share a sender (or a
  domain), you can also choose **Always for mail from this sender** or
  **Always for mail from this sender's domain**. This saves a sender rule,
  which classifies existing and future mail from that sender in every account.
- **Provider updates.** For Gmail and Outlook accounts, moving to a built-in
  tab also updates the provider through the normal queued mail-change pipeline
  (it works offline and retries like other changes):
  - Gmail: the matching `CATEGORY_*` label is added and the other category
    labels are removed, so Gmail on the web and phone shows the same tab.
  - Outlook: Inbox messages are set to Focused (Primary) or Other (every other
    tab) with a Graph `PATCH` of `inferenceClassification`. Outlook's own
    "always move" sender overrides are not created; Aerio's sender rule covers
    future mail in Aerio.
  Custom tabs, IMAP and other local-classification accounts, and read-only
  (archived) accounts are changed in Aerio only.
- Moving a conversation is per conversation: it applies to every message in
  it, including new replies.

### Sender and domain rules

**Settings › Inbox tabs › Sender and domain rules** lists every rule. Change a
rule's tab with its menu, remove it with the trash button, or add one by
choosing **Domain** or **Sender address**, typing it, and choosing a tab.
Rules are shared by all accounts and survive removing an account.

### Mail rules

The rules editor (Mail › Rules) has:

- a condition **Inbox category is …**, which matches the tab the conversation
  is in when the rule runs; and
- an action **Set inbox category**, which moves matching conversations to a
  tab (local only — no provider operation is queued).

When a rule is uploaded as a Gmail filter, the condition becomes Gmail's
`category:` search and the action Gmail's "Categorize as" (both marked
approximate because Gmail checks its own category, not Aerio's); custom tabs
cannot be uploaded. Outlook server rules cannot use either, so such rules stay
local.

## Storage, resync, and backup

Classification lives in the mail database, keyed by account and the
conversation's stable provider thread id, like pins:

| Table | Contents |
| --- | --- |
| `mail_inbox_tabs` | Tab order, names, and on/off state |
| `mail_category_rules` | Sender address and domain rules |
| `mail_category_overrides` | Manual moves and mail-rule assignments per conversation |
| `mail_category_signals` | Per-conversation sender, provider category, and classifier result (derived, rebuilt on sync) |
| `mail_category_hints` | The header-based classifier result for each downloaded message |

- **Resync and rebuild.** Manual moves are not tied to the cached conversation
  row, so a resync or **Rebuild local copy** that drops and downloads a
  conversation again keeps its tab. The derived signals are recomputed from
  the new copy.
- **Accounts.** Archiving an account keeps its classification; deleting its
  local data removes its manual moves (sender rules stay).
- **Profile backups** include tabs, rules, and manual moves with the mail
  database; the restore preview lists the number of classification rules and
  of conversations moved between tabs.
