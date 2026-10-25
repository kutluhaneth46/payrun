import { NavLink, Outlet } from 'react-router-dom'
import { ConnectKitButton } from 'connectkit'
import { useAccount, useSwitchChain } from 'wagmi'
import { AlertTriangle, Zap, List, User, Search } from 'lucide-react'
import { TARGET_CHAIN_ID, CHAIN } from '@/lib/vault'

// ── Wrong-network banner ──────────────────────────────────────────────────────
function WrongNetworkBanner() {
  const { chainId, isConnected } = useAccount()
  const { switchChain, isPending } = useSwitchChain()
  if (!isConnected || chainId === TARGET_CHAIN_ID) return null
  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm font-medium"
      style={{
        background: 'rgba(186, 43, 76, 0.12)',
        borderBottom: '1px solid rgba(186,43,76,0.25)',
        color: 'var(--danger)',
      }}
    >
      <span className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0" />
        Wrong network — this app runs on {CHAIN.name}.
      </span>
      <button
        onClick={() => switchChain({ chainId: TARGET_CHAIN_ID })}
        disabled={isPending}
        className="shrink-0 rounded-lg px-3 py-1 text-xs font-semibold transition-opacity disabled:opacity-50"
        style={{ background: 'var(--danger)', color: '#fff' }}
      >
        {isPending ? 'Switching…' : `Switch to ${CHAIN.name}`}
      </button>
    </div>
  )
}

// ── Nav item ─────────────────────────────────────────────────────────────────
function NavItem({ to, icon: Icon, label }: { to: string; icon: React.ElementType; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [
          'flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-all',
          isActive
            ? 'font-semibold'
            : 'opacity-60 hover:opacity-90',
        ].join(' ')
      }
      style={({ isActive }) => ({
        background: isActive ? 'var(--surface-strong)' : 'transparent',
        color: 'var(--ink)',
        border: isActive ? '1px solid var(--border)' : '1px solid transparent',
      })}
    >
      <Icon className="size-3.5" />
      {label}
    </NavLink>
  )
}

// ── Layout ────────────────────────────────────────────────────────────────────
export default function Layout() {
  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      <WrongNetworkBanner />

      {/* Header */}
      <header
        className="sticky top-0 z-40 flex items-center justify-between gap-3 px-4 py-3"
        style={{
          background: 'var(--surface)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {/* Logo */}
        <NavLink to="/" className="flex items-center gap-2">
          <div
            className="flex size-7 items-center justify-center rounded-lg"
            style={{ background: 'var(--accent)' }}
          >
            <Zap className="size-4" style={{ color: '#fff' }} />
          </div>
          <span className="display text-base font-bold tracking-tight" style={{ color: 'var(--ink)' }}>
            Payrun
          </span>
        </NavLink>

        {/* Nav */}
        <nav className="hidden items-center gap-1 sm:flex">
          <NavItem to="/new"      icon={Zap}    label="New Run"  />
          <NavItem to="/me"       icon={User}   label="My Runs"  />
          <NavItem to="/keepers"  icon={Search} label="Keepers"  />
        </nav>

        {/* Connect */}
        <ConnectKitButton />
      </header>

      {/* Mobile nav */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t px-2 py-2 sm:hidden"
        style={{
          background: 'var(--surface)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          borderColor: 'var(--border)',
        }}
      >
        <MobileNavItem to="/"        icon={List}   label="Home"     />
        <MobileNavItem to="/new"     icon={Zap}    label="New"      />
        <MobileNavItem to="/me"      icon={User}   label="Mine"     />
        <MobileNavItem to="/keepers" icon={Search} label="Keepers"  />
      </nav>

      {/* Page content */}
      <main className="pb-24 sm:pb-8">
        <Outlet />
      </main>
    </div>
  )
}

function MobileNavItem({ to, icon: Icon, label }: { to: string; icon: React.ElementType; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        [
          'flex flex-col items-center gap-0.5 rounded-xl px-4 py-1.5 text-xs font-medium transition-all',
          isActive ? 'font-semibold' : 'opacity-50',
        ].join(' ')
      }
      style={{ color: 'var(--ink)' }}
    >
      <Icon className="size-5" />
      {label}
    </NavLink>
  )
}
