import { useState } from 'react'
import { useAccount, useReadContract, useWriteContract, useSwitchChain, usePublicClient } from 'wagmi'
import { parseEventLogs } from 'viem'
import { Loader2, Zap, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { VAULT, VAULT_DEPLOYED, TARGET_CHAIN_ID, CHAIN, formatUsdc, skipReasonLabel, explorerTx } from '@/lib/vault'
import { decodeVaultError } from '@/lib/errors'

const glass = {
  card: {
    background: 'var(--surface-strong)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    border: '1px solid var(--border)',
    borderRadius: '1.5rem',
  } as React.CSSProperties,
}

// Batch size for multicall paging
const MULTICALL_BATCH = 20

interface DueLine {
  runId: bigint
  lineIndex: bigint
  amount: bigint
  tip: bigint
  recipient: string
  dueAt: bigint
}

interface SkipResult { lineIndex: bigint; reason: number }
interface ReleaseResult { runId: bigint; txHash: string; skips: SkipResult[]; released: number }

function useRunCount() {
  return useReadContract({
    address: VAULT.address, abi: VAULT.abi,
    functionName: 'runCount',
    chainId: TARGET_CHAIN_ID,
    query: { enabled: VAULT_DEPLOYED },
  })
}

export default function Keepers() {
  const { isConnected, chainId } = useAccount()
  const { data: runCount, isLoading: countLoading } = useRunCount()
  const { writeContractAsync } = useWriteContract()
  const { switchChain } = useSwitchChain()
  const publicClient = usePublicClient({ chainId: TARGET_CHAIN_ID })

  const [dueLines, setDueLines]     = useState<DueLine[]>([])
  const [scanning, setScanning]     = useState(false)
  const [scanDone, setScanDone]     = useState(false)
  const [scanProgress, setScanProgress] = useState('')
  const [releasing, setReleasing]   = useState(false)
  const [results, setResults]       = useState<ReleaseResult[]>([])

  const wrongChain = isConnected && chainId !== TARGET_CHAIN_ID

  async function scanForDueLines() {
    if (!runCount || !publicClient) return
    setScanning(true)
    setScanDone(false)
    setDueLines([])
    setResults([])

    const total = Number(runCount)
    const found: DueLine[] = []
    const now = BigInt(Math.floor(Date.now() / 1000))

    try {
      // Page through ALL runs in MULTICALL_BATCH batches using multicall
      for (let start = 1; start <= total; start += MULTICALL_BATCH) {
        const end   = Math.min(start + MULTICALL_BATCH - 1, total)
        const ids   = Array.from({ length: end - start + 1 }, (_, k) => BigInt(start + k))
        setScanProgress(`Scanning runs ${start}–${end} of ${total}…`)

        const calls = ids.map(id => ({
          address: VAULT.address,
          abi: VAULT.abi,
          functionName: 'getLines' as const,
          args: [id] as [bigint],
        }))

        const batch = await publicClient.multicall({ contracts: calls, allowFailure: true })

        for (let k = 0; k < batch.length; k++) {
          const result = batch[k]
          if (result.status !== 'success') continue
          const lines = result.result as Array<{
            recipient: string; dueAt: bigint; status: number; amount: bigint; tip: bigint
          }>
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i]
            if (l.status === 0 && l.dueAt <= now) {
              found.push({
                runId: ids[k], lineIndex: BigInt(i),
                amount: l.amount, tip: l.tip,
                recipient: l.recipient, dueAt: l.dueAt,
              })
            }
          }
        }
      }
      setDueLines(found)
    } catch (err) {
      toast.error('Scan failed: ' + String(err))
    } finally {
      setScanning(false)
      setScanDone(true)
      setScanProgress('')
    }
  }

  // Group by runId for releaseMany
  const grouped = dueLines.reduce<Record<string, { runId: bigint; indices: bigint[] }>>((acc, l) => {
    const key = l.runId.toString()
    if (!acc[key]) acc[key] = { runId: l.runId, indices: [] }
    acc[key].indices.push(l.lineIndex)
    return acc
  }, {})

  async function releaseAll() {
    if (wrongChain) { switchChain({ chainId: TARGET_CHAIN_ID }); return }
    if (!publicClient) return
    setReleasing(true)
    const releaseResults: ReleaseResult[] = []
    try {
      for (const { runId, indices } of Object.values(grouped)) {
        const hash = await writeContractAsync({
          address: VAULT.address, abi: VAULT.abi,
          functionName: 'releaseMany', args: [runId, indices],
          chainId: TARGET_CHAIN_ID,
        })

        // Wait for receipt and decode events
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') {
          toast.error(`releaseMany for run #${runId} reverted.`)
          continue
        }

        const releasedLogs  = parseEventLogs({ abi: VAULT.abi, logs: receipt.logs, eventName: 'LineReleased'  })
        const skippedLogs   = parseEventLogs({ abi: VAULT.abi, logs: receipt.logs, eventName: 'ReleaseSkipped' })
        const skips: SkipResult[] = skippedLogs.map(e => ({
          lineIndex: e.args.lineIndex,
          reason: e.args.reason,
        }))

        releaseResults.push({
          runId,
          txHash:   hash,
          released: releasedLogs.length,
          skips,
        })
      }

      setResults(releaseResults)
      const totalReleased = releaseResults.reduce((s, r) => s + r.released, 0)
      // If only one run was released, link directly to that tx; otherwise link to the vault
      const toastHref = releaseResults.length === 1
        ? explorerTx(releaseResults[0].txHash)
        : `${CHAIN.explorerBase}/address/${VAULT.address}`
      toast.success(`Released ${totalReleased} line${totalReleased !== 1 ? 's' : ''}.`, {
        action: { label: 'Explorer', onClick: () => window.open(toastHref, '_blank') },
      })
      // Clear and re-scan so the list reflects the updated on-chain state
      setDueLines([])
      setScanDone(false)
      // Small delay so the toast is visible before the scan starts
      setTimeout(() => { void scanForDueLines() }, 1500)
    } catch (err) {
      const msg = decodeVaultError(err)
      if (!msg.includes('cancelled')) toast.error(msg)
    } finally { setReleasing(false) }
  }

  const totalTip = dueLines.reduce((s, l) => s + l.tip, 0n)

  if (!VAULT_DEPLOYED) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          PayrunVault is not deployed on {CHAIN.name}.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="display mb-2 text-2xl font-bold tracking-tight" style={{ color: 'var(--ink)', letterSpacing: '-0.02em' }}>
        Keepers
      </h1>
      <p className="mb-6 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
        Release due payroll lines and earn the tip. Anyone can be a keeper.
      </p>

      {/* Tip hero */}
      {scanDone && dueLines.length > 0 && (
        <div className="mb-4 p-5" style={glass.card}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--subtle)' }}>Available tip</p>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="display text-4xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
              {formatUsdc(totalTip)}
            </span>
            <span className="text-lg font-medium" style={{ color: 'var(--subtle)' }}>USDC</span>
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            {dueLines.length} line{dueLines.length !== 1 ? 's' : ''} ready to release
          </p>
        </div>
      )}

      {/* Scan button */}
      {!scanDone && !results.length && (
        <button
          onClick={() => { void scanForDueLines() }}
          disabled={scanning || countLoading || !runCount}
          className="mb-4 w-full rounded-2xl py-3.5 text-sm font-semibold transition-all hover:scale-[1.01] disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--bg)' }}
        >
          {scanning ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="size-4 animate-spin" /> {scanProgress || 'Scanning…'}
            </span>
          ) : countLoading ? 'Loading…' : `Scan all runs (${runCount?.toString() ?? 0} total)`}
        </button>
      )}

      {/* No-lines result */}
      {scanDone && dueLines.length === 0 && !results.length && (
        <div className="rounded-2xl p-6 text-center" style={glass.card}>
          <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Nothing to release right now</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
            Scanned all {runCount?.toString() ?? 0} run{Number(runCount ?? 0) !== 1 ? 's' : ''} — no pending lines are past their due date yet.
          </p>
          <button
            onClick={() => { setScanDone(false); void scanForDueLines() }}
            className="mt-3 text-xs font-medium transition-opacity hover:opacity-70"
            style={{ color: 'var(--accent)' }}
          >
            Scan again
          </button>
        </div>
      )}

      {/* Due lines list */}
      {dueLines.length > 0 && (
        <>
          <div className="mb-4 flex flex-col gap-2">
            {dueLines.map(l => (
              <div
                key={`${l.runId}-${l.lineIndex}`}
                className="flex items-center justify-between gap-3 rounded-2xl p-4"
                style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium" style={{ color: 'var(--ink)' }}>
                    Run #{l.runId.toString()} · Line {l.lineIndex.toString()}
                  </p>
                  <p className="mono mt-0.5 truncate text-xs" style={{ color: 'var(--muted)' }}>
                    {l.recipient.slice(0, 10)}…{l.recipient.slice(-6)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm tabular-nums font-semibold" style={{ color: 'var(--ink)' }}>
                    {formatUsdc(l.amount)} USDC
                  </p>
                  {l.tip > 0n && (
                    <p className="text-xs tabular-nums" style={{ color: 'var(--success)' }}>
                      +{formatUsdc(l.tip)} tip
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={wrongChain ? () => switchChain({ chainId: TARGET_CHAIN_ID }) : () => { void releaseAll() }}
            disabled={releasing}
            className="w-full rounded-2xl py-3.5 text-sm font-semibold transition-all hover:scale-[1.01] disabled:opacity-40"
            style={{ background: wrongChain ? 'var(--danger)' : 'var(--accent)', color: 'var(--bg)' }}
          >
            {releasing ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="size-4 animate-spin" /> Releasing…
              </span>
            ) : wrongChain ? `Switch to ${CHAIN.name}` : (
              <span className="flex items-center justify-center gap-2">
                <Zap className="size-4" />
                Release all &amp; earn {formatUsdc(totalTip)} USDC
              </span>
            )}
          </button>

          <button
            onClick={() => { setScanDone(false); setDueLines([]); setResults([]) }}
            className="mt-3 w-full rounded-2xl py-2 text-sm font-medium transition-opacity hover:opacity-70"
            style={{ color: 'var(--muted)' }}
          >
            Scan again
          </button>
        </>
      )}

      {/* Release results */}
      {results.length > 0 && (
        <div className="mt-4 flex flex-col gap-3">
          {results.map((r, ri) => (
            <div key={ri} className="rounded-2xl p-4 text-xs" style={{ ...glass.card }}>
              <div className="flex items-center justify-between">
                <span className="font-semibold" style={{ color: 'var(--ink)' }}>
                  Run #{r.runId.toString()} — {r.released} released
                </span>
                <a
                  href={explorerTx(r.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 transition-opacity hover:opacity-70"
                  style={{ color: 'var(--accent)' }}
                >
                  Tx <ExternalLink className="size-3" />
                </a>
              </div>
              {r.skips.length > 0 && (
                <div className="mt-2 space-y-0.5" style={{ color: 'var(--muted)' }}>
                  <p className="font-semibold" style={{ color: 'var(--subtle)' }}>Skipped:</p>
                  {r.skips.map((s, si) => (
                    <p key={si}>Line {s.lineIndex.toString()}: {skipReasonLabel(s.reason)}</p>
                  ))}
                </div>
              )}
            </div>
          ))}
          <button
            onClick={() => { setResults([]); setScanDone(false) }}
            className="w-full rounded-2xl py-2 text-sm font-medium transition-opacity hover:opacity-70"
            style={{ color: 'var(--muted)' }}
          >
            Scan again
          </button>
        </div>
      )}
    </div>
  )
}
