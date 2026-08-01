import '@fontsource-variable/inter'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ContextMenuProvider } from './components/ContextMenu'
import MessageWindow from './views/MessageWindow'
import './styles.css'

const Root = new URLSearchParams(window.location.search).get('view') === 'message' ? MessageWindow : App

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ContextMenuProvider><Root /></ContextMenuProvider>
  </React.StrictMode>
)
