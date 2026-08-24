import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createConfiguredRoomTransport } from './transport/create-room-transport'
import './styles.css'

const params = new URLSearchParams(window.location.search)
const transport = createConfiguredRoomTransport(params.get('transport'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App transport={transport} />
  </StrictMode>,
)
