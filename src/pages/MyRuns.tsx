import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAccount, useReadContract } from 'wagmi'
import { Loader2, ArrowRight } from 'lucide-react'
import { VAULT, TARGET_CHAIN_ID, formatUsdc, statusLabel } from '@/lib/vault'

const glass = {
  card: {
    background: 'var(--surface-strong)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    border: '1px solid var(--border)',
    borderRadius: '1.5rem',
  } as React.CSSProperties,
}

const PAGE = 20

function RunRow({ runId }: { runId: bigint }) {
  const { data: run } = useReadContract({
    address: VAULT.address, abi: VAULT.abi,
    functionName: 'getRun', args: [runId],
    chainId: TARGET_CHAIN_ID,
  })
  const { data: lines } = useReadContract({
    address: VAULT.address, abi: VAULT.abi,
    functionName: 'getLines', args: [runId],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!run },
  })

  const total = lines?.reduce((s, l) => s + l.amount, 0n) ?? 0n
  const pending = lines?.filter(l => l.status === 0).length ?? 0

  return (
    <Link
      to={`/run/${runId.toString()}`}
      className="flex items-center justify-between gap-3 rounded-2xl p-4 transition-opacity hover:opacity-80"
      style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
    >
      <div>
        <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
          Run #{runId.toString()}
        </p>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
          {run?.lineCount ?? '…'} lines · {formatUsdc(total)} USDC · {pending} pending
        </p>
      </div>
      <ArrowRight className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
    </Link>
  )
}

function IncomingLine({ runId, lineIndex }: { runId: bigint; lineIndex: bigint }) {
  const { data: line } = useReadContract({
    address: VAULT.address, abi: VAULT.abi,
    functionName: 'getLine', args: [runId, lineIndex],
    chainId: TARGET_CHAIN_ID,
  })

  const status = line ? statusLabel(line.status) : 'Pending'
  // oxlint-disable-next-line react/purity -- Date.now() used for due status display
  const myNow = Math.floor(Date.now() / 1000)
  const isDue = line && myNow >= Number(line.dueAt)

  return (
    <Link
      to={`/run/${runId.toString()}`}
      className="flex items-center justify-between gap-3 rounded-2xl p-4 transition-opacity hover:opacity-80"
      style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
    >
      <div>
        <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
          Run #{runId.toString()} · Line {lineIndex.toString()}
        </p>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
          {line ? `${formatUsdc(line.amount)} USDC` : '…'} ·{' '}
          <span style={{
            color: status === 'Paid' ? 'var(--success)'
              : status === 'Pending' && isDue ? 'var(--accent)'
              : 'var(--muted)',
          }}>
            {status}{status === 'Pending' && isDue ? ' (due)' : ''}
          </span>
        </p>
      </div>
      <ArrowRight className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
    </Link>
  )
}

export default function MyRuns() {
  const { address, isConnected } = useAccount()
  const [payerOffset, setPayerOffset] = useState(0)
  const [recipOffset, setRecipOffset] = useState(0)

  const { data: payerCount } = useReadContract({
    address: VAULT.address, abi: VAULT.abi,
    functionName: 'runsOfPayerCount', args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!address },
  })

  const { data: payerRuns, isLoading: payerLoading } = useReadContract({
    address: VAULT.address, abi: VAULT.abi,
    functionName: 'runsOfPayer',
    args: [address ?? '0x0000000000000000000000000000000000000000', BigInt(payerOffset), BigInt(PAGE)],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!address },
  })

  const { data: recipCount } = useReadContract({
    address: VAULT.address, abi: VAULT.abi,
    functionName: 'linesOfRecipientCount', args: [address ?? '0x0000000000000000000000000000000000000000'],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!address },
  })

  const { data: recipLines, isLoading: recipLoading } = useReadContract({
    address: VAULT.address, abi: VAULT.abi,
    functionName: 'linesOfRecipient',
    args: [address ?? '0x0000000000000000000000000000000000000000', BigInt(recipOffset), BigInt(PAGE)],
    chainId: TARGET_CHAIN_ID,
    query: { enabled: !!address },
  })

  if (!isConnected) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center text-sm" style={{ color: 'var(--muted)' }}>
        Connect your wallet to see your runs and incoming lines.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      {/* Payer section */}
      <section className="mb-8">
        <h2 className="display mb-3 text-xl font-bold tracking-tight" style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>
          Runs I created
        </h2>
        {payerLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin" style={{ color: 'var(--accent)' }} /></div>
        ) : !payerRuns?.length ? (
          <div className="rounded-2xl p-6 text-center text-sm" style={{ ...glass.card, color: 'var(--muted)' }}>
            No runs yet.{' '}
            <Link to="/new" className="font-medium underline underline-offset-2" style={{ color: 'var(--accent)' }}>
              Create your first run
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {payerRuns.map(id => <RunRow key={id.toString()} runId={id} />)}
            </div>
            {payerCount !== undefined && payerCount > BigInt(PAGE) && (
              <div className="mt-3 flex justify-between text-xs" style={{ color: 'var(--muted)' }}>
                <button
                  onClick={() => setPayerOffset(Math.max(0, payerOffset - PAGE))}
                  disabled={payerOffset === 0}
                  className="disabled:opacity-40"
                >
                  Previous
                </button>
                <span>{payerOffset + 1}–{Math.min(payerOffset + PAGE, Number(payerCount))} of {payerCount.toString()}</span>
                <button
                  onClick={() => setPayerOffset(payerOffset + PAGE)}
                  disabled={payerOffset + PAGE >= Number(payerCount)}
                  className="disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {/* Recipient section */}
      <section>
        <h2 className="display mb-3 text-xl font-bold tracking-tight" style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>
          Incoming lines
        </h2>
        {recipLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin" style={{ color: 'var(--accent)' }} /></div>
        ) : !recipLines?.length ? (
          <div className="rounded-2xl p-6 text-center text-sm" style={{ ...glass.card, color: 'var(--muted)' }}>
            No incoming lines.
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {recipLines.map(ref => (
                <IncomingLine
                  key={`${ref.runId}-${ref.lineIndex}`}
                  runId={ref.runId}
                  lineIndex={ref.lineIndex}
                />
              ))}
            </div>
            {recipCount !== undefined && recipCount > BigInt(PAGE) && (
              <div className="mt-3 flex justify-between text-xs" style={{ color: 'var(--muted)' }}>
                <button
                  onClick={() => setRecipOffset(Math.max(0, recipOffset - PAGE))}
                  disabled={recipOffset === 0}
                  className="disabled:opacity-40"
                >
                  Previous
                </button>
                <span>{recipOffset + 1}–{Math.min(recipOffset + PAGE, Number(recipCount))} of {recipCount.toString()}</span>
                <button
                  onClick={() => setRecipOffset(recipOffset + PAGE)}
                  disabled={recipOffset + PAGE >= Number(recipCount)}
                  className="disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
