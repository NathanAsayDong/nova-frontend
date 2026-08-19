import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FacePage } from './FacePage'
import './face.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FacePage />
  </StrictMode>,
)
