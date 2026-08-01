import type { AppState } from './types'

const now = new Date()
const at = (dayOffset: number, hour: number, minute = 0) => {
  const date = new Date(now)
  date.setDate(now.getDate() + dayOffset)
  date.setHours(hour, minute, 0, 0)
  return date.toISOString()
}

export function createDemoState(): AppState {
  return {
    schemaVersion: 1,
    accounts: [
      { id: 'personal', name: 'Personal', email: 'alex@aerio.app', initials: 'AA', color: '#6659e8', provider: 'demo' },
      { id: 'studio', name: 'Northstar Studio', email: 'alex@northstar.design', initials: 'NS', color: '#e8875b', provider: 'demo' }
    ],
    folders: [
      { id: 'personal-inbox', accountId: 'personal', name: 'Inbox', system: 'inbox' },
      { id: 'personal-drafts', accountId: 'personal', name: 'Drafts', system: 'drafts' },
      { id: 'personal-sent', accountId: 'personal', name: 'Sent', system: 'sent' },
      { id: 'personal-archive', accountId: 'personal', name: 'Archive', system: 'archive' },
      { id: 'personal-trash', accountId: 'personal', name: 'Trash', system: 'trash' },
      { id: 'studio-inbox', accountId: 'studio', name: 'Inbox', system: 'inbox' },
      { id: 'studio-drafts', accountId: 'studio', name: 'Drafts', system: 'drafts' },
      { id: 'studio-sent', accountId: 'studio', name: 'Sent', system: 'sent' },
      { id: 'studio-archive', accountId: 'studio', name: 'Archive', system: 'archive' },
      { id: 'studio-trash', accountId: 'studio', name: 'Trash', system: 'trash' },
      { id: 'studio-projects', accountId: 'studio', name: 'Projects' },
      { id: 'studio-finance', accountId: 'studio', name: 'Finance' }
    ],
    messages: [
      {
        id: 'm1', threadId: 't1', accountId: 'studio', folderId: 'studio-inbox', from: 'Maya Chen',
        fromEmail: 'maya@northstar.design', to: ['alex@northstar.design'], subject: 'The new identity feels exactly right',
        preview: 'The client loved the refined direction. I added their final notes to the board…',
        body: `<p>Hi Alex,</p><p>The client loved the refined direction. I added their final notes to the board, and there are only two tiny typography changes left.</p><p>Could you take a final look before our 2pm review? I’ve attached the presentation we’ll use.</p><p>Brilliant work on this one.<br/>Maya</p>`,
        date: at(0, 9, 42), unread: true, starred: true, flagged: false, labels: ['Design'], attachments: [{ id: 'a1', name: 'Aperture_Final_Review.pdf', size: 4823000, mime: 'application/pdf' }]
      },
      {
        id: 'm2', threadId: 't2', accountId: 'personal', folderId: 'personal-inbox', from: 'Jon Bell',
        fromEmail: 'jon@fieldnotes.co', to: ['alex@aerio.app'], subject: 'Weekend escape — I found the perfect place',
        preview: 'Remember that cabin I mentioned? It just opened up for the first weekend in August…',
        body: `<p>Hey!</p><p>Remember that cabin I mentioned? It just opened up for the first weekend in August. Big windows, a wood stove, and absolutely no mobile signal.</p><p>I’ve sent the details below. Shall I book it tonight?</p><p>Jon</p>`,
        date: at(0, 8, 17), unread: true, starred: false, flagged: false, labels: ['Personal'], attachments: []
      },
      {
        id: 'm3', threadId: 't3', accountId: 'studio', folderId: 'studio-inbox', from: 'Stripe',
        fromEmail: 'notifications@stripe.com', to: ['alex@northstar.design'], subject: 'Your June payout is on its way',
        preview: 'A payout of £8,420.00 is expected to arrive in your bank account…',
        body: `<p>Your payout is on its way.</p><h2>£8,420.00</h2><p>Expected arrival: Wednesday. You can view the full breakdown in your dashboard.</p>`,
        date: at(-1, 17, 8), unread: false, starred: false, flagged: false, labels: ['Finance'], attachments: []
      },
      {
        id: 'm4', threadId: 't4', accountId: 'personal', folderId: 'personal-inbox', from: 'The Modern House',
        fromEmail: 'journal@themodernhouse.com', to: ['alex@aerio.app'], subject: 'At home with makers: a quiet London studio',
        preview: 'This week, we visit ceramicist Lina Moreau in her light-filled south London home…',
        body: `<p>This week in the Journal: an intimate visit with ceramicist Lina Moreau, a guide to Margate’s best independent shops, and five homes shaped by their gardens.</p>`,
        date: at(-1, 7, 30), unread: false, starred: true, flagged: false, labels: ['Reading'], attachments: []
      },
      {
        id: 'm5', threadId: 't5', accountId: 'studio', folderId: 'studio-inbox', from: 'Elliot Reed',
        fromEmail: 'elliot@reedarchitecture.com', to: ['alex@northstar.design'], subject: 'Re: Website structure and case studies',
        preview: 'This is shaping up beautifully. A few thoughts on the project sequence…',
        body: `<p>This is shaping up beautifully. A few thoughts on the project sequence: could we lead with Waverley House, then move the civic work directly after it?</p><p>I’ve left comments in the prototype.</p>`,
        date: at(-2, 15, 26), unread: false, starred: false, flagged: true, labels: ['Client'], attachments: []
      },
      {
        id: 'm6', threadId: 't6', accountId: 'personal', folderId: 'personal-inbox', from: 'Aerio Weekly',
        fromEmail: 'hello@aerio.app', to: ['alex@aerio.app'], subject: 'Your week, gently organised',
        preview: 'You cleared 84% of your inbox and protected three focus blocks…',
        body: `<p>A quieter week at a glance.</p><p>You cleared <strong>84%</strong> of your inbox, completed 12 tasks, and protected three focus blocks.</p><p>Keep the rhythm going.</p>`,
        date: at(-3, 10, 0), unread: false, starred: false, flagged: false, labels: ['Aerio'], attachments: []
      }
    ],
    events: [
      { id: 'e1', calendarId: 'studio', title: 'Aperture final review', start: at(0, 14), end: at(0, 15), location: 'Studio · Meeting room', description: 'Final identity presentation.', color: '#6659e8', attendees: ['maya@northstar.design', 'hello@aperture.co'], reminderMinutes: 15, recurrence: 'none' },
      { id: 'e2', calendarId: 'personal', title: 'Morning run', start: at(1, 7, 30), end: at(1, 8, 15), color: '#4ca683', attendees: [], reminderMinutes: 10, recurrence: 'weekly' },
      { id: 'e3', calendarId: 'studio', title: 'Portfolio deep work', start: at(1, 10), end: at(1, 12, 30), color: '#e8875b', attendees: [], reminderMinutes: 10, recurrence: 'none' },
      { id: 'e4', calendarId: 'personal', title: 'Dinner with Priya', start: at(2, 19), end: at(2, 21), location: 'Brunswick House', color: '#d26791', attendees: ['priya@example.com'], reminderMinutes: 60, recurrence: 'none' },
      { id: 'e5', calendarId: 'studio', title: 'Team planning', start: at(3, 9, 30), end: at(3, 10, 30), color: '#5b8def', attendees: ['maya@northstar.design', 'sam@northstar.design'], reminderMinutes: 15, recurrence: 'weekly' }
    ],
    contacts: [
      { id: 'c1', name: 'Maya Chen', email: 'maya@northstar.design', phone: '+44 7700 900123', company: 'Northstar Studio', title: 'Creative Director', group: 'Team', favorite: true, color: '#8a6de9', notes: 'Prefers concise project updates.' },
      { id: 'c2', name: 'Elliot Reed', email: 'elliot@reedarchitecture.com', phone: '+44 20 7946 0182', company: 'Reed Architecture', title: 'Founder', group: 'Clients', favorite: true, color: '#4d9f86' },
      { id: 'c3', name: 'Jon Bell', email: 'jon@fieldnotes.co', phone: '+44 7700 900456', company: 'Field Notes', title: 'Editor', group: 'Friends', favorite: false, color: '#e18a65' },
      { id: 'c4', name: 'Priya Shah', email: 'priya@example.com', phone: '+44 7700 900789', company: 'Independent', title: 'Photographer', group: 'Friends', favorite: true, color: '#d26791' },
      { id: 'c5', name: 'Sam Okafor', email: 'sam@northstar.design', company: 'Northstar Studio', title: 'Designer', group: 'Team', favorite: false, color: '#5b8def' },
      { id: 'c6', name: 'Lena Hoffmann', email: 'lena@aperture.co', company: 'Aperture', title: 'Marketing Lead', group: 'Clients', favorite: false, color: '#b579d7' }
    ],
    tasks: [
      { id: 'task1', listId: 'Today', title: 'Review Aperture typography changes', due: at(0, 12), priority: 'high', completed: false, subtasks: [{ id: 'st1', title: 'Check mobile lockup', completed: true }, { id: 'st2', title: 'Export final marks', completed: false }], recurrence: 'none' },
      { id: 'task2', listId: 'Today', title: 'Send June invoices', due: at(0, 16), priority: 'normal', completed: false, subtasks: [], recurrence: 'monthly' },
      { id: 'task3', listId: 'This week', title: 'Book weekend cabin', due: at(1, 18), priority: 'normal', completed: false, subtasks: [], recurrence: 'none' },
      { id: 'task4', listId: 'This week', title: 'Outline Reed Architecture case study', due: at(3, 17), priority: 'high', completed: false, subtasks: [], recurrence: 'none' },
      { id: 'task5', listId: 'Someday', title: 'Research standing desks for studio', priority: 'low', completed: false, subtasks: [], recurrence: 'none' },
      { id: 'task6', listId: 'Today', title: 'Reply to printer proofs', due: at(-1, 17), priority: 'normal', completed: true, subtasks: [], recurrence: 'none' }
    ],
    notes: [
      { id: 'n1', folder: 'Studio', title: 'Aperture launch thoughts', content: 'The identity should feel precise without becoming clinical.\n\nLaunch sequence\n• Teaser animation\n• Founder story\n• Case study\n• Toolkit download', tags: ['aperture', 'launch'], pinned: true, archived: false, updatedAt: at(0, 8), color: '#f0eefe' },
      { id: 'n2', folder: 'Personal', title: 'Books for summer', content: 'Orbital — Samantha Harvey\nThe Creative Act — Rick Rubin\nSmall Things Like These — Claire Keegan', tags: ['reading'], pinned: true, archived: false, updatedAt: at(-1, 20), color: '#fff3df' },
      { id: 'n3', folder: 'Studio', title: 'Website workshop', content: 'Questions for the workshop:\n\n1. What should a visitor understand in ten seconds?\n2. Which project best expresses the practice now?\n3. What should someone feel after browsing?', tags: ['workshop', 'web'], pinned: false, archived: false, updatedAt: at(-2, 13) },
      { id: 'n4', folder: 'Ideas', title: 'A calmer inbox', content: 'Design principle: every surface should make the next action obvious without demanding attention.', tags: ['aerio', 'product'], pinned: false, archived: false, updatedAt: at(-4, 10), color: '#e4f4ee' }
    ],
    conversations: [
      { id: 'chat1', name: 'Maya Chen', participants: ['Maya Chen'], color: '#8a6de9', online: true, unread: 2, messages: [
        { id: 'cm1', sender: 'them', text: 'Morning! The Aperture feedback just landed.', time: at(0, 9, 5) },
        { id: 'cm2', sender: 'them', text: 'Really positive — only two tiny type changes 🎉', time: at(0, 9, 6), reaction: '✨' },
        { id: 'cm3', sender: 'me', text: 'Perfect. I’ll have a look before lunch.', time: at(0, 9, 12) }
      ]},
      { id: 'chat2', name: 'Northstar team', participants: ['Maya Chen', 'Sam Okafor', 'Alex Avery'], color: '#5b8def', online: true, unread: 0, messages: [
        { id: 'cm4', sender: 'them', text: 'I’ve moved tomorrow’s planning session to 9:30.', time: at(-1, 16, 20) },
        { id: 'cm5', sender: 'me', text: 'Works for me. I’ll bring the portfolio outline.', time: at(-1, 16, 34) }
      ]},
      { id: 'chat3', name: 'Jon Bell', participants: ['Jon Bell'], color: '#e18a65', online: false, unread: 1, messages: [
        { id: 'cm6', sender: 'them', text: 'Cabin link is in your inbox. It looks unreal.', time: at(0, 8, 18) }
      ]}
    ],
    settings: {
      theme: 'system',
      density: 'comfortable',
      closeToTray: true,
      notifications: true,
      startModule: 'mail',
      signature: 'Alex Avery\nNorthstar Studio',
      profile: { displayName: 'Alex Avery', email: 'alex@aerio.app' }
    }
  }
}
