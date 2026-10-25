import { Component, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Home from './pages/Home'
import NewRun from './pages/NewRun'
import RunDetail from './pages/RunDetail'
import MyRuns from './pages/MyRuns'
import Keepers from './pages/Keepers'

// ── Error boundary ─────────────────────────────────────────────────────────────

interface EBState { error: Error | null }

class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): EBState {
    return { error }
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-dvh items-center justify-center px-4">
          <div
            className="max-w-md rounded-2xl p-6 text-center"
            style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
          >
            <p className="mb-2 text-lg font-semibold" style={{ color: 'var(--danger)' }}>
              Something went wrong
            </p>
            <p className="mb-4 text-sm" style={{ color: 'var(--muted)' }}>
              {this.state.error.message}
            </p>
            <button
              onClick={() => this.setState({ error: null })}
              className="rounded-xl px-4 py-2 text-sm font-semibold"
              style={{ background: 'var(--accent)', color: 'var(--bg)' }}
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="new" element={<NewRun />} />
            <Route path="run/:id" element={<RunDetail />} />
            <Route path="me" element={<MyRuns />} />
            <Route path="keepers" element={<Keepers />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
