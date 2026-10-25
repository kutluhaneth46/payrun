/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { arc, arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

export { arc as arcMainnet }

const chainEnv = (import.meta.env.VITE_CHAIN ?? 'mainnet') as 'testnet' | 'mainnet'
export const activeChain = chainEnv === 'mainnet' ? arc : arcTestnet

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arcTestnet.id, arcTestnet.rpcUrls.default.http[0])
registerChain(arc.id, arc.rpcUrls.default.http[0])

export const config = createConfig({
  chains: [arcTestnet, arc],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(),
    [arc.id]: http(arc.rpcUrls.default.http[0]),
  },
})
