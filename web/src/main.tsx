import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Preview } from './Preview'
import './styles.css'
import './admin.css'

// `/p/<secreto>` es la vista previa para clientes: no carga el estudio ni pide sesión.
const share = /^\/p\/([\w-]{20,64})\/?$/.exec(location.pathname)
createRoot(document.getElementById('root')!).render(share ? <Preview token={share[1]} /> : <App />)
