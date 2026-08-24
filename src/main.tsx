import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { LocalRoomTransport } from './transport/local/local-room-transport'
import './styles.css'

const transport = new LocalRoomTransport()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App transport={transport} />
  </StrictMode>,
)
