import {
  CalendarClock, Check, CheckCircle2, ChevronDown, Circle, GripVertical, ListTodo, Plus,
  Repeat2, Search, Trash2
} from 'lucide-react'
import { format, isBefore, isToday, parseISO } from 'date-fns'
import { useMemo, useState } from 'react'
import Modal from '../components/Modal'
import { uid } from '../lib/domain'
import type { AppState, Task } from '../types'

interface TasksViewProps {
  state: AppState
  query: string
  onChange(next: AppState): void
  onToast(message: string): void
}

export default function TasksView({ state, query, onChange, onToast }: TasksViewProps) {
  const [list, setList] = useState('Today')
  const [showCompleted, setShowCompleted] = useState(true)
  const [editing, setEditing] = useState<Task | 'new' | null>(null)
  const lists = ['Today', 'This week', 'Someday']
  const completedPercent = state.tasks.length ? Math.round(state.tasks.filter((task) => task.completed).length / state.tasks.length * 100) : 0
  const tasks = useMemo(() => state.tasks
    .filter((task) => list === 'All tasks' || task.listId === list)
    .filter((task) => showCompleted || !task.completed)
    .filter((task) => !query || `${task.title} ${task.notes ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(a.completed) - Number(b.completed) || (a.due ?? '9999').localeCompare(b.due ?? '9999')),
  [list, query, showCompleted, state.tasks])

  const toggleTask = (id: string) => {
    onChange({ ...state, tasks: state.tasks.map((task) => task.id === id ? { ...task, completed: !task.completed } : task) })
  }

  const moveTask = (dragId: string, targetId: string) => {
    const source = state.tasks.findIndex((task) => task.id === dragId)
    const target = state.tasks.findIndex((task) => task.id === targetId)
    if (source < 0 || target < 0 || source === target) return
    const next = [...state.tasks]
    const [item] = next.splice(source, 1)
    next.splice(target, 0, item)
    onChange({ ...state, tasks: next })
  }

  return (
    <div className="workspace">
      <aside className="context-sidebar">
        <button className="compose-button" onClick={() => setEditing('new')}><Plus size={18} /> New task</button>
        <div className="sidebar-group">
          <span className="sidebar-label">Smart lists</span>
          <button className={`sidebar-item ${list === 'All tasks' ? 'active' : ''}`} onClick={() => setList('All tasks')}><ListTodo size={17} /><span>All tasks</span><em>{state.tasks.filter((task) => !task.completed).length}</em></button>
          {lists.map((item) => (
            <button className={`sidebar-item ${list === item ? 'active' : ''}`} key={item} onClick={() => setList(item)}>
              {item === 'Today' ? <CalendarClock size={17} /> : item === 'This week' ? <CheckCircle2 size={17} /> : <Circle size={17} />}
              <span>{item}</span><em>{state.tasks.filter((task) => task.listId === item && !task.completed).length}</em>
            </button>
          ))}
        </div>
        <div className="task-progress-card">
          <div className="progress-ring" style={{ '--progress': `${completedPercent}%` } as React.CSSProperties}>
            <span>{completedPercent}%</span>
          </div>
          <div><strong>Nice rhythm</strong><p>{state.tasks.filter((task) => task.completed).length} of {state.tasks.length} tasks complete</p></div>
        </div>
      </aside>
      <section className="module-panel tasks-panel">
        <header className="module-header">
          <div><h1>{list}</h1><p>{tasks.filter((task) => !task.completed).length} still open</p></div>
          <label className="check-label"><input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} /> Show completed</label>
        </header>
        <div className="tasks-date-banner">
          <div><span>{format(new Date(), 'EEEE')}</span><strong>{format(new Date(), 'd')}</strong></div>
          <p><strong>{format(new Date(), 'MMMM yyyy')}</strong><span>Make a little space for what matters.</span></p>
        </div>
        <div className="task-list">
          {tasks.map((task) => {
            const overdue = task.due && isBefore(parseISO(task.due), new Date()) && !isToday(parseISO(task.due)) && !task.completed
            return (
              <div className={`task-row ${task.completed ? 'completed' : ''}`} key={task.id} draggable onDragStart={(event) => event.dataTransfer.setData('text/task', task.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => moveTask(event.dataTransfer.getData('text/task'), task.id)}>
                <GripVertical className="drag-handle" size={16} />
                <button className={`task-check ${task.completed ? 'checked' : ''}`} aria-label={task.completed ? `Reopen ${task.title}` : `Complete ${task.title}`} onClick={() => toggleTask(task.id)}>{task.completed && <Check size={15} />}</button>
                <button className="task-main" onClick={() => setEditing(task)}>
                  <span><strong>{task.title}</strong>{task.notes && <small>{task.notes}</small>}</span>
                  <span className="task-meta">
                    {task.due && <em className={overdue ? 'overdue' : ''}><CalendarClock size={13} /> {isToday(parseISO(task.due)) ? format(parseISO(task.due), 'HH:mm') : format(parseISO(task.due), 'd MMM')}</em>}
                    {task.recurrence && task.recurrence !== 'none' && <em><Repeat2 size={13} /> {task.recurrence}</em>}
                    {task.subtasks.length > 0 && <em>{task.subtasks.filter((item) => item.completed).length}/{task.subtasks.length} subtasks</em>}
                  </span>
                </button>
                <span className={`priority-dot ${task.priority}`} title={`${task.priority} priority`} />
              </div>
            )
          })}
          {tasks.length === 0 && <div className="empty-state grow"><Search size={30} /><h3>Nothing on this list</h3><p>A small pocket of calm.</p></div>}
        </div>
      </section>
      {editing && (
        <TaskEditor
          task={editing === 'new' ? undefined : editing}
          defaultList={list === 'All tasks' ? 'Today' : list}
          onClose={() => setEditing(null)}
          onSave={(task) => {
            const exists = state.tasks.some((item) => item.id === task.id)
            onChange({ ...state, tasks: exists ? state.tasks.map((item) => item.id === task.id ? task : item) : [task, ...state.tasks] })
            setEditing(null)
            onToast(exists ? 'Task updated' : 'Task created')
          }}
          onDelete={editing === 'new' ? undefined : () => {
            onChange({ ...state, tasks: state.tasks.filter((task) => task.id !== editing.id) })
            setEditing(null)
            onToast('Task deleted')
          }}
        />
      )}
    </div>
  )
}

function TaskEditor({ task, defaultList, onClose, onSave, onDelete }: { task?: Task; defaultList: string; onClose(): void; onSave(task: Task): void; onDelete?(): void }) {
  const [title, setTitle] = useState(task?.title ?? '')
  const [notes, setNotes] = useState(task?.notes ?? '')
  const [listId, setListId] = useState(task?.listId ?? defaultList)
  const [due, setDue] = useState(task?.due ? format(parseISO(task.due), "yyyy-MM-dd'T'HH:mm") : '')
  const [priority, setPriority] = useState<Task['priority']>(task?.priority ?? 'normal')
  const [recurrence, setRecurrence] = useState<Task['recurrence']>(task?.recurrence ?? 'none')
  const [subtasks, setSubtasks] = useState(task?.subtasks ?? [])
  const [newSubtask, setNewSubtask] = useState('')
  return (
    <Modal title={task ? 'Edit task' : 'New task'} onClose={onClose}>
      <div className="form-stack">
        <label className="field-label">Task<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" /></label>
        <div className="form-grid-2">
          <label className="field-label">List<select value={listId} onChange={(e) => setListId(e.target.value)}><option>Today</option><option>This week</option><option>Someday</option></select></label>
          <label className="field-label">Due<input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <label className="field-label">Priority<select value={priority} onChange={(e) => setPriority(e.target.value as Task['priority'])}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label>
          <label className="field-label">Repeat<select value={recurrence} onChange={(e) => setRecurrence(e.target.value as Task['recurrence'])}><option value="none">Never</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        </div>
        <label className="field-label">Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <div className="subtask-editor">
          <span className="field-label">Subtasks</span>
          {subtasks.map((subtask) => <label key={subtask.id}><input type="checkbox" checked={subtask.completed} onChange={() => setSubtasks((items) => items.map((item) => item.id === subtask.id ? { ...item, completed: !item.completed } : item))} /><span>{subtask.title}</span><button aria-label={`Remove ${subtask.title}`} onClick={() => setSubtasks((items) => items.filter((item) => item.id !== subtask.id))}><Trash2 size={14} /></button></label>)}
          <div><input value={newSubtask} onChange={(e) => setNewSubtask(e.target.value)} placeholder="Add a subtask" onKeyDown={(e) => {
            if (e.key === 'Enter' && newSubtask.trim()) {
              setSubtasks((items) => [...items, { id: uid('subtask'), title: newSubtask.trim(), completed: false }])
              setNewSubtask('')
            }
          }} /><button className="button ghost small" onClick={() => { if (newSubtask.trim()) { setSubtasks((items) => [...items, { id: uid('subtask'), title: newSubtask.trim(), completed: false }]); setNewSubtask('') } }}>Add</button></div>
        </div>
        <footer className="modal-footer">
          {onDelete && <button className="button danger-subtle" onClick={onDelete}><Trash2 size={16} /> Delete</button>}
          <span className="spacer" /><button className="button ghost" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={!title.trim()} onClick={() => onSave({
            id: task?.id ?? uid('task'), listId, title: title.trim(), notes,
            due: due ? new Date(due).toISOString() : undefined, priority, completed: task?.completed ?? false, subtasks, recurrence
          })}>Save task</button>
        </footer>
      </div>
    </Modal>
  )
}
