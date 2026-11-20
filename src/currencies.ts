import type { Address } from 'viem';
import { coinDecimals } from '@gatopago/shared/assets';
import type { Config } from './config';

/**
 * A coin an intent is priced in: USDC, paid from any network and received on the home one, or
 * another coin of Flow's networks (AUSD on Monad), paid and received on its own network. Test tokens
 * are not coins to charge in.
 */
export interface Currency {
  readonly symbol: string;
  readonly decimals: number;
  /** The networks it can be paid on, with its contract on each. */
  readonly tokens: ReadonlyMap<string, Address>;
}

export function currency(config: Config, symbol: string): Currency | null {
  const networks = [...config.networks.values()];
  if (symbol === 'USDC') {
    return {
      symbol,
      decimals: 6,
      tokens: new Map(networks.map((network) => [network.id, network.usdc])),
    };
  }
  const tokens = new Map<string, Address>();
  let decimals = 0;
  for (const network of networks) {
    for (const token of network.tokens ?? []) {
      if (token.symbol === symbol && !token.test) {
        tokens.set(network.id, token.address);
        decimals = token.decimals;
      }
    }
  }
  return tokens.size > 0 ? { symbol, decimals, tokens } : null;
}

/** The decimals of `symbol` in GatoPago's catalog: an intent always reads in its own coin. */
export function decimalsOf(symbol: string): number {
  const decimals = coinDecimals(symbol);
  if (decimals === null) {
    throw new Error(`UNKNOWN_CURRENCY: ${symbol}`);
  }
  return decimals;
}
