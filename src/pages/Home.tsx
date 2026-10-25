import { Link } from 'react-router-dom'
import { Zap, Shield, Clock, ArrowRight, Users } from 'lucide-react'
import { ConnectKitButton } from 'connectkit'
import { useAccount } from 'wagmi'
import { CHAIN, VAULT_ADDRESS, explorerAddr } from '@/lib/vault'

const glass = {
  card: {
    background: 'var(--surface-strong)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    border: '1px solid var(--border)',
    borderRadius: '1.5rem',
  } as React.CSSProperties,
}

function Feature({ icon: Icon, title, body }: { icon: React.ElementType; title: string; body: string }) {
  return (
    <div className="flex gap-3 p-4" style={{ ...glass.card }}>
      <div
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl"
        style={{ background: 'rgba(18,45,69,0.08)' }}
      >
        <Icon className="size-4" style={{ color: 'var(--accent)' }} />
      </div>
      <div>
        <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{title}</p>
        <p className="mt-0.5 text-xs text-pretty" style={{ color: 'var(--muted)' }}>{body}</p>
      </div>
    </div>
  )
}

export default function Home() {
  const { isConnected } = useAccount()

  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      {/* Hero */}
      <div className="mb-8 text-center">
        <div
          className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl"
          style={{ background: 'var(--accent)' }}
        >
          <Zap className="size-8" style={{ color: '#fff' }} />
        </div>
        <h1
          className="display mb-2 text-4xl font-bold tracking-tight text-balance"
          style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}
        >
          Payrun
        </h1>
        <p className="mx-auto max-w-xs text-base text-pretty" style={{ color: 'var(--muted)' }}>
          Scheduled multi-recipient USDC payroll on Arc. No admin, no fees, no surprises.
        </p>
      </div>

      {/* CTA */}
      <div className="mb-8 flex flex-col items-center gap-3">
        {isConnected ? (
          <Link
            to="/new"
            className="flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
            style={{ background: 'var(--accent)' }}
          >
            Create a Payrun <ArrowRight className="size-4" />
          </Link>
        ) : (
          <div className="w-full">
            <ConnectKitButton.Custom>
              {({ show }) => (
                <button
                  onClick={show}
                  className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
                  style={{ background: 'var(--accent)' }}
                >
                  Connect Wallet to Start
                </button>
              )}
            </ConnectKitButton.Custom>
          </div>
        )}

        <div className="flex items-center gap-4">
          <Link
            to="/me"
            className="text-sm font-medium transition-opacity hover:opacity-80"
            style={{ color: 'var(--accent)' }}
          >
            My runs
          </Link>
          <span style={{ color: 'var(--border-strong)' }}>|</span>
          <Link
            to="/keepers"
            className="text-sm font-medium transition-opacity hover:opacity-80"
            style={{ color: 'var(--accent)' }}
          >
            Earn tips as a keeper
          </Link>
        </div>
      </div>

      {/* Features */}
      <div className="mb-8 grid gap-3">
        <Feature
          icon={Shield}
          title="Non-custodial payroll"
          body="USDC is locked in the vault when you create a run. No intermediary holds your funds."
        />
        <Feature
          icon={Clock}
          title="Scheduled releases"
          body="Each line has a due date. Anyone can release it once the time comes, earning the tip you set."
        />
        <Feature
          icon={Users}
          title="Up to 50 recipients per run"
          body="Batch up to 50 payment lines in a single transaction, up to 500 USDC total."
        />
      </div>

      {/* Footer links */}
      <div className="text-center text-xs" style={{ color: 'var(--subtle)' }}>
        <span>Vault on {CHAIN.name}: </span>
        <a
          href={explorerAddr(VAULT_ADDRESS)}
          target="_blank"
          rel="noopener noreferrer"
          className="mono font-medium underline underline-offset-2 transition-opacity hover:opacity-70"
          style={{ color: 'var(--muted)' }}
        >
          {VAULT_ADDRESS.slice(0, 6)}…{VAULT_ADDRESS.slice(-4)}
        </a>
      </div>
    </div>
  )
}
