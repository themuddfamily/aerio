import '@fontsource-variable/inter'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ContextMenuProvider } from './components/ContextMenu'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ContextMenuProvider><App /></ContextMenuProvider>
  </React.StrictMode>
)
