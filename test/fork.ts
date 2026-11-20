import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  concatHex,
  createTestClient,
  erc20Abi,
  http,
  parseAbi,
  keccak256,
  parseEther,
  publicActions,
  toBytes,
  walletActions,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { depositContracts } from '@gatopago/shared/deposits';
import { walletNetworks } from '@gatopago/shared/networks';
import { FORKS, PAYER_KEY, ROUTER_OWNER, SIGNER_KEY, SWEEPER_KEY, forkUrl } from './forks';

/** Cascabel's deposit factory as protocol builds it, next to this repo (DeployDeposits.s.sol). */
const DEPOSIT_FACTORY = new URL(
  '../../protocol/contracts/out/CascabelDepositFactory.sol/CascabelDepositFactory.json',
  import.meta.url,
);
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';

/**
 * Vitest global setup: each fork's router accepts the test signer's authorizations, the payer holds
 * 20 USDC, the sweeper holds gas, and Cascabel's deposit factory is there (deployed from protocol's
 * build while it is not on the networks yet).
 */
export default async function setup() {
  const processes = FORKS.map((fork) =>
    spawn('anvil', ['--fork-url', fork.url, '--port', String(fork.port), '--silent'], {
      stdio: 'ignore',
    }),
  );
  await Promise.all(
    FORKS.map(async (fork) => {
      const network = walletNetworks[fork.id];
      const client = createTestClient({
        chain: network.chain,
        mode: 'anvil',
        transport: http(forkUrl(fork.port)),
      })
        .extend(publicActions)
        .extend(walletActions);
      for (let attempt = 0; ; attempt++) {
        try {
          await client.getChainId();
          break;
        } catch (error) {
          if (attempt > 150) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      const send = async (from: Address, request: object) => {
        await client.impersonateAccount({ address: from });
        await client.setBalance({ address: from, value: parseEther('100') });
        const hash = await client.writeContract({ account: from, ...request } as never);
        await client.waitForTransactionReceipt({ hash });
      };
      await send(ROUTER_OWNER, {
        address: network.paymentRouter,
        abi: parseAbi(['function setSigner(address)']),
        functionName: 'setSigner',
        args: [privateKeyToAccount(SIGNER_KEY).address],
      });
      await send(fork.usdcHolder, {
        address: network.usdc,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [privateKeyToAccount(PAYER_KEY).address, 20_000_000n],
      });
      for (const key of [PAYER_KEY, SWEEPER_KEY] as const) {
        await client.setBalance({
          address: privateKeyToAccount(key).address,
          value: parseEther('10'),
        });
      }
      if (
        !(await client.getCode({ address: depositContracts.factory })) &&
        existsSync(DEPOSIT_FACTORY)
      ) {
        await client.impersonateAccount({ address: ROUTER_OWNER });
        const hash = await client.sendTransaction({
          account: ROUTER_OWNER,
          chain: network.chain,
          to: CREATE2_DEPLOYER,
          data: concatHex([
            keccak256(toBytes('cascabel.deposits.v1')),
            JSON.parse(readFileSync(DEPOSIT_FACTORY, 'utf8')).bytecode.object,
          ]),
        });
        await client.waitForTransactionReceipt({ hash });
      }
    }),
  );
  return () => processes.forEach((process) => process.kill());
}
